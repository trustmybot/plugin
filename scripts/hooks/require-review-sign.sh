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

# Must have a docs/trustmybot/tasks dir for the check to apply
[ -d "docs/trustmybot/tasks" ] || exit 0

# Find all task files missing sign-off (excluding deferred/open)
UNSIGNED=""
for f in docs/trustmybot/tasks/*.xml docs/trustmybot/tasks/*.md; do
  [ -f "$f" ] || continue
  case "$f" in
    *.xml)
      if grep -q 'status="deferred"' "$f" 2>/dev/null; then
        continue
      fi
      if grep -q 'status="open"' "$f" 2>/dev/null; then
        continue
      fi
      if grep -q '<authorized-by' "$f" 2>/dev/null && ! grep -q '<reviewed-by\|<closed-by' "$f" 2>/dev/null; then
        UNSIGNED="$UNSIGNED $f"
      fi
      ;;
    *.md)
      if grep -qE '^status:\s*deferred' "$f" 2>/dev/null; then
        continue
      fi
      if grep -qE '^status:\s*(pending|open)' "$f" 2>/dev/null; then
        continue
      fi
      if grep -q '^authorized_by:' "$f" 2>/dev/null && ! grep -q '^reviewed_by:\|^closed_by:' "$f" 2>/dev/null; then
        UNSIGNED="$UNSIGNED $f"
      fi
      ;;
  esac
done

if [ -n "$UNSIGNED" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Push/merge requires PR Reviewer sign-off. These task files are missing reviewed-by or closed-by:$UNSIGNED. Spawn PR Reviewer to sign them.\"}"
  exit 0
fi

exit 0
