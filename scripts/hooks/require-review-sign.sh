#!/usr/bin/env bash
# Hook: Block git push/merge unless all completed tasks have PR Reviewer sign-off.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only gate push and merge commands
case "$CMD" in
  *"git push"*|*"gh pr merge"*) ;;
  *) exit 0 ;;
esac

# Issue #13: feature/* pushes are always allowed (work-in-progress backups
# don't require signoff). Enforcement applies only to pushes/merges targeting
# protected branches (dev, main, master, or anything the user's branching
# model declared as protected).
if echo "$CMD" | grep -qE '\bgit push[[:space:]]+[^[:space:]]+[[:space:]]+(HEAD:)?feature/'; then
  exit 0
fi
if echo "$CMD" | grep -qE '\bgit push[[:space:]]+[^[:space:]]+[[:space:]]+(HEAD:)?(fix|feat|refactor|chore|docs|test|perf|build|ci|style|revert)/'; then
  exit 0
fi
# Bare `git push` with current branch being a feature/* shape — also allow.
if ! echo "$CMD" | grep -qE '\bgit push[[:space:]]+[^[:space:]]+[[:space:]]+'; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
  case "$CURRENT_BRANCH" in
    feature/*|fix/*|feat/*|refactor/*|chore/*|docs/*|test/*|perf/*|build/*|ci/*|style/*|revert/*)
      exit 0
      ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

DB_PATH=$(tmb_db_path) || true

if [ -n "$DB_PATH" ] && tmb_have_sqlite; then
  UNSIGNED=$(tmb_unsigned_tasks)
  if [ -n "$UNSIGNED" ]; then
    BRANCH_LIST=$(echo "$UNSIGNED" | tr '\n' ' ' | sed 's/ $//')
    echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Push/merge requires PR Reviewer sign-off. These tasks are missing a passing validation_attempts row: $BRANCH_LIST. Spawn PR Reviewer to sign them.\"}"
  fi
  exit 0
fi

# Legacy fallback: DB absent or sqlite3 unavailable. Grep XML task files only.
# Markdown specs carry no in-file sign-off by design; never grep them.
echo "tmb-hook: trajectory.db not found or sqlite3 unavailable — falling back to legacy XML sign-off check." >&2

[ -d "docs/trustmybot/tasks" ] || exit 0

UNSIGNED=""
for f in docs/trustmybot/tasks/*.xml; do
  [ -f "$f" ] || continue
  if grep -q 'status="deferred"' "$f" 2>/dev/null; then
    continue
  fi
  if grep -q 'status="open"' "$f" 2>/dev/null; then
    continue
  fi
  if grep -q '<authorized-by' "$f" 2>/dev/null && ! grep -q '<reviewed-by\|<closed-by' "$f" 2>/dev/null; then
    UNSIGNED="$UNSIGNED $f"
  fi
done

if [ -n "$UNSIGNED" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Push/merge requires PR Reviewer sign-off. These task files are missing reviewed-by or closed-by:$UNSIGNED. Spawn PR Reviewer to sign them.\"}"
fi

exit 0
