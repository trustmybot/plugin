#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid tasks row.
# Reads task_id=<N> from the spawn prompt, queries trajectory.db via SQLite.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
source "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" != "swe" ] && exit 0

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)

if [ -z "$TASK_ID" ]; then
  echo '{"decision":"block","reason":"BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through Architect."}'
  exit 0
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  echo '{"decision":"block","reason":"BLOCKED: trajectory.db not found or sqlite3 unavailable. Cannot verify task authorization."}'
  exit 0
fi

ROW=$(tmb_task_spec_status "$TASK_ID")

if [ -z "$ROW" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: task_id=${TASK_ID} does not exist in the tasks table.\"}"
  exit 0
fi

STATUS=$(echo "$ROW" | awk 'NR==1')
BODY_LEN=$(echo "$ROW" | awk 'NR==2')

if [ "$STATUS" != "pending" ] && [ "$STATUS" != "open" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: task_id=${TASK_ID} has status='${STATUS}', expected 'pending' or 'open'.\"}"
  exit 0
fi

if [ "${BODY_LEN:-0}" -eq 0 ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: task_id=${TASK_ID} has empty spec_body_md. Architect must set spec body before SWE can execute.\"}"
  exit 0
fi

exit 0
