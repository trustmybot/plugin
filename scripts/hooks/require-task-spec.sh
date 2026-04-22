#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid
# docs/trustmybot/tasks/*.{xml,md} task spec.
set -euo pipefail

INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" != "swe" ] && exit 0

TASK_FILE=$(echo "$PROMPT" \
  | grep -oE 'docs/trustmybot/tasks/[a-zA-Z0-9_.-]+\.(xml|md)' \
  | head -1 || true)

if [ -z "$TASK_FILE" ]; then
  echo '{"decision":"block","reason":"BLOCKED: SWE requires a task spec at docs/trustmybot/tasks/*.{xml,md}. None found in prompt. Route through Architect to create a spec first."}'
  exit 0
fi

if [ ! -f "$TASK_FILE" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task spec $TASK_FILE does not exist. Architect must create it first.\"}"
  exit 0
fi

case "$TASK_FILE" in
  *.xml)
    if ! grep -q '<authorized-by' "$TASK_FILE" 2>/dev/null; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE missing <authorized-by> tag.\"}"
      exit 0
    fi
    if ! grep -q 'status="open"' "$TASK_FILE" 2>/dev/null; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE status is not open.\"}"
      exit 0
    fi
    ;;
  *.md)
    if ! grep -q '^authorized_by:' "$TASK_FILE" 2>/dev/null; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE frontmatter missing authorized_by.\"}"
      exit 0
    fi
    if ! grep -qE '^status:\s*(pending|open)' "$TASK_FILE" 2>/dev/null; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE status is not pending or open.\"}"
      exit 0
    fi
    ;;
esac

exit 0
