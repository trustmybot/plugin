#!/usr/bin/env bash
# UserPromptSubmit hook. When the user's prompt expresses *reonboard
# intent* ("make available on GitHub", "host on GitLab", "switch to
# remote", "go remote"), check current onboard state and inject context
# so bro CHECKS state first (via onboard_state_get) and asks whether to
# fire /onboard — rather than silently auto-rewriting plugin_config.
#
# Captures L5/L6 row 2 — bro silently ignoring reonboard signals from
# casual natural-language prompts.
#
# Skip if the user already typed /onboard — the slash command handles
# the explicit case; this hint is only for vague intent.
#
# Bypass: TMB_DISABLE_REONBOARD_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_REONBOARD_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

# If the user already typed /onboard, the explicit slash handles it.
case "$PROMPT" in
  */onboard*) exit 0 ;;
esac

# Pattern detection — reonboard intent. Precision over recall.
matched=""
for pat in \
  'make available on github' 'make available on gitlab' 'host on github' \
  'host on gitlab' 'push to github' 'push to gitlab' 'put this on github' \
  'put this on gitlab' 'put it on github' 'put it on gitlab' \
  'switch to remote' 'go remote' 'add a remote' 'set up a remote' \
  'add github remote' 'add gitlab remote' 'change my issue tracker' \
  'switch issue tracker'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then DB_PATH="$candidate"; break; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$DB_PATH" ] && DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi
[ -f "$DB_PATH" ] || exit 0

# Only inject the hint if the project is already onboarded (identity row
# exists). If not, the cold-start onboard chain will handle it.
ONBOARDED=$(sqlite3 "$DB_PATH" "SELECT 1 FROM identity LIMIT 1;" 2>/dev/null || true)
[ "$ONBOARDED" = "1" ] || exit 0

REASON="🔁 reonboard-intent hint: the user's prompt contains '${matched}'. This signals a *reonboard* (the project is already onboarded — switching shape, not initial onboard).

Required workflow:
1. Call \`onboard_state_get\` to read the current config (branching_model, pr_target, remotes).
2. ASK the Human whether to run \`/onboard\` again to walk through the new shape — do NOT call \`onboard_apply\` or rewrite plugin_config silently.
3. If they confirm, recommend they type \`/onboard\` so the interactive ceremony runs cleanly.

The Human types \`/onboard\` directly when they're ready; bro never auto-applies reonboard changes from a casual prompt."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
