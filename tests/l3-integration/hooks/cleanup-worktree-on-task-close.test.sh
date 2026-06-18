#!/usr/bin/env bash
# Tests for scripts/hooks/cleanup-worktree-on-task-close.sh.
# Hook contract: PostToolUse on task_update_status. When agent='bro' AND
# status='closed' AND task has a worktree, remove the worktree. Silent
# no-op for any unmet condition. Worktree match is path/slug-based — the
# hook just compares the worktree directory name to the task's slug, so it
# works regardless of whether the worktree is branch-attached or detached.
#
# Slug convention: SLUG="${BRANCH_ID#*/}" (strips first <type>/ prefix).
# fix/foo → slug=foo → worktree at .claude/worktrees/foo
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
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
  INSERT INTO tasks (id, branch_id, status) VALUES (3, 'fix/second', 'completed');
"
export TRAJECTORY_DB_PATH="$DB"

# Create a branch-attached worktree for task 1 (slug = "foo" from "fix/foo").
git branch fix/foo HEAD
git worktree add -q .claude/worktrees/foo fix/foo

# Second worktree on a separate branch for task 3 (slug = "second"). All SWE
# worktrees attach to a branch directly so commits advance the branch ref.
git branch fix/second HEAD
git worktree add -q .claude/worktrees/second fix/second

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

test_case "second worktree: removed by slug match"
[ -d "$REPO/.claude/worktrees/second" ] || { echo "FAIL: second worktree missing before test"; exit 1; }
out=$(run_hook "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 3)")
assert_contains "$out" 'cleaned up worktree' "report message for second worktree"
[ ! -d "$REPO/.claude/worktrees/second" ] || { echo "FAIL: second worktree still present"; exit 1; }
echo "  second worktree removed"

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

test_case "TMB workspace shape: workspace-rooted DB + tasks.repo=null + single-repo fallback → worktree removed"
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
INNER_ROOT=$(git -C "$INNER" rev-parse --show-toplevel)
WS_DB="$WORKSPACE_TMP/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$WS_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, repo TEXT, status TEXT);
  INSERT INTO tasks (id, branch_id, repo, status) VALUES (20, 'fix/ws-test', NULL, 'completed');
"
sqlite3 "$WS_DB" "
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, target_branch TEXT, protected_branches TEXT);
  INSERT INTO repos (name, path) VALUES ('plugin', '$INNER_ROOT');
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

# ---- #350: bro_atomic_close trigger -----------------------------------------
# The hook must fire on bro_atomic_close (the canonical close path), treating it
# as status=closed even though there is no .tool_input.status field.

bro_atomic_close_input() {
  local tool="$1" agent="$2" task_id="$3"
  jq -n --arg tool "$tool" --arg agent "$agent" --argjson tid "$task_id" '{
    tool_name: $tool,
    tool_input: { agent: $agent, task_id: $tid }
  }'
}

test_case "#350: bro_atomic_close fires cleanup (no status field in input)"
git branch fix/atomic HEAD
git worktree add -q .claude/worktrees/atomic fix/atomic
sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status) VALUES (10, 'fix/atomic', 'completed');"
[ -d "$REPO/.claude/worktrees/atomic" ] || { echo "FAIL: atomic worktree not created"; exit 1; }
out=$(bro_atomic_close_input 'mcp__plugin_tmb_trajectory-server__bro_atomic_close' 'bro' 10 \
  | bash "$HOOK" 2>&1 || true)
assert_contains "$out" 'cleaned up worktree' "bro_atomic_close must trigger cleanup"
[ ! -d "$REPO/.claude/worktrees/atomic" ] || { echo "FAIL: atomic worktree still present"; exit 1; }
echo "  bro_atomic_close worktree cleanup OK"

