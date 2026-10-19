#!/usr/bin/env bash
# PostToolUse hook on task_create_batch. After bro creates tasks, injects
# `additionalContext` reminding bro to spawn every new task's SWE in one
# turn, one Agent call each — the next required step in the planning chain.
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
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/agent-context.sh
. "$SCRIPT_DIR/lib/agent-context.sh"

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

# Each task's worktree is <repos.path>/.claude/worktrees/<slug>, read from the
# trajectory DB (tmb_task_location) — never derived from the cwd.
_DB=$(tmb_db_path 2>/dev/null || true)
TASK_LIST_WITH_PATHS=""
while IFS="$(printf '\t')" read -r _id _branch; do
  if [ -z "$_DB" ]; then
    _wt="unresolved (no trajectory DB)"
  elif tmb_task_location "$_DB" "$_id"; then
    _wt="$TMB_CTX_WORKTREE"
  else
    _wt="unresolved (${TMB_CTX_MISSING})"
  fi
  TASK_LIST_WITH_PATHS="${TASK_LIST_WITH_PATHS:+$TASK_LIST_WITH_PATHS
}  - task_id=${_id} branch_id=${_branch} worktree=${_wt}"
done < <(echo "$RESPONSE_TEXT" | jq -r '.[] | "\(.id)\t\(.branch_id)"' 2>/dev/null)
[ -n "$TASK_LIST_WITH_PATHS" ] || TASK_LIST_WITH_PATHS="$TASK_LIST"

REASON="🚀 SWE-spawn hint: ${TOOL_NAME##*__} created the following tasks. Per tmb_planning Step 4, the next step is to spawn every created task's SWE in one turn — one Agent call each, all in the same message, so independent tasks run concurrently. Production sessions where this step was skipped left tasks stuck at status='pending' forever.

Tasks created:
${TASK_LIST_WITH_PATHS}

For each task, run the two-step proven flow:
1. Pre-create the worktree: \`printf '{\"branch\":\"<branch_id>\"}' | bash \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worktree-create.sh\` — capture the printed path.
2. Spawn SWE (all tasks' Agent calls together in one message): \`Agent(subagent_type='swe', prompt='task_id=<N> worktree=<absolute-worktree-path>')\` — no isolation= parameter.

If you intentionally want to halt before SWE (e.g. user requested review), surface that reason explicitly so future sessions don't see this as a stuck-task bug."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $reason
  }
}'

exit 0
