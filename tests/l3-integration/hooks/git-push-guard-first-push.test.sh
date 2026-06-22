#!/usr/bin/env bash
# Regression tests for git-push-guard.sh first-push fallback (Fix 1 of !2899).
#
# Pre-fix behavior: when `git push -u origin <new-branch>` has no upstream yet,
# `git log @{u}..HEAD` fails and PUSH_SHAS was empty → hook exited 0 (allowed push)
# regardless of whether a pr-reviewer pass verdict existed.
#
# Post-fix behavior: hook falls back to `git log origin/$pr_target..HEAD` so first
# pushes of new branches are gated the same as subsequent pushes.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-push-guard.sh"

# ----- helpers ----------------------------------------------------------

# Create a fresh temp git repo with a bare "origin" and a `dev` base branch.
# A feature branch is created with one commit that has NO upstream set yet
# (simulating `git switch -c feat/new-branch` before the first push).
# Sets globals: REPO_PATH, FEATURE_SHA
setup_first_push_repo() {
  local dir
  dir=$(mktemp -d -t tmb-first-push-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b dev
    git config user.email "test@example.com"
    git config user.name  "Test"

    # bare upstream simulating origin
    git init --bare -q upstream.git
    git remote add origin "$dir/upstream.git"

    # initial commit on dev + push to establish origin/dev
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
    git push -qu origin dev

    # switch to new feature branch — no upstream set
    git switch -q -c feat/my-feature

    echo "feature work" > feature.txt
    git add feature.txt
    git commit -qm "feat: add feature"

    git rev-parse HEAD > .feature_sha
  )
  REPO_PATH="$dir"
  FEATURE_SHA=$(cat "$dir/.feature_sha")
}

# Apply schema to a fresh trajectory.db inside the repo and register the repo
# (post-#987: the push guard resolves the per-repo target_branch from the repos
# row matching the git-toplevel — repos is the sole source of truth).
setup_db() {
  local repo="$1"
  local db="$repo/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  local git_root
  git_root=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || echo "$repo")
  sqlite3 "$db" "
    INSERT OR REPLACE INTO repos (name, path) VALUES ('repo', '$git_root');
  " >/dev/null
  echo "$db"
}

# Insert issue + task whose commit_sha matches given sha.
insert_task() {
  local db="$1" task_id="$2" sha="$3"
  sqlite3 "$db" "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
      VALUES ($task_id, 1, 'feat/my-feature', 'task $task_id', 'd', 'closed', '## body', '$sha', datetime('now'), datetime('now'));
  " >/dev/null
}

# Insert a passing validation row for a task.
sign_task() {
  local db="$1" task_id="$2"
  sqlite3 "$db" "
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES ($task_id, 1, 'pr-reviewer', 'pass', 1, 'LGTM', datetime('now'));
  " >/dev/null
}

# Set the per-repo target_branch on the registered repos row (the sole source).
set_pr_target() {
  local db="$1" target="$2"
  sqlite3 "$db" "
    UPDATE repos SET target_branch = '$target' WHERE name = 'repo';
  " >/dev/null
}

# Run the hook from REPO_PATH with a given command.
run_hook() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

# ----- tests ------------------------------------------------------------

test_case "first-push with unsigned task: BLOCKED (no @{u} fallback uses origin/dev)"
setup_first_push_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
insert_task "$db" 1 "$FEATURE_SHA"
# task NOT signed — hook must block
out=$(run_hook "git push -u origin feat/my-feature" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "first push of unsigned task must be blocked"
assert_contains "$out" "task_id=1" "block message must list the unsigned task"
cleanup

test_case "first-push with signed task: ALLOWED (pass verdict satisfies gate)"
setup_first_push_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
insert_task "$db" 1 "$FEATURE_SHA"
sign_task   "$db" 1
out=$(run_hook "git push -u origin feat/my-feature" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "first push with pass verdict must be allowed"
cleanup

test_case "first-push with no task row: ALLOWED (untracked commit, TMB not managing it)"
setup_first_push_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
# no task row at all
out=$(run_hook "git push -u origin feat/my-feature" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "untracked first push must be allowed"
cleanup

test_case "first-push with no DB: ALLOWED (TMB not active)"
setup_first_push_repo
out=$(run_hook "git push -u origin feat/my-feature" "/nonexistent.db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing DB must not block first push"
cleanup

test_case "first-push: target_branch='main' from the repos row gates against origin/main"
# repos.target_branch='main'. The test repo has origin/dev but no origin/main,
# so git log origin/main..HEAD returns empty → no commits to gate → allowed.
# This verifies the hook reads target_branch from the repos row rather than
# hard-coding 'dev'.
setup_first_push_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "main"
insert_task "$db" 1 "$FEATURE_SHA"
out=$(run_hook "git push -u origin feat/my-feature" "$db")
# origin/main doesn't exist so git log fails gracefully, PUSH_SHAS empty, exits 0
assert_not_contains "$out" '"permissionDecision":"deny"' "when origin/target_branch doesn't exist, hook allows (no range to check)"
cleanup

summarize
