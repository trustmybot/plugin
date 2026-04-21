#!/usr/bin/env bash
# Hook: Block git push/merge unless all task files have PR Reviewer sign-off.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only gate push and merge commands
case "$CMD" in
  *"git push"*|*"gh pr merge"*) ;;
  *) exit 0 ;;
esac

# Must have a bro/tasks dir for the check to apply
[ -d "bro/tasks" ] || exit 0

# Find all task XML files missing <reviewed-by> (excluding deferred)
UNSIGNED=""
for f in bro/tasks/*.xml; do
  [ -f "$f" ] || continue
  # Skip deferred tasks
  if grep -q 'status="deferred"' "$f" 2>/dev/null; then
    continue
  fi
  # Skip open tasks (not yet completed)
  if grep -q 'status="open"' "$f" 2>/dev/null; then
    continue
  fi
  # Check: has authorized-by but missing reviewed-by
  if grep -q '<authorized-by' "$f" 2>/dev/null && ! grep -q '<reviewed-by\|<closed-by' "$f" 2>/dev/null; then
    UNSIGNED="$UNSIGNED $f"
  fi
done

if [ -n "$UNSIGNED" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Push/merge requires PR Reviewer sign-off. These task files are missing <reviewed-by> or <closed-by>:$UNSIGNED. Spawn PR Reviewer to sign them.\"}"
  exit 0
fi

exit 0
