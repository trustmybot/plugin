#!/usr/bin/env bash
# Tests for scripts/hooks/stay-on-base-guard.sh
#
# Hook contract: when the main checkout is NOT inside a worktree, deny
# `git checkout <branch>` / `git switch <branch>` when the target branch_id
# matches an open task (status IN pending/running/needs_validation).
#
# Allow cases:
#   - New-branch creation flags (-b/-B/-c/-C)
#   - Commands run from inside .claude/worktrees/* (SWE worktree context)
#   - Switches to branches not referenced by any open task
#   - File-restore `git checkout -- <path>`
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/stay-on-base-guard.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    branch_id TEXT NOT NULL,
    parent_branch_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    spec_body TEXT NOT NULL DEFAULT '',
    repo TEXT,
    prompt_bearing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT INTO issues (objective, created_at, updated_at) VALUES ('test', datetime('now'), datetime('now'));
  INSERT INTO tasks (issue_id, branch_id, status, description) VALUES (1, 'feat/open-task', 'pending', 'open task');
  INSERT INTO tasks (issue_id, branch_id, status, description) VALUES (1, 'feat/running-task', 'running', 'running task');
  INSERT INTO tasks (issue_id, branch_id, status, description) VALUES (1, 'feat/closed-task', 'closed', 'closed task');
"

run_hook() {
  local cmd="$1"
  local cwd="${2:-$TMPDIR}"
  local payload
  payload=$(jq -n --arg c "$cmd" '{ tool_name: "Bash", tool_input: { command: $c } }')
  (cd "$cwd" && printf '%s' "$payload" | bash "$HOOK" 2>&1 || true)
}

run_hook_from_worktree() {
  local cmd="$1"
  local wt_dir="$TMPDIR/.claude/worktrees/my-task"
  mkdir -p "$wt_dir"
  run_hook "$cmd" "$wt_dir"
}

test_case "non-Bash tool: silent pass"
out=$(jq -n '{ tool_name: "Edit", tool_input: { file_path: "foo.ts" } }' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "non-Bash ignored"

test_case "non-checkout Bash command: silent pass"
out=$(run_hook "ls -la")
assert_eq "" "$out" "ls passes through"

test_case "git status: silent pass"
out=$(run_hook "git status")
assert_eq "" "$out" "git status not a branch switch"

test_case "DENY: git checkout <open-task-branch> from main checkout"
out=$(run_hook "git checkout feat/open-task")
assert_contains "$out" '"permissionDecision":"deny"' "deny checkout of open task branch"
assert_contains "$out" 'main checkout stays on the base' "error message teaches recovery"
assert_contains "$out" 'feat/open-task' "branch name in message"

test_case "DENY: git switch <running-task-branch> from main checkout"
out=$(run_hook "git switch feat/running-task")
assert_contains "$out" '"permissionDecision":"deny"' "deny switch of running task branch"

test_case "ALLOW: git checkout <closed-task-branch> — closed tasks are not open"
out=$(run_hook "git checkout feat/closed-task")
assert_eq "" "$out" "closed task branch is not blocked"

test_case "ALLOW: git checkout dev — not a task branch"
out=$(run_hook "git checkout dev")
assert_eq "" "$out" "base branch checkout not blocked"

test_case "ALLOW: git checkout -b feat/new-branch — new branch creation"
out=$(run_hook "git checkout -b feat/new-branch")
assert_eq "" "$out" "new-branch creation allowed"

test_case "ALLOW: git switch -c feat/new-branch — new branch creation"
out=$(run_hook "git switch -c feat/new-branch")
assert_eq "" "$out" "switch -c allowed"

test_case "ALLOW: git checkout -- path/to/file.ts — file restore, not a branch switch"
out=$(run_hook "git checkout -- path/to/file.ts")
assert_eq "" "$out" "file restore not a branch switch"

test_case "ALLOW: command run from inside a worktree (pwd signal)"
out=$(run_hook_from_worktree "git checkout feat/open-task")
assert_eq "" "$out" "worktree CWD is excluded from guard"

test_case "ALLOW: command with cd worktree prefix"
out=$(run_hook "cd $TMPDIR/.claude/worktrees/my-task && git checkout feat/open-task")
assert_eq "" "$out" "cd into worktree prefix excluded"

test_case "ALLOW: no DB (not a TMB project)"
ORIG_DB="$TRAJECTORY_DB_PATH"
export TRAJECTORY_DB_PATH="/nonexistent-path/trajectory.db"
out=$(run_hook "git checkout feat/open-task")
assert_eq "" "$out" "no DB = not TMB = allow"
export TRAJECTORY_DB_PATH="$ORIG_DB"

summarize
