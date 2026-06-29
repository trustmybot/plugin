#!/usr/bin/env bash
# PreToolUse hook — deny remote-bound text that cites a LOCAL trajectory issue
# id instead of its REMOTE iid.
#
# bro writes LOCAL issue ids into REMOTE artifacts (PR bodies, gh issue close
# comments). On the remote a bare `#N` resolves to the unrelated remote issue N.
# This guard catches that: it scans author-supplied text on remote-write
# commands for `#<n>` tokens, and denies when `<n>` is a local issue id whose
# `gh_iid` (or `gl_iid`) differs — naming the correct remote ref.
#
# Acts ONLY on remote-WRITE commands carrying author text:
#   gh   pr    create|edit
#   gh   issue create|edit|comment|close
#   glab mr    create|update
#   glab issue create|update|note|close
# and only when the command carries --body/--title/--comment/-b/-t/-m or a
# heredoc body. Plain reads (gh pr list, gh issue view) → no-op.
#
# Fail-OPEN (allow) on any error: missing DB/sqlite/issues-table, no offending
# token, or a `#<n>` that is not a local id (a real remote ref). Bypass:
# TMB_DISABLE_REMOTE_ID_GUARD=1.

[ "${TMB_DISABLE_REMOTE_ID_GUARD:-}" = "1" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -n "$CMD" ] || exit 0

# Is this a remote-WRITE command? (git/gh/glab parity)
#   gh pr create|edit · gh issue create|edit|comment|close
#   glab mr create|update · glab issue create|update|note|close
# Capture the command's PROVIDER alongside the match — the iid to cite depends
# on which forge the command targets (gh → gh_iid, glab → gl_iid).
REMOTE_WRITE=0
PROVIDER=""
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])gh[[:space:]]+pr[[:space:]]+(create|edit)([[:space:]]|$)'; then
  REMOTE_WRITE=1; PROVIDER="gh"
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])gh[[:space:]]+issue[[:space:]]+(create|edit|comment|close)([[:space:]]|$)'; then
  REMOTE_WRITE=1; PROVIDER="gh"
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])glab[[:space:]]+mr[[:space:]]+(create|update)([[:space:]]|$)'; then
  REMOTE_WRITE=1; PROVIDER="glab"
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])glab[[:space:]]+issue[[:space:]]+(create|update|note|close)([[:space:]]|$)'; then
  REMOTE_WRITE=1; PROVIDER="glab"
fi
[ "$REMOTE_WRITE" = "1" ] || exit 0

# Does the command carry author-supplied text? Only then is a mis-citation
# possible. Flag long/short body/title/comment options, or a heredoc body.
CARRIES_TEXT=0
if printf '%s' "$CMD" | grep -qE '(--body|--title|--comment|--message|--description|--note)([[:space:]=]|$)'; then
  CARRIES_TEXT=1
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:]])-[btm]([[:space:]]|$)'; then
  CARRIES_TEXT=1
elif printf '%s' "$CMD" | grep -qE '<<-?[[:space:]]*[A-Za-z_'"'"'"]'; then
  CARRIES_TEXT=1
fi
[ "$CARRIES_TEXT" = "1" ] || exit 0

# Extract candidate #<n> tokens from the command text. Over-broad is fine: a
# non-local <n> is left alone below, so scanning the whole command is safe.
TOKENS=$(printf '%s' "$CMD" | grep -oE '#[0-9]+' | sed 's/#//' | sort -u)
[ -n "$TOKENS" ] || exit 0

# Resolve DB — fail-open on any resolution failure.
DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0

# issues table must exist — else fail-open.
HAS_ISSUES=$(tmb_sqlite_ro "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='issues';")
[ "$HAS_ISSUES" = "issues" ] || exit 0

OFFENSES=""
while IFS= read -r n; do
  [ -n "$n" ] || continue
  safe_n=$(tmb_sql_int "$n")
  [ -n "$safe_n" ] || continue
  # Local id → its remote iids.
  ROW=$(tmb_sqlite_ro "$DB" "
    SELECT COALESCE(gh_iid, ''), COALESCE(gl_iid, '')
      FROM issues WHERE id = ${safe_n};
  ")
  # No row → <n> is not a local id → real remote ref → leave alone.
  [ -n "$ROW" ] || continue
  GH=$(printf '%s' "$ROW" | cut -d'|' -f1)
  GL=$(printf '%s' "$ROW" | cut -d'|' -f2)
  # Pick the iid by the command's PROVIDER: a glab command resolves to the
  # GitLab iid, a gh command to the GitHub iid. Fall back to the other forge's
  # iid only when the command's own provider has none recorded.
  if [ "$PROVIDER" = "glab" ]; then
    if [ -n "$GL" ] && [ "$GL" != "$safe_n" ]; then
      OFFENSES="${OFFENSES}#${safe_n} → #${GL} (GitLab)\n"
    elif [ -z "$GL" ] && [ -n "$GH" ] && [ "$GH" != "$safe_n" ]; then
      OFFENSES="${OFFENSES}#${safe_n} → #${GH} (GitHub)\n"
    fi
  else
    if [ -n "$GH" ] && [ "$GH" != "$safe_n" ]; then
      OFFENSES="${OFFENSES}#${safe_n} → #${GH} (GitHub)\n"
    elif [ -z "$GH" ] && [ -n "$GL" ] && [ "$GL" != "$safe_n" ]; then
      OFFENSES="${OFFENSES}#${safe_n} → #${GL} (GitLab)\n"
    fi
  fi
done <<< "$TOKENS"

[ -n "$OFFENSES" ] || exit 0

REASON="BLOCKED: this remote-bound text cites LOCAL trajectory issue id(s) that resolve to a DIFFERENT issue on the remote. Re-issue with the remote iid:
$(printf '%b' "$OFFENSES")
A bare #N in a PR body / gh issue comment resolves to remote issue N, not the local one. Use the remote id shown above. (Bypass: TMB_DISABLE_REMOTE_ID_GUARD=1.)"

jq -nc --arg reason "$REASON" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$reason}}'
