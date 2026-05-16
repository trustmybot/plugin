#!/usr/bin/env bash
# Tests for scripts/hooks/git-push-guard.sh
#
# Hook contract: block `git push` when commits in the push range are
# attached to closed tasks (via tasks.commit_sha) that lack a passing
# pr-reviewer verdict (validation_attempts.verdict='pass').
#
# Skips: --force pushes (delegated to git-guards), no upstream (first push),
# commits with no matching task row (pre-TMB / untracked work), missing DB,
# missing sqlite3.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-push-guard.sh"

# ----- helpers ----------------------------------------------------------

# Create a fresh temp git repo with a bare upstream + N committed files.
# Returns the repo path. Sets globals SHA1, SHA2 to the last two commit SHAs.
setup_repo() {
  local dir
  dir=$(mktemp -d -t tmb-push-guard-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name  "Test"
    # bare upstream so @{u} resolves
    git init --bare -q upstream.git
    git remote add origin "$dir/upstream.git"

    # commit 0 (initial; pushed with upstream tracking so @{u} resolves)
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
    git push -qu origin main

    # commit 1 (ahead of upstream)
    echo "feat A" > a.txt
    git add a.txt
    git commit -qm "feat: A"

    # commit 2 (ahead of upstream)
    echo "feat B" > b.txt
    git add b.txt
    git commit -qm "feat: B"

    git rev-parse HEAD~ > .last1
    git rev-parse HEAD  > .last2
  )
  REPO_PATH="$dir"
  SHA1=$(cat "$dir/.last1")
  SHA2=$(cat "$dir/.last2")
}

# Apply the schema to a fresh trajectory.db inside the repo.
# Redirect sqlite3 stdout to /dev/null because the WAL journal_mode pragma
# echoes 'wal', which would otherwise pollute the function's return value.
setup_db() {
  local repo="$1"
  local db="$repo/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  echo "$db"
}

# Insert an issue + a task whose commit_sha matches given sha.
# task is in 'closed' status (i.e. bro signed off, push gate is the next gate).
# branch_id is per-task to satisfy the UNIQUE(issue_id, branch_id) index.
insert_task() {
  local db="$1" task_id="$2" sha="$3"
  sqlite3 "$db" "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
      VALUES ($task_id, 1, 'feat/x-$task_id', 'task $task_id', 'd', 'closed', '## body', '$sha', datetime('now'), datetime('now'));
  " >/dev/null
}

# Insert a passing validation row for a task (i.e. pr-reviewer signed off).
sign_task() {
  local db="$1" task_id="$2"
  sqlite3 "$db" "
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, created_at)
      VALUES ($task_id, 1, 'pr-reviewer', 'pass', 'MCP available: yes' || char(10) || 'LGTM', datetime('now'));
  " >/dev/null
}

# Run the hook from inside REPO_PATH with a given Bash command in tool_input.
run_hook() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

# Cleanup
cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

# ----- tests ------------------------------------------------------------

test_case "non-push command passes through silently"
setup_repo
out=$(run_hook "git status")
assert_not_contains "$out" '"decision":"block"' "git status should not be gated"
cleanup

