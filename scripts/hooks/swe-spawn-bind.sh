#!/usr/bin/env bash
# PostToolUse(Agent) — bind a swe spawn's run row to its agent id.
#
# record-swe-spawn.sh opened the spawn's swe agent_runs row with spawn_id
# tool_use:<tool_use_id>. Once CC accepts the spawn, the payload carries the
# same tool_use_id and tool_response.agentId (the agent_id every subagent hook
# of that spawn carries); that row is rebound to spawn_id = agentId, so a
# background spawn (tool_response.status async_launched, returned at once) is
# bound before its first task_brief. A foreground spawn returns at its end,
# after SubagentStop already bound the row: the update then matches nothing.
# A row of the task already keyed by agentId wins: the tool_use row is left
# for task_brief / SubagentStop.
#
# Fail-open: observe-only, it never blocks and a failed write leaves the DB
# unchanged.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)")
[ "$AGENT_TYPE" = "swe" ] || exit 0

FIELDS=$(printf '%s' "$INPUT" | jq -r '[.tool_use_id // "", .tool_response.agentId // ""] | map(tostring) | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\037' read -r TOOL_USE_ID AGENT_ID <<< "$FIELDS"
[ -n "$TOOL_USE_ID" ] && [ -n "$AGENT_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

SAFE_SPAWN_ID=$(tmb_sql_quote "tool_use:${TOOL_USE_ID}")
SAFE_AGENT_ID=$(tmb_sql_quote "$AGENT_ID")

tmb_db_write "$DB" "
UPDATE agent_runs SET spawn_id = '${SAFE_AGENT_ID}'
 WHERE agent_type = 'swe' AND spawn_id = '${SAFE_SPAWN_ID}'
   AND NOT EXISTS (SELECT 1 FROM agent_runs b
                    WHERE b.task_id = agent_runs.task_id AND b.spawn_id = '${SAFE_AGENT_ID}');" >/dev/null 2>&1 || true

exit 0
