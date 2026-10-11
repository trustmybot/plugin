#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid tasks row.
# Reads task_id=<N> from the spawn prompt, queries the trajectory DB via SQLite.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat)

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')")
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" != "swe" ] && exit 0

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id[=:][[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true)

if [ -z "$TASK_ID" ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through bro (bro plans, then spawns SWE with task_id)."}}'
  exit 0
fi

DB=$(tmb_db_path) || exit 0
tmb_have_sqlite || exit 0

SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
ROW=$(tmb_gate_read "$DB" "SELECT status, LENGTH(COALESCE(spec_body, '')) FROM tasks WHERE id = ${SAFE_TASK_ID};")

if [ "$ROW" = "__ERR__" ]; then
  tmb_deny_db_unavailable require-task-spec
  exit 0
fi

if [ -z "$ROW" ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" does not exist in the tasks table.")}}'
  exit 0
fi

ROW=$(printf '%s' "$ROW" | tr '|' '\n')
STATUS=$(echo "$ROW" | awk 'NR==1')
BODY_LEN=$(echo "$ROW" | awk 'NR==2')

if [ "$STATUS" != "pending" ] && [ "$STATUS" != "open" ]; then
  jq -nc --arg id "$TASK_ID" --arg st "$STATUS" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has status="+$st+", expected pending or open.")}}'
  exit 0
fi

if [ "${BODY_LEN:-0}" -eq 0 ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.")}}'
  exit 0
fi

exit 0
