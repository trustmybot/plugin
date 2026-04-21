#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid bro/tasks/*.xml file.
set -euo pipefail

INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

# Only gate SWE agents
[ "$AGENT_TYPE" != "swe" ] && exit 0

# Check for a task XML path in the prompt
TASK_FILE=$(echo "$PROMPT" | grep -oE 'bro/tasks/[a-zA-Z0-9_.-]+\.xml' | head -1 || true)

if [ -z "$TASK_FILE" ]; then
  echo '{"decision":"block","reason":"BLOCKED: SWE requires a task XML file. No bro/tasks/*.xml path found in prompt. Route through Architect to create a task file first."}'
  exit 0
fi

# Check the file exists
if [ ! -f "$TASK_FILE" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task file $TASK_FILE does not exist. Architect must create it first.\"}"
  exit 0
fi

# Check for authorized-by tag
if ! grep -q '<authorized-by' "$TASK_FILE" 2>/dev/null; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task file $TASK_FILE missing <authorized-by> tag.\"}"
  exit 0
fi

# Check status is "open"
if ! grep -q 'status="open"' "$TASK_FILE" 2>/dev/null; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task file $TASK_FILE status is not open. Only open tasks can be executed.\"}"
  exit 0
fi

exit 0