test_case "#350: bro_atomic_close with TMB_KEEP_CLOSED_WORKTREES=1 bypass: worktree intact"
git branch fix/atomic2 HEAD
git worktree add -q .claude/worktrees/atomic2 fix/atomic2
sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status) VALUES (11, 'fix/atomic2', 'completed');"
out=$(bro_atomic_close_input 'mcp__plugin_tmb_trajectory-server__bro_atomic_close' 'bro' 11 \
  | env TMB_KEEP_CLOSED_WORKTREES=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var must silence bro_atomic_close cleanup"
[ -d "$REPO/.claude/worktrees/atomic2" ] || { echo "FAIL: atomic2 worktree was removed despite bypass"; exit 1; }
echo "  bro_atomic_close bypass OK"

test_case "#350: bro_atomic_close with agent!=bro: silent no-op"
out=$(bro_atomic_close_input 'mcp__plugin_tmb_trajectory-server__bro_atomic_close' 'swe' 11 \
  | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "non-bro agent must be silent no-op for bro_atomic_close"
[ -d "$REPO/.claude/worktrees/atomic2" ] || { echo "FAIL: worktree removed for non-bro agent"; exit 1; }

# ---- #559: per-repo HEAD-reset target resolution -----------------------------
# Set up plugin_config + repos table in the main DB for these cases.
_REPO_REALPATH=$(git -C "$REPO" rev-parse --show-toplevel)
sqlite3 "$DB" "
  CREATE TABLE IF NOT EXISTS plugin_config (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
  INSERT OR REPLACE INTO plugin_config (key, value_json, updated_at) VALUES ('pr_target', '\"dev\"', datetime('now'));
  CREATE TABLE IF NOT EXISTS repos (
    name              TEXT PRIMARY KEY,
    path              TEXT NOT NULL,
    file_count        INTEGER NOT NULL DEFAULT 0,
    last_scanned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    target_branch     TEXT,
    branching_model   TEXT,
    protected_branches TEXT
  );
"

test_case "#559: registered repo with target_branch='main' → HEAD reset to main (not global dev)"
# dev branch must exist so global fallback is plausible; main already exists.
git -C "$REPO" branch -f dev HEAD 2>/dev/null || true
# Create a scratch branch to put HEAD on (can't checkout the worktree branch).
git -C "$REPO" branch -f scratch-50 HEAD
git -C "$REPO" checkout -q scratch-50
sqlite3 "$DB" "INSERT OR REPLACE INTO repos (name, path, target_branch) VALUES ('fixture', '${_REPO_REALPATH}', 'main');"
git -C "$REPO" branch fix/per-repo-main HEAD
git -C "$REPO" worktree add -q .claude/worktrees/per-repo-main fix/per-repo-main
sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status) VALUES (50, 'fix/per-repo-main', 'completed');"
out=$(echo "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 50)" \
  | bash "$HOOK" 2>&1 || true)
assert_contains "$out" 'cleaned up worktree' "worktree removed"
AFTER_HEAD=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[ "$AFTER_HEAD" = "main" ] || { echo "FAIL: HEAD is '$AFTER_HEAD', expected 'main'"; exit 1; }
echo "  HEAD reset to main (per-repo target_branch honored)"

test_case "#559: registered repo with NULL target_branch → falls back to global pr_target='dev'"
sqlite3 "$DB" "INSERT OR REPLACE INTO repos (name, path, target_branch) VALUES ('fixture', '${_REPO_REALPATH}', NULL);"
git -C "$REPO" branch fix/per-repo-null HEAD
git -C "$REPO" worktree add -q .claude/worktrees/per-repo-null fix/per-repo-null
sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status) VALUES (51, 'fix/per-repo-null', 'completed');"
# Put HEAD on a scratch branch (not the worktree branch, not dev yet).
git -C "$REPO" branch -f scratch-51 HEAD
git -C "$REPO" checkout -q scratch-51
out=$(echo "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 51)" \
  | bash "$HOOK" 2>&1 || true)
assert_contains "$out" 'cleaned up worktree' "worktree removed"
AFTER_HEAD=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[ "$AFTER_HEAD" = "dev" ] || { echo "FAIL: HEAD is '$AFTER_HEAD', expected 'dev'"; exit 1; }
echo "  HEAD reset to dev (global pr_target fallback honored)"

test_case "#559: TMB_KEEP_HEAD_ON_CLOSE=1 still skips the reset"
sqlite3 "$DB" "INSERT OR REPLACE INTO repos (name, path, target_branch) VALUES ('fixture', '${_REPO_REALPATH}', 'main');"
git -C "$REPO" branch fix/per-repo-bypass HEAD
git -C "$REPO" worktree add -q .claude/worktrees/per-repo-bypass fix/per-repo-bypass
sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status) VALUES (52, 'fix/per-repo-bypass', 'completed');"
# Start on a scratch branch so the hook would otherwise move us to main.
git -C "$REPO" branch -f scratch-52 HEAD
git -C "$REPO" checkout -q scratch-52
out=$(echo "$(input 'mcp__plugin_tmb_trajectory-server__task_update_status' 'bro' 'closed' 52)" \
  | env TMB_KEEP_HEAD_ON_CLOSE=1 bash "$HOOK" 2>&1 || true)
assert_contains "$out" 'cleaned up worktree' "worktree removed"
AFTER_HEAD=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[ "$AFTER_HEAD" = "scratch-52" ] || { echo "FAIL: HEAD is '$AFTER_HEAD', expected 'scratch-52'"; exit 1; }
echo "  HEAD unchanged when TMB_KEEP_HEAD_ON_CLOSE=1"

summarize
