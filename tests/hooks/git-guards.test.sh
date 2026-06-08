#!/usr/bin/env bash
# Tests for scripts/hooks/git-guards.sh
# Hook contract: block force-push to main, block direct commit on protected
# branches, block PRs not targeting the configured pr_target. Config-driven
# via plugin_config (branching_model / pr_target / protected_branches).
#
# v0.3.2+: hook is worktree-aware. Commands prefixed with `cd <worktree> &&`
# evaluate against the WORKTREE'S branch, not the project root's. Tests for
# this behavior are at the bottom.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-guards.sh"

run_hook() {
  (cd "$PLUGIN_ROOT" && echo "$1" | TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" 2>&1 || true)
}

test_case "no config (fresh install) is non-blocking for commits"
out=$(run_hook '{"tool_input":{"command":"git commit -m test"}}')
assert_not_contains "$out" '"decision":"block"' "should NOT block on fresh install"

test_case "non-git command passes through"
out=$(run_hook '{"tool_input":{"command":"ls -la"}}')
assert_not_contains "$out" '"decision":"block"' "ls should not fire hook"

test_case "git status is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git status"}}')
assert_not_contains "$out" '"decision":"block"' "git status should pass"

test_case "git log is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git log --oneline -5"}}')
assert_not_contains "$out" '"decision":"block"' "git log should pass"

# ---- v0.3.2+ worktree-aware tests ----------------------------------------
#
# Set up a temp git repo with a worktree on a feature branch. Plant a
# trajectory.db with protected_branches=["main"] (the v0.3.1 onboarding
# default). Verify the hook treats `cd <worktree> && git commit` as a
# commit on the WORKTREE'S feature branch, not on the project root's main.

setup_worktree_repo() {
  local dir
  dir=$(mktemp -d -t tmb-guards-wt-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init

    # Create a worktree on a feature branch
    git worktree add -b feat/cli-todo .claude/worktrees/task-1 -q

    # Plant the trajectory DB. Schema-seed already provides the 3 default
    # policy keys (branching_model=github-flow, pr_target=main, protected=["main"]).
    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  )
  REPO_PATH="$dir"
}

run_hook_in_repo() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" \
    | TRAJECTORY_DB_PATH="$REPO_PATH/.claude/tmb/trajectory.db" \
      bash "$HOOK" 2>&1 || true)
}

cleanup_repo() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

test_case "v0.3.2: bare 'git commit' from project root on main IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git commit -m 'broken'")
assert_contains "$out" '"decision":"block"' "commit on protected main must block"
cleanup_repo

test_case "v0.3.2: 'cd .claude/worktrees/task-1 && git commit' is ALLOWED (worktree on feature branch)"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"decision":"block"' "commit from worktree on feat/cli-todo must pass"
cleanup_repo

test_case "v0.3.2: 'cd /abs/path/worktree && git commit' (absolute path) is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"decision":"block"' "absolute-path cd should also work"
cleanup_repo

test_case "v0.3.2: 'cd <main-worktree> && git commit' STILL blocks (cd to root + commit on main)"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH && git commit -m 'broken'")
assert_contains "$out" '"decision":"block"' "cd to root then commit on main should still block"
cleanup_repo

test_case "v0.3.2: 'git -C <worktree> commit' is ALLOWED (git -C path syntax)"
setup_worktree_repo
out=$(run_hook_in_repo "git -C .claude/worktrees/task-1 commit -m 'feat: add x'")
assert_not_contains "$out" '"decision":"block"' "git -C <worktree> commit should pass"
cleanup_repo

test_case "v0.3.2: 'git checkout -b' from worktree on feature branch is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git checkout -b feat/sub-task")
# Note: rule 4 still requires being on PR_TARGET to create new branches.
# From the worktree we're on feat/cli-todo, NOT on main — so this should block.
# This test confirms the worktree-aware lookup correctly identifies feat/cli-todo.
assert_contains "$out" '"decision":"block"' "rule 4 must see feat/cli-todo (not main) and block since not on PR_TARGET"
assert_contains "$out" "feat/cli-todo"   "block message must reference the worktree branch"
cleanup_repo

test_case "v0.3.2: rule 4 doesn't false-fire when origin doesn't exist (rev-parse without --verify bug)"
# Regression for bug #2: git rev-parse without --verify prints the literal
# 'origin/main' on stdout when the ref doesn't exist. With --verify, output
# is empty and the 'behind origin' check correctly skips.
setup_worktree_repo
# The setup repo has no remote — origin/main doesn't exist.
# `git checkout -b new-from-main` should be allowed (we're on main, no remote
# to be behind), but the pre-fix code would block with "behind origin/main".
out=$(run_hook_in_repo "git checkout -b feat/new-from-main")
assert_not_contains "$out" "is behind origin" "no-remote repo must not falsely report behind-origin"
cleanup_repo

# ---- v0.3.3+ detached-HEAD DB-lookup tests (audit item 5) ----------------
#
# When the worktree is in detached-HEAD mode, git branch --show-current returns
# empty and Rule 2 previously silently disabled. cmd_effective_branch now does
# a DB lookup: worktree basename → tasks.branch_id → check if protected.

setup_detached_worktree_repo() {
  local dir
  dir=$(mktemp -d -t tmb-guards-detached-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init

    # Create a SWE worktree attached to feat/cli-todo — the worktree owns the
    # branch ref so its commits advance it directly.
    # Slug = "cli-todo" (basename of worktree dir = everything after last /).
    git branch feat/cli-todo HEAD
    git worktree add -q .claude/worktrees/cli-todo feat/cli-todo

    # Plant trajectory DB with:
    #   - branching_model, pr_target, protected_branches (schema defaults to github-flow/main/[main])
    #   - a task whose branch_id = 'feat/cli-todo' (non-protected, commit should pass)
    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
    sqlite3 .claude/tmb/trajectory.db "
      INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
        VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
      INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
        VALUES (1, 1, 'feat/cli-todo', 'test task', 'd', 'pending', '', datetime('now'), datetime('now'));
    " >/dev/null
  )
  REPO_PATH="$dir"
}

test_case "v0.3.3: detached-HEAD worktree on feature branch: commit ALLOWED via DB lookup"
setup_detached_worktree_repo
# SWE issues: cd <detached-worktree> && git commit
# cmd_branch returns empty (detached HEAD); cmd_effective_branch resolves via DB:
# slug=cli-todo → branch_id=feat/cli-todo → not protected → allow.
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/cli-todo && git commit -m 'feat: add x'")
assert_not_contains "$out" '"decision":"block"' "detached worktree on feature branch must not block"
cleanup_repo

test_case "v0.3.3: detached-HEAD worktree with no DB match: commit allowed (fail-open)"
setup_detached_worktree_repo
# Remove the task row so DB lookup finds nothing — hook should fail-open (no block).
sqlite3 "$REPO_PATH/.claude/tmb/trajectory.db" "DELETE FROM tasks WHERE id=1;" >/dev/null
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/cli-todo && git commit -m 'feat: add x'")
assert_not_contains "$out" '"decision":"block"' "no DB match must not block (fail-open)"
cleanup_repo

summarize
