#!/usr/bin/env bash
# Tests for scripts/hooks/cleanup-worktree-on-task-close.sh.
# Hook contract: PostToolUse on task_update_status. When agent='bro' AND
# status='closed' AND task has a worktree, remove the worktree. Silent
# no-op for any unmet condition.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/cleanup-worktree-on-task-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

REPO="$TMPDIR/repo"
git init -q -b main "$REPO"
cd "$REPO"
git config user.email t@t.io && git config user.name t
echo init > README.md && git add . && git commit -qm init

DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT);
  INSERT INTO tasks (id, branch_id, status) VALUES (1, 'fix/foo', 'completed');
  INSERT INTO tasks (id, branch_id, status) VALUES (2, 'fix/bar', 'completed');
"
export TRAJECTORY_DB_PATH="$DB"

# Create a worktree for task 1's branch.
git branch fix/foo HEAD
git worktree add -q .claude/worktrees/fix-foo fix/foo

input() {
  local tool="$1" agent="$2" status="$3" task_id="$4"
  jq -n --arg tool "$tool" --arg agent "$agent" --arg status "$status" --argjson tid "$task_id" '{
    tool_name: $tool,
    tool_input: { agent: $agent, status: $status, task_id: $tid }
  }'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

worktree_exists() {
  [ -d "$REPO/.claude/worktrees/fix-foo" ]
}

test_case "wrong tool name: silent no-op, worktree intact"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_get' 'bro' 'closed' 1)")
assert_eq "" "$out" "silent on wrong tool"
worktree_exists || { echo "FAIL: worktree gone"; exit 1; }

test_case "agent != bro: silent no-op, worktree intact"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'swe' 'closed' 1)")
assert_eq "" "$out" "silent on non-bro agent"
worktree_exists || { echo "FAIL: worktree gone"; exit 1; }

test_case "status != closed: silent no-op, worktree intact"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'completed' 1)")
assert_eq "" "$out" "silent on non-closed status"
worktree_exists || { echo "FAIL: worktree gone"; exit 1; }

test_case "TMB_KEEP_CLOSED_WORKTREES=1 bypass: worktree intact"
out=$(echo "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 1)" \
  | env TMB_KEEP_CLOSED_WORKTREES=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass silent"
worktree_exists || { echo "FAIL: worktree gone"; exit 1; }

test_case "task without worktree: silent no-op"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 2)")
worktree_exists || { echo "FAIL: task 1 worktree gone"; exit 1; }

test_case "bro closes task 1: worktree removed"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 1)")
assert_contains "$out" 'cleaned up worktree' "report message"
worktree_exists && { echo "FAIL: worktree still present"; exit 1; }
echo "  ✓ worktree removed"

test_case "RC channel tool name also matches"
git branch fix/bar HEAD
git worktree add -q .claude/worktrees/fix-bar fix/bar
out=$(run_hook "$(input 'mcp__plugin_tmb-rc_trajectory-server__task_update_status' 'bro' 'closed' 2)")
[ ! -d "$REPO/.claude/worktrees/fix-bar" ] || { echo "FAIL: rc-channel match didn't fire"; exit 1; }
echo "  ✓ rc-channel tool name handled"
