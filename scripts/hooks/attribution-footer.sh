#!/usr/bin/env bash
# PostToolUse hook on Bash — normalizes the TMB attribution footer on PR/issue/MR
# bodies after a successful create command (#601).
#
# After `gh pr create` / `gh issue create` / `glab mr create` / `glab issue create`
# succeeds, the artifact's URL/number is parsed from the tool response, the current
# body is fetched, and the body is rewritten to carry exactly the TMB footer:
#   - any bare "🤖 Generated with [Claude Code]…" line lacking "powered by Bro"
#     is stripped,
#   - the TMB footer is appended if absent (idempotent).
# The writeback uses `edit`/`update` (never `create`), so it can't re-trigger.
#
# Bodies only — never commits (amend would change SHAs and break atomic-close
# tracking). Best-effort throughout: any missing tool, auth failure, or absent
# URL makes the hook a silent no-op (exit 0).
#
# The `normalize_footer` function is pure and side-effect-free so tests can source
# this file and exercise it directly without network.

TMB_FOOTER='🤖 Generated with [Claude Code](https://claude.com/claude-code), powered by [Bro](https://github.com/trustmybot/plugin)'

# normalize_footer — read body on stdin, write normalized body to stdout.
# Pure: strips bare Claude-Code footer lines, ensures exactly the TMB footer.
normalize_footer() {
  local body stripped
  body=$(cat)

  # Drop any line carrying the Claude Code footer marker that is NOT the TMB
  # footer (i.e. lacks "powered by Bro"). The TMB footer survives this pass.
  stripped=$(printf '%s' "$body" | awk '
    /🤖 Generated with \[Claude Code\]/ && $0 !~ /powered by Bro/ { next }
    { print }
  ')

  # Already carries the exact TMB footer → idempotent, return as-is.
  if printf '%s' "$stripped" | grep -qF -- "$TMB_FOOTER"; then
    printf '%s' "$stripped"
    return 0
  fi

  # Trim trailing blank lines, then append a blank line + the TMB footer.
  stripped=$(printf '%s' "$stripped" | awk '
    { lines[NR] = $0 }
    END {
      last = NR
      while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
      for (i = 1; i <= last; i++) print lines[i]
    }
  ')

  if [ -n "$stripped" ]; then
    printf '%s\n\n%s' "$stripped" "$TMB_FOOTER"
  else
    printf '%s' "$TMB_FOOTER"
  fi
}

# When sourced (e.g. by the test), expose normalize_footer and stop here.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0 2>/dev/null || true
fi

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
RESP=$(printf '%s' "$INPUT" | jq -r '.tool_response | if type == "string" then . else tojson end' 2>/dev/null)
[ -n "$CMD" ] || exit 0

# Classify the creation command at a word boundary and extract the created
# number from a URL in the tool response. KIND is one of: gh-pr gh-issue
# glab-mr glab-issue. NUMBER is the parsed artifact number.
KIND=""
NUMBER=""
if printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]_-])gh[[:space:]]+pr[[:space:]]+create([^[:alnum:]_-]|$)'; then
  KIND="gh-pr"
  NUMBER=$(printf '%s' "$RESP" | grep -oE 'https://[^[:space:]"]+/pull/[0-9]+' | grep -oE '[0-9]+$' | head -n1)
elif printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]_-])gh[[:space:]]+issue[[:space:]]+create([^[:alnum:]_-]|$)'; then
  KIND="gh-issue"
  NUMBER=$(printf '%s' "$RESP" | grep -oE 'https://[^[:space:]"]+/issues/[0-9]+' | grep -oE '[0-9]+$' | head -n1)
elif printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]_-])glab[[:space:]]+mr[[:space:]]+create([^[:alnum:]_-]|$)'; then
  KIND="glab-mr"
  NUMBER=$(printf '%s' "$RESP" | grep -oE 'https://[^[:space:]"]+/-/merge_requests/[0-9]+' | grep -oE '[0-9]+$' | head -n1)
elif printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]_-])glab[[:space:]]+issue[[:space:]]+create([^[:alnum:]_-]|$)'; then
  KIND="glab-issue"
  NUMBER=$(printf '%s' "$RESP" | grep -oE 'https://[^[:space:]"]+/-/issues/[0-9]+' | grep -oE '[0-9]+$' | head -n1)
fi

[ -n "$KIND" ] || exit 0
[ -n "$NUMBER" ] || exit 0

# Fetch current body (best-effort). Resolve the binary; missing → no-op.
ORIG=""
case "$KIND" in
  gh-pr)
    command -v gh >/dev/null 2>&1 || exit 0
    ORIG=$(gh pr view "$NUMBER" --json body -q .body 2>/dev/null) || exit 0
    ;;
  gh-issue)
    command -v gh >/dev/null 2>&1 || exit 0
    ORIG=$(gh issue view "$NUMBER" --json body -q .body 2>/dev/null) || exit 0
    ;;
  glab-mr)
    command -v glab >/dev/null 2>&1 || exit 0
    # Read the RAW description via -F json (#1034). The plain `glab mr view`
    # renders a decorated table (title/labels/etc.) — feeding that back into
    # --description clobbered the real body with rendered chrome.
    ORIG=$(glab mr view "$NUMBER" -F json 2>/dev/null | jq -r '.description // ""') || exit 0
    ;;
  glab-issue)
    command -v glab >/dev/null 2>&1 || exit 0
    ORIG=$(glab issue view "$NUMBER" -F json 2>/dev/null | jq -r '.description // ""') || exit 0
    ;;
esac

NEW=$(printf '%s' "$ORIG" | normalize_footer)

# No change → no write.
[ "$NEW" = "$ORIG" ] && exit 0

case "$KIND" in
  gh-pr)      gh pr edit "$NUMBER" --body "$NEW" >/dev/null 2>&1 || true ;;
  gh-issue)   gh issue edit "$NUMBER" --body "$NEW" >/dev/null 2>&1 || true ;;
  glab-mr)    glab mr update "$NUMBER" --description "$NEW" >/dev/null 2>&1 || true ;;
  glab-issue) glab issue update "$NUMBER" --description "$NEW" >/dev/null 2>&1 || true ;;
esac

exit 0
