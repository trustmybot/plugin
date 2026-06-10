#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid tasks row.
# Reads task_id=<N> from the spawn prompt, queries trajectory.db via SQLite.
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

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)

if [ -z "$TASK_ID" ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",denyReason:"BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through bro (bro plans, then spawns SWE with task_id)."}}'
  exit 0
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",denyReason:"BLOCKED: trajectory.db not found or sqlite3 unavailable. Cannot verify task authorization."}}'
  exit 0
fi

ROW=$(tmb_task_spec_status "$TASK_ID" "$DB")

if [ -z "$ROW" ]; then
  # Empty row can mean DB busy (SQLITE_BUSY) or row genuinely missing.
  # Re-query without -readonly to check whether it's a locking issue.
  PROBE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE id=${TASK_ID};" 2>/dev/null || echo "query_failed")
  if [ "$PROBE" = "query_failed" ]; then
    jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: DB query failed for task_id="+$id+" (DB busy?). Retry the spawn once the DB lock clears.")}}'
  else
    jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: task_id="+$id+" does not exist in the tasks table.")}}'
  fi
  exit 0
fi

STATUS=$(echo "$ROW" | awk 'NR==1')
BODY_LEN=$(echo "$ROW" | awk 'NR==2')

if [ "$STATUS" != "pending" ] && [ "$STATUS" != "open" ]; then
  jq -nc --arg id "$TASK_ID" --arg st "$STATUS" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: task_id="+$id+" has status="+$st+", expected pending or open.")}}'
  exit 0
fi

if [ "${BODY_LEN:-0}" -eq 0 ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: task_id="+$id+" has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.")}}'
  exit 0
fi

exit 0