test_case "git push --force is delegated to git-guards (this hook allows)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"  # unsigned task — would block normally
out=$(run_hook "git push --force origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "force push should be deferred to git-guards"
cleanup

test_case "git push -f is delegated to git-guards (this hook allows)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
out=$(run_hook "git push -f origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "force push (-f) should be deferred"
cleanup

test_case "no DB: TMB not tracking, push allowed"
setup_repo
out=$(run_hook "git push origin main" "/nonexistent.db")
assert_not_contains "$out" '"decision":"block"' "missing DB should not block"
cleanup

test_case "no upstream new commits: nothing to gate, allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
# Reset HEAD to upstream so @{u}..HEAD is empty
(cd "$REPO_PATH" && git reset -q --hard origin/main)
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "no new commits should not block"
cleanup

test_case "push with untracked commits (no matching task row): allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
# DB exists but no task row references SHA1 / SHA2 — these commits are pre-TMB
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "untracked commits should not block"
cleanup

test_case "push with all-signed tracked commits: allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "all-signed should not block"
cleanup

test_case "push with one unsigned tracked commit: BLOCKED with helpful reason"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
# task 2 NOT signed
out=$(run_hook "git push origin main" "$db")
assert_contains "$out" '"decision":"block"' "unsigned commit must block"
assert_contains "$out" "review before push"   "block message must mention bro review path"
assert_contains "$out" "task_id=2"            "block message must list the unsigned task"
cleanup

test_case "push with multiple unsigned tracked commits: BLOCKED, all listed"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
insert_task "$db" 2 "$SHA2"
# neither signed
out=$(run_hook "git push origin main" "$db")
assert_contains "$out" '"decision":"block"' "unsigned commits must block"
assert_contains "$out" "task_id=1"           "should list task 1"
assert_contains "$out" "task_id=2"           "should list task 2"
cleanup

test_case "push with mixed-signed (one signed, one not) commits: BLOCKED"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
out=$(run_hook "git push origin main" "$db")
assert_contains "$out" '"decision":"block"'  "mixed should block on unsigned"
assert_contains "$out" "task_id=2"           "should list ONLY the unsigned task 2"
assert_not_contains "$out" "task_id=1 "      "signed task 1 should not appear in block list"
cleanup

# SWE-context run_hook helper: injects agent_type into the top-level payload.
run_hook_as_swe() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local agent_type="${3:-tmb:swe}"
  local payload
  payload=$(jq -cn --arg c "$cmd" --arg a "$agent_type" '{agent_type:$a,tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

test_case "SWE caller (tmb:swe): git push BLOCKED regardless of unsigned status"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_as_swe "git push origin main" "$db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "SWE push must be blocked even with all-signed commits"
assert_contains "$out" "SWE must never push"  "block message must reference swe.md rule"
cleanup

test_case "SWE caller (swe): git push BLOCKED (bare agent_type variant)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_swe "git push origin main" "/nonexistent.db" "swe")
assert_contains "$out" '"decision":"block"' "bare swe agent_type must also be blocked"
cleanup

test_case "SWE caller: git push --force still exits early (force delegated to git-guards before SWE check)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_swe "git push --force origin main" "$db" "tmb:swe")
assert_not_contains "$out" '"decision":"block"' "force push exits before SWE check (git-guards handles it)"
cleanup

test_case "non-SWE caller: git push NOT blocked by SWE check (bro/regular-claude)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "non-SWE caller with all-signed should not be blocked"
cleanup

# ----- worktree-path push detection tests (audit item 14) ----------------
#
# Any push whose command or PWD involves .claude/worktrees/ must be blocked
# regardless of agent_type (defense-in-depth for CC quirk #97 field drop).

run_hook_from_worktree_cmd() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

test_case "push via 'cd .claude/worktrees/...' prefix: BLOCKED (no agent_type field)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_from_worktree_cmd "cd $REPO_PATH/.claude/worktrees/feat-x && git push origin feat/x" "$db")
assert_contains "$out" '"decision":"block"' "push from worktree cd prefix must block even without agent_type"
assert_contains "$out" ".claude/worktrees/" "block message must reference worktree path"
cleanup

test_case "push via 'git -C .claude/worktrees/...' flag: BLOCKED (no agent_type field)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
out=$(run_hook_from_worktree_cmd "git -C $REPO_PATH/.claude/worktrees/feat-x push origin feat/x" "$db")
assert_contains "$out" '"decision":"block"' "push via git -C worktree path must block"
cleanup

test_case "normal push from main checkout (no worktree in cmd): NOT blocked by worktree check"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_from_worktree_cmd "git push origin main" "$db")
assert_not_contains "$out" '"decision":"block"' "normal push from main checkout must not be blocked by worktree check"
cleanup

# ----- $PWD vs `cd` override tests --------------------------------------
#
# When a Bash session's persistent cwd is a worktree (left over from a
# previous tool call) but the current command starts with `cd <main> && ...`,
# the hook must trust the cd target rather than stale $PWD.

run_hook_with_pwd() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local pwd_dir="${3:-$REPO_PATH}"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  ( cd "$pwd_dir" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true )
}

test_case "PWD in worktree but command does 'cd <main> && git push': NOT blocked (cd overrides stale PWD)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
mkdir -p "$REPO_PATH/.claude/worktrees/feat-x"
out=$(run_hook_with_pwd \
  "cd $REPO_PATH && git push origin main" \
  "$db" \
  "$REPO_PATH/.claude/worktrees/feat-x")
assert_not_contains "$out" '"decision":"block"' \
  "cd to non-worktree path should override stale worktree PWD"
cleanup

test_case "PWD in worktree, plain 'git push' (no cd, no -C): BLOCKED via PWD fallback"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
mkdir -p "$REPO_PATH/.claude/worktrees/feat-x"
out=$(run_hook_with_pwd "git push origin main" "$db" "$REPO_PATH/.claude/worktrees/feat-x")
assert_contains "$out" '"decision":"block"' \
  "plain push with PWD-in-worktree must still block (legitimate worktree push)"
cleanup

test_case "PWD in main, command 'cd <worktree> && git push': BLOCKED (cd target is worktree)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
mkdir -p "$REPO_PATH/.claude/worktrees/feat-x"
out=$(run_hook_with_pwd \
  "cd $REPO_PATH/.claude/worktrees/feat-x && git push origin feat/x" \
  "$db" \
  "$REPO_PATH")
assert_contains "$out" '"decision":"block"' \
  "cd into worktree should block even when PWD is main"
cleanup

# ----- false-positive tests (IS_PUSH should NOT trigger) ----------------
#
# Commands that merely mention "git push" in a non-push context must not
# be blocked. These catch the over-broad glob patterns that matched any
# string containing "git push".

test_case "false-positive: grep for 'git push' in a file — NOT blocked"
setup_repo
out=$(run_hook "grep \"git push\" tests/lint/something.sh")
assert_not_contains "$out" '"decision":"block"' "grep for 'git push' must not be detected as a push"
cleanup

test_case "false-positive: echo mentioning 'git push' — NOT blocked"
setup_repo
out=$(run_hook "echo \"Don't forget to git push\"")
assert_not_contains "$out" '"decision":"block"' "echo mentioning 'git push' must not be detected as a push"
cleanup

test_case "false-positive: cat pipe grep for 'git push' — NOT blocked"
setup_repo
out=$(run_hook "cat docs/git-conventions.md | grep \"git push\"")
assert_not_contains "$out" '"decision":"block"' "cat|grep 'git push' must not be detected as a push"
cleanup

test_case "false-positive: git log --grep='git push' — NOT blocked"
setup_repo
out=$(run_hook "git log --grep=\"git push\"")
assert_not_contains "$out" '"decision":"block"' "git log --grep='git push' must not be detected as a push"
cleanup

test_case "false-positive: git commit -m mentioning 'git push' — NOT blocked"
setup_repo
out=$(run_hook "git commit -m \"fix: make git push idempotent\"")
assert_not_contains "$out" '"decision":"block"' "commit message mentioning 'git push' must not be detected as a push"
cleanup

# ----- positive regression tests (IS_PUSH MUST trigger) -----------------
#
# Real push commands — with or without a TMB DB — must still be detected.
# We use /nonexistent.db so the hook exits at the "no DB" check (after IS_PUSH
# triggers), not at the unsigned-commit check. We verify the hook did NOT
# silently pass without seeing IS_PUSH (i.e. it at least reached the DB
# check rather than bailing at exit 0 from "not a push").
# For SWE-identity positive cases we use run_hook_as_swe to get a definitive
# BLOCK decision regardless of DB state.

test_case "positive: 'git push origin main' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git push origin main" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "plain git push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'git -C /some/path push origin feature' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git -C /some/path push origin feature" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "git -C push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'cd /repo && git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "cd /repo && git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "cd && git push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'git status; git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git status; git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "semicolon-separated git push must be detected and blocked for SWE"
cleanup

test_case "positive: 'make build || git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "make build || git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"decision":"block"' "|| git push must be detected as a push and blocked for SWE"
cleanup

summarize
