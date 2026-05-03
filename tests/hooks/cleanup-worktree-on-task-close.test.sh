#!/usr/bin/env bash
# Tests for scripts/hooks/cleanup-worktree-on-task-close.sh.
# Hook contract: PostToolUse on task_update_status. When agent='bro' AND
# status='closed' AND task has a worktree, remove the worktree. Silent
# no-op for any unmet condition. Worktree match is path/slug-based so it
# works for both branch-attached and detached-HEAD worktrees.
#
# Slug convention: SLUG="${BRANCH_ID#*/}" (strips first <type>/ prefix).
# fix/foo → slug=foo → worktree at .claude/worktrees/foo
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
  INSERT INTO tasks (id, branch_id, status) VALUES (3, 'fix/detached', 'completed');
"
export TRAJECTORY_DB_PATH="$DB"

# Create a branch-attached worktree for task 1 (slug = "foo" from "fix/foo").
git branch fix/foo HEAD
git worktree add -q .claude/worktrees/foo fix/foo

# Create a detached-HEAD worktree for task 3 (slug = "detached" from "fix/detached").
# This is the post-!45 SWE pattern: worktree uses detached HEAD.
git worktree add -q --detach .claude/worktrees/detached

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
  [ -d "$REPO/.claude/worktrees/foo" ]
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

test_case "detached-HEAD worktree: removed by slug match (not branch ref)"
[ -d "$REPO/.claude/worktrees/detached" ] || { echo "FAIL: detached worktree missing before test"; exit 1; }
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 3)")
assert_contains "$out" 'cleaned up worktree' "report message for detached worktree"
[ ! -d "$REPO/.claude/worktrees/detached" ] || { echo "FAIL: detached worktree still present"; exit 1; }
echo "  detached-HEAD worktree removed"

test_case "bro closes task 1: worktree removed (slug-based path match)"
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 1)")
assert_contains "$out" 'cleaned up worktree' "report message"
worktree_exists && { echo "FAIL: worktree still present"; exit 1; }
echo "  worktree removed"

test_case "RC channel tool name also matches"
# bar slug = "bar" from "fix/bar"
git branch fix/bar HEAD
git worktree add -q .claude/worktrees/bar fix/bar
out=$(run_hook "$(input 'mcp__plugin_tmb-rc_trajectory-server__task_update_status' 'bro' 'closed' 2)")
[ ! -d "$REPO/.claude/worktrees/bar" ] || { echo "FAIL: rc-channel match didn't fire"; exit 1; }
echo "  rc-channel tool name handled"

test_case "TMB workspace shape: workspace-rooted DB + tasks.repo=null + tmb_default_repo='plugin' → worktree removed"
WORKSPACE_TMP=$(mktemp -d -t tmb-ws-XXXX)
INNER="$WORKSPACE_TMP/plugin"
mkdir -p "$INNER"
cd "$INNER"
git init -q -b main "$INNER"
git -C "$INNER" config user.email t@t.io
git -C "$INNER" config user.name t
echo init > "$INNER/README.md"
git -C "$INNER" add .
git -C "$INNER" commit -qm init
WS_DB="$WORKSPACE_TMP/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$WS_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, repo TEXT, status TEXT);
  INSERT INTO tasks (id, branch_id, repo, status) VALUES (20, 'fix/ws-test', NULL, 'completed');
"
sqlite3 "$WS_DB" "
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
  INSERT INTO plugin_config (key, value_json, updated_at) VALUES ('tmb_default_repo', '\"plugin\"', datetime('now'));
"
git -C "$INNER" branch fix/ws-test HEAD
git -C "$INNER" worktree add -q "$WORKSPACE_TMP/.claude/worktrees/ws-test" fix/ws-test
[ -d "$WORKSPACE_TMP/.claude/worktrees/ws-test" ] || { echo "FAIL: worktree not created"; exit 1; }
out=$(echo "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 20)" \
  | TRAJECTORY_DB_PATH="$WS_DB" bash "$HOOK" 2>&1 || true)
assert_contains "$out" 'cleaned up worktree' "TMB workspace shape: worktree should be cleaned up"
[ ! -d "$WORKSPACE_TMP/.claude/worktrees/ws-test" ] || { echo "FAIL: worktree still present in TMB workspace shape"; exit 1; }
echo "  TMB workspace-rooted worktree removed successfully"
rm -rf "$WORKSPACE_TMP"
cd "$REPO"

summarize
