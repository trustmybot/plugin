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
#
# Deadline (GH 1821): the analysis runs in its own process group and is killed
# after TMB_REMOTE_ID_GUARD_DEADLINE_S seconds (default 3, half the hooks.json
# 6 s timeout, whose onFailure "block" would otherwise deny). On overrun the
# guard allows, prints one stderr line and writes one remote_id_guard_overrun
# audit row on the system issue -1 (fail-soft: no DB or a failed write still
# allows).

[ "${TMB_DISABLE_REMOTE_ID_GUARD:-}" = "1" ] && exit 0

# One overrun audit write; deadline + write budget stay inside the 6 s wrapper.
export TMB_DB_WRITE_RUN_BUDGET_MS=1000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

command -v jq >/dev/null 2>&1 || { echo "remote-id-guard: jq not found" >&2; exit 1; }

DEADLINE_S="${TMB_REMOTE_ID_GUARD_DEADLINE_S:-3}"
if ! [[ "$DEADLINE_S" =~ ^(0|[1-9][0-9]*)(\.[0-9]+)?$ ]] || ! [[ "$DEADLINE_S" =~ [1-9] ]]; then
  DEADLINE_S=3
fi

INPUT=$(cat)

remote_id_analysis() {
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  [ -n "$CMD" ] || exit 0

  # Is this a remote-WRITE command? (git/gh/glab parity)
  #   gh pr create|edit · gh issue create|edit|comment|close
  #   glab mr create|update · glab issue create|update|note|close
  # Capture the command's PROVIDER alongside the match — the iid to cite depends
  # on which forge the command targets (gh → gh_iid, glab → gl_iid). The command
  # must be an executable statement of the skeleton (lib/cmd-analysis.sh): one
  # named inside quoted text or a heredoc is data.
  REMOTE_WRITE=0
  PROVIDER=""
  while IFS="$(printf '\t')" read -r _dir stmt; do
    case "$stmt" in
      "gh pr create"|"gh pr create "*|"gh pr edit"|"gh pr edit "*|"gh issue create"|"gh issue create "*|"gh issue edit"|"gh issue edit "*|"gh issue comment"|"gh issue comment "*|"gh issue close"|"gh issue close "*)
        REMOTE_WRITE=1; PROVIDER="gh"; break ;;
      "glab mr create"|"glab mr create "*|"glab mr update"|"glab mr update "*|"glab issue create"|"glab issue create "*|"glab issue update"|"glab issue update "*|"glab issue note"|"glab issue note "*|"glab issue close"|"glab issue close "*)
        REMOTE_WRITE=1; PROVIDER="glab"; break ;;
    esac
  done < <(tmb_cmd_statements "$CMD" /)
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
  # Explicit remote markers (owner/repo#<n>, GH-<n>, GL-<n>, remote:<n>) already
  # assert a remote id, so they are stripped from the scanned copy first.
  SCAN_TEXT=$(printf '%s' "$CMD" | sed -E \
    -e 's|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+| |g' \
    -e 's/[Gg][Hh]-[0-9]+/ /g' \
    -e 's/[Gg][Ll]-[0-9]+/ /g' \
    -e 's/[Rr][Ee][Mm][Oo][Tt][Ee]:[0-9]+/ /g')
  TOKENS=$(printf '%s' "$SCAN_TEXT" | grep -oE '#[0-9]+' | sed 's/#//' | sort -u)
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
      SELECT COALESCE(gh_iid, ''), COALESCE(gl_iid, ''), COALESCE(objective, '')
        FROM issues WHERE id = ${safe_n};
    ")
    # No row → <n> is not a local id → real remote ref → leave alone.
    [ -n "$ROW" ] || continue
    GH=$(printf '%s' "$ROW" | cut -d'|' -f1)
    GL=$(printf '%s' "$ROW" | cut -d'|' -f2)
    OBJECTIVE=$(printf '%s' "$ROW" | cut -d'|' -f3-)
    # Pick the iid by the command's PROVIDER: a glab command resolves to the
    # GitLab iid, a gh command to the GitHub iid. Fall back to the other forge's
    # iid only when the command's own provider has none recorded.
    if [ "$PROVIDER" = "glab" ]; then
      if [ -n "$GL" ] && [ "$GL" != "$safe_n" ]; then
        OFFENSES="${OFFENSES}#${safe_n} → #${GL} (GitLab)  local #${safe_n}: \"${OBJECTIVE}\"\n"
      elif [ -z "$GL" ] && [ -n "$GH" ] && [ "$GH" != "$safe_n" ]; then
        OFFENSES="${OFFENSES}#${safe_n} → #${GH} (GitHub)  local #${safe_n}: \"${OBJECTIVE}\"\n"
      fi
    else
      if [ -n "$GH" ] && [ "$GH" != "$safe_n" ]; then
        OFFENSES="${OFFENSES}#${safe_n} → #${GH} (GitHub)  local #${safe_n}: \"${OBJECTIVE}\"\n"
      elif [ -z "$GH" ] && [ -n "$GL" ] && [ "$GL" != "$safe_n" ]; then
        OFFENSES="${OFFENSES}#${safe_n} → #${GL} (GitLab)  local #${safe_n}: \"${OBJECTIVE}\"\n"
      fi
    fi
  done <<< "$TOKENS"

  [ -n "$OFFENSES" ] || exit 0

  REASON="BLOCKED: this remote-bound text cites LOCAL trajectory issue id(s) that resolve to a DIFFERENT issue on the remote. Re-issue with the remote iid:
