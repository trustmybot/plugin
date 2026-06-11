#!/usr/bin/env bash
# PostToolUse hook on task_create_batch. After bro creates tasks, injects
# `additionalContext` reminding bro to spawn SWE via the Agent tool for
# each new task — the next required step in the planning chain.
#
# Captures L6 scenario 14: production showed tasks stuck at `pending`
# because bro called task_create_batch then stopped without dispatching
# SWE. The hook is a hint — not a block — because the user might
# legitimately want to review the spec before spawning SWE.
#
# Bypass: TMB_DISABLE_SPAWN_HINT=1.
# Always silent on failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_SPAWN_HINT:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  mcp__*trajectory-server__task_create_batch) ;;
  *) exit 0 ;;
esac

# Don't fire if the call returned an error (gate violation, etc.).
RESPONSE_ERROR=$(echo "$INPUT" | jq -r '.tool_response.is_error // false' 2>/dev/null)
[ "$RESPONSE_ERROR" = "true" ] && exit 0

# Pull the task list from the response. The handler returns an array of
# created task rows; the response shape is .tool_response.content[0].text
# which is a JSON-encoded string of the array.
RESPONSE_TEXT=$(echo "$INPUT" | jq -r '.tool_response.content[0].text // ""' 2>/dev/null)
[ -n "$RESPONSE_TEXT" ] || exit 0

# Parse the task list. Skip if the response wasn't an array (e.g. error).
TASK_LIST=$(echo "$RESPONSE_TEXT" | jq -r 'if type == "array" then map("  - task_id=\(.id) branch_id=\(.branch_id)") | join("\n") else "" end' 2>/dev/null)
[ -n "$TASK_LIST" ] || exit 0

# Resolve workspace_root from the trajectory DB path: DB lives at
# <workspace_root>/.claude/<plugin>/trajectory.db, so dirname 3 times.
WORKSPACE_ROOT=""
_DB=$(tmb_db_path 2>/dev/null || true)
if [ -n "$_DB" ]; then
  WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$_DB")")")"
fi

# Build per-task worktree path entries. For each task, slug = branch_id
# minus its type/ prefix (e.g. feat/my-feature → my-feature).
TASK_LIST_WITH_PATHS=$(echo "$RESPONSE_TEXT" | jq -r --arg ws "$WORKSPACE_ROOT" '
  if type == "array" then
    map(
      . as $t |
      ($t.branch_id | ltrimstr("feat/") | ltrimstr("fix/") | ltrimstr("chore/") | ltrimstr("docs/") | ltrimstr("test/") | ltrimstr("refactor/")) as $slug |
      (if $ws != "" then $ws + "/.claude/worktrees/" + $slug else ".claude/worktrees/" + $slug end) as $wt |
      "  - task_id=\($t.id) branch_id=\($t.branch_id) worktree=\($wt)"
    ) | join("\n")
  else "" end
' 2>/dev/null)
[ -n "$TASK_LIST_WITH_PATHS" ] || TASK_LIST_WITH_PATHS="$TASK_LIST"

REASON="🚀 SWE-spawn hint: ${TOOL_NAME##*__} created the following tasks. Per tmb_planning Step 4, the next step is to spawn SWE via the Agent tool for each task — production sessions where this step was skipped left tasks stuck at status='pending' forever.

Tasks created:
${TASK_LIST_WITH_PATHS}

For each task, run the two-step proven flow:
1. Pre-create the worktree: \`printf '{\"branch\":\"<branch_id>\"}' | bash \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worktree-create.sh\` — capture the printed path.
2. Spawn SWE: \`Agent(subagent_type='swe', prompt='task_id=<N> worktree=<absolute-worktree-path>')\` — no isolation= parameter.

If you intentionally want to halt before SWE (e.g. user requested review), surface that reason explicitly so future sessions don't see this as a stuck-task bug."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $reason
  }
}'

exit 0
