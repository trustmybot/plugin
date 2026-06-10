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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

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
# Patterns tolerate intermediate words (e.g. "make THIS PROJECT available
# on github" matches "available on github").
matched=""
for pat in \
  'available on github' 'available on gitlab' 'available on a remote' \
  'host on github' 'host on gitlab' 'host it on github' 'host it on gitlab' \
  'push to github' 'push to gitlab' 'put this on github' 'put this on gitlab' \
  'put it on github' 'put it on gitlab' 'publish to github' 'publish to gitlab' \
  'switch to remote' 'go remote' 'add a remote' 'set up a remote' \
  'set up the remote' 'add github remote' 'add gitlab remote' \
  'live on a remote' 'live on github' 'live on gitlab' \
  'lives on a remote' 'lives on github' 'lives on gitlab' \
  'needs to live on' 'needs a remote' \
  'change my issue tracker' 'switch issue tracker'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

# Only inject the hint if the project is already onboarded (identity row
# exists). If not, the cold-start onboard chain will handle it.
ONBOARDED=$(sqlite3 "$DB_PATH" "SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true' LIMIT 1;" 2>/dev/null || true)
[ "$ONBOARDED" = "1" ] || exit 0

REASON="🔁 reonboard-intent hint: the user's prompt contains '${matched}'. This signals a *reonboard* (the project is already onboarded — switching shape, not initial onboard).

Required workflow (one turn, no questions):
1. Call \`onboard_state_get\` to read the current config (branching_model, pr_target, remotes).
2. Either path is acceptable — pick one:
   - **Auto-apply** via \`onboard_apply(shape='remote', remote=[...], ...)\` with conservative defaults matching the user's intent (e.g. 'gitlab' / 'github').
   - **Recommend** the user type \`/onboard\` verbatim in your text response, so they can drive the interactive ceremony themselves.
3. Do NOT spawn code work (no \`task_create_batch\`, no \`issue_create\`, no \`Agent\` for SWE). Reonboard is config-only.

The Human prefers either of those two paths. Don't get stuck chasing external CLIs (gh/glab repo create) before TMB's plugin_config is settled."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