$(printf '%b' "$OFFENSES")
A bare #N in a PR body / gh issue comment resolves to remote issue N, not the local one. Use the remote id shown above. To cite a number that is already a remote id, write it as GH-<n>, remote:<n> or <owner>/<repo>#<n>. (Bypass: TMB_DISABLE_REMOTE_ID_GUARD=1.)"

  jq -nc --arg reason "$REASON" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
}

# Runs remote_id_analysis in its own process group (set -m) beside a watchdog
# that kills the whole group at the deadline, so no child outlives it. Prints
# the analysis's stdout when it finished in time; returns 124 on overrun.
remote_id_bounded() {
  local job watchdog rc
  set -m
  remote_id_analysis &
  job=$!
  ( sleep "$DEADLINE_S"; kill -KILL -- -"$job" ) >/dev/null 2>&1 &
  watchdog=$!
  set +m
  exec 2>/dev/null
  wait "$job"
  rc=$?
  kill -KILL -- -"$watchdog"
  wait "$watchdog"
  [ "$rc" -eq 137 ] && return 124
  return 0
}

remote_id_audit_overrun() {
  local db content
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] && [ -f "$db" ] || return 0
  tmb_have_sqlite || return 0
  content=$(jq -nc --argjson d "$DEADLINE_S" --argjson e "$1" '{deadline_s: $d, elapsed_s: $e}') || return 0
  tmb_audit_append "$db" -1 '' "hook:remote-id-guard" "remote_id_guard_overrun" \
    "remote-id-guard allowed a Bash command: its analysis passed the ${DEADLINE_S}s deadline" "$content" \
    2>/dev/null || return 0
}

START_MS=$(_tmb_now_ms)
OUT=$(remote_id_bounded)
if [ "$?" -eq 124 ]; then
  ELAPSED_S=$(awk -v a="$START_MS" -v b="$(_tmb_now_ms)" 'BEGIN { printf "%.3f", (b - a) / 1000 }')
  echo "remote-id-guard: analysis passed its ${DEADLINE_S}s deadline (TMB_REMOTE_ID_GUARD_DEADLINE_S) after ${ELAPSED_S}s; allowing" >&2
  remote_id_audit_overrun "$ELAPSED_S"
  exit 0
fi
[ -z "$OUT" ] || printf '%s\n' "$OUT"
