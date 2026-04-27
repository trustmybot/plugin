#!/usr/bin/env bash
# PostToolUse hook (#171 follow-up). When bro flips a task to `closed`, the
# corresponding SWE worktree is no longer needed — its commits live on the
# branch (which stays for push-gate review). This hook removes the worktree
# directory + prunes git's internal tracking, freeing disk + keeping
# .claude/worktrees/ tidy.
#
# Triggers ONLY on:
#   - tool_name = mcp__plugin_<channel>_trajectory-server__task_update_status
#   - args.agent = 'bro'
#   - args.status = 'closed'
#   - the task row has a branch_id with a matching worktree
#
# Silent no-op when:
#   - any of the above don't match
#   - DB / git missing
#   - worktree already removed
#   - bypass: TMB_KEEP_CLOSED_WORKTREES=1
#
# Reports cleanup to stderr (visible in CC's debug log; not user-blocking).

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  mcp__*trajectory-server__task_update_status) ;;
  *) exit 0 ;;
esac

if [ "${TMB_KEEP_CLOSED_WORKTREES:-0}" = "1" ]; then
  exit 0
fi

AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // ""' 2>/dev/null)
STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // ""' 2>/dev/null)
TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)

[ "$AGENT" = "bro" ] || exit 0
[ "$STATUS" = "closed" ] || exit 0
[ -n "$TASK_ID" ] || exit 0

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  REPO_ROOT_FOR_DB=$(git rev-parse --show-toplevel 2>/dev/null) || REPO_ROOT_FOR_DB="$PWD"
  DB_PATH="$REPO_ROOT_FOR_DB/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

BRANCH_ID=$(sqlite3 "$DB_PATH" "SELECT branch_id FROM tasks WHERE id=$TASK_ID LIMIT 1;" 2>/dev/null)
[ -n "$BRANCH_ID" ] || exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

WORKTREE_PATH=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$BRANCH_ID" '
  /^worktree / { wt=substr($0, 10) }
  /^branch / && $2 == b { print wt; exit }
')

[ -n "$WORKTREE_PATH" ] || exit 0
[ "$WORKTREE_PATH" != "$REPO_ROOT" ] || exit 0

git -C "$REPO_ROOT" worktree remove "$WORKTREE_PATH" --force >/dev/null 2>&1 || {
  printf 'tmb: worktree remove failed for %s — leaving in place\n' "$WORKTREE_PATH" >&2
  exit 0
}

git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true

printf 'tmb: cleaned up worktree %s after task #%s closed\n' "$WORKTREE_PATH" "$TASK_ID" >&2
