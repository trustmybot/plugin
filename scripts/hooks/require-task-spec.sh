#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid tasks row.
# Reads task_id=<N> from the spawn prompt, queries the trajectory DB via SQLite.
# A spawn is allowed on a pending task, or on a running task with no open swe
# agent_runs row (rework after task_reopen); a running task whose swe run is
# still open is denied with that run named.
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

LIVE_RUN=""
if [ "$STATUS" = "running" ]; then
  LIVE_RUN=$(tmb_gate_read "$DB" "SELECT id || ' (started ' || COALESCE(started_at, '?') || ')' FROM agent_runs
    WHERE task_id = ${SAFE_TASK_ID} AND agent_type = 'swe' AND completed_at IS NULL ORDER BY id DESC LIMIT 1;")
  if [ "$LIVE_RUN" = "__ERR__" ]; then
    tmb_deny_db_unavailable require-task-spec
    exit 0
  fi
fi

if [ -n "$LIVE_RUN" ]; then
  jq -nc --arg id "$TASK_ID" --arg run "$LIVE_RUN" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" is running with a live swe run: agent_runs "+$run+". Wait for that swe to return; if it is gone, move the task to failed (task_update_status) and task_reopen it.")}}'
  exit 0
fi

if [ "$STATUS" != "pending" ] && [ "$STATUS" != "running" ]; then
  jq -nc --arg id "$TASK_ID" --arg st "$STATUS" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has status="+$st+", expected pending, or running with no live swe run. Reopen finished work with task_reopen.")}}'
  exit 0
fi

if [ "${BODY_LEN:-0}" -eq 0 ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.")}}'
  exit 0
fi

exit 0
