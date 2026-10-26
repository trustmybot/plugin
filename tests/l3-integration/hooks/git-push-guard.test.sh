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
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-push-guard.sh"
# TMB_HOOK_TEST_IMPL=ts runs the TypeScript gate in place of the .sh.
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/git-push-guard.sh"
. "$HERE/fixtures/wal-no-holder.sh"

# ----- helpers ----------------------------------------------------------

# Create a fresh temp git repo with a bare upstream + N committed files.
# Returns the repo path. Sets globals SHA1, SHA2 to the last two commit SHAs.
setup_repo() {
  local dir
  dir=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-push-guard-XXXXXX")
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
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES ($task_id, 1, 'pr-reviewer', 'pass', 1, 'LGTM', datetime('now'));
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
assert_not_contains "$out" '"permissionDecision":"deny"' "git status should not be gated"
cleanup

test_case "git push --force is delegated to git-guards (this hook allows)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"  # unsigned task — would block normally
out=$(run_hook "git push --force origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "force push should be deferred to git-guards"
cleanup

test_case "git push -f is delegated to git-guards (this hook allows)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
out=$(run_hook "git push -f origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "force push (-f) should be deferred"
cleanup

test_case "no DB: TMB not tracking, push allowed"
setup_repo
out=$(run_hook "git push origin main" "/nonexistent.db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing DB should not block"
cleanup

test_case "no upstream new commits: nothing to gate, allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
# Reset HEAD to upstream so @{u}..HEAD is empty
(cd "$REPO_PATH" && git reset -q --hard origin/main)
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "no new commits should not block"
cleanup

test_case "push with untracked commits (no matching task row): allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
# DB exists but no task row references SHA1 / SHA2 — these commits are pre-TMB
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "untracked commits should not block"
cleanup

test_case "push with all-signed tracked commits: allowed"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "all-signed should not block"
cleanup

test_case "push with one unsigned tracked commit: BLOCKED with helpful reason"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
# task 2 NOT signed
out=$(run_hook "git push origin main" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "unsigned commit must block"
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
assert_contains "$out" '"permissionDecision":"deny"' "unsigned commits must block"
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
assert_contains "$out" '"permissionDecision":"deny"'  "mixed should block on unsigned"
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
assert_contains "$out" '"permissionDecision":"deny"' "SWE push must be blocked even with all-signed commits"
assert_contains "$out" "SWE must never push"  "block message must reference swe.md rule"
cleanup

test_case "SWE caller (swe): git push BLOCKED (bare agent_type variant)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_swe "git push origin main" "/nonexistent.db" "swe")
assert_contains "$out" '"permissionDecision":"deny"' "bare swe agent_type must also be blocked"
cleanup

test_case "SWE caller: git push --force still exits early (force delegated to git-guards before SWE check)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_swe "git push --force origin main" "$db" "tmb:swe")
assert_not_contains "$out" '"permissionDecision":"deny"' "force push exits before SWE check (git-guards handles it)"
cleanup

test_case "non-SWE caller: git push NOT blocked by SWE check (bro/regular-claude)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "non-SWE caller with all-signed should not be blocked"
cleanup

# ----- pr-reviewer role deny tests -------------------------------------

# pr-reviewer run_hook helper: injects agent_type into the top-level payload.
run_hook_as_pr_reviewer() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local agent_type="${3:-tmb:pr-reviewer}"
  local payload
  payload=$(jq -cn --arg c "$cmd" --arg a "$agent_type" '{agent_type:$a,tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

test_case "pr-reviewer caller (tmb:pr-reviewer): git push BLOCKED with bro-owns-push message"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_as_pr_reviewer "git push origin main" "$db" "tmb:pr-reviewer")
assert_contains "$out" '"permissionDecision":"deny"' "pr-reviewer push must be blocked even with all-signed commits"
assert_contains "$out" "verdict row"  "block message must reference the verdict row"
assert_contains "$out" "bro"          "block message must state push decision belongs to bro"
cleanup

test_case "pr-reviewer caller (pr-reviewer): git push BLOCKED (bare agent_type variant)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_pr_reviewer "git push origin main" "/nonexistent.db" "pr-reviewer")
assert_contains "$out" '"permissionDecision":"deny"' "bare pr-reviewer agent_type must also be blocked"
cleanup

test_case "pr-reviewer caller: git push --force still exits early (force delegated to git-guards before role check)"
setup_repo
db=$(setup_db "$REPO_PATH")
out=$(run_hook_as_pr_reviewer "git push --force origin main" "$db" "tmb:pr-reviewer")
assert_not_contains "$out" '"permissionDecision":"deny"' "force push exits before role check (git-guards handles it)"
cleanup

test_case "bro caller (no agent_type): git push with all-signed NOT blocked by role check"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro/Human with all-signed commits must not be blocked by role check"
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
assert_contains "$out" '"permissionDecision":"deny"' "push from worktree cd prefix must block even without agent_type"
assert_contains "$out" ".claude/worktrees/" "block message must reference worktree path"
cleanup

test_case "push via 'git -C .claude/worktrees/...' flag: BLOCKED (no agent_type field)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
out=$(run_hook_from_worktree_cmd "git -C $REPO_PATH/.claude/worktrees/feat-x push origin feat/x" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "push via git -C worktree path must block"
cleanup

test_case "normal push from main checkout (no worktree in cmd): NOT blocked by worktree check"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_from_worktree_cmd "git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "normal push from main checkout must not be blocked by worktree check"
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
assert_not_contains "$out" '"permissionDecision":"deny"' \
  "cd to non-worktree path should override stale worktree PWD"
cleanup

test_case "PWD in worktree, plain 'git push' (no cd, no -C): BLOCKED via PWD fallback"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
mkdir -p "$REPO_PATH/.claude/worktrees/feat-x"
out=$(run_hook_with_pwd "git push origin main" "$db" "$REPO_PATH/.claude/worktrees/feat-x")
assert_contains "$out" '"permissionDecision":"deny"' \
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
assert_contains "$out" '"permissionDecision":"deny"' \
  "cd into worktree should block even when PWD is main"
cleanup

# ----- false-positive tests (IS_PUSH should NOT trigger) ----------------
#
# Commands that merely mention "git push" in a non-push context must not
# be blocked. These catch the over-broad glob patterns that matched any
# string containing "git push".

test_case "false-positive: grep for 'git push' in a file — NOT blocked"
setup_repo
out=$(run_hook "grep \"git push\" tests/l1-lint/something.sh")
assert_not_contains "$out" '"permissionDecision":"deny"' "grep for 'git push' must not be detected as a push"
cleanup

test_case "false-positive: echo mentioning 'git push' — NOT blocked"
setup_repo
out=$(run_hook "echo \"Don't forget to git push\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "echo mentioning 'git push' must not be detected as a push"
cleanup

test_case "false-positive: cat pipe grep for 'git push' — NOT blocked"
setup_repo
out=$(run_hook "cat docs/git-conventions.md | grep \"git push\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "cat|grep 'git push' must not be detected as a push"
cleanup

test_case "false-positive: git log --grep='git push' — NOT blocked"
setup_repo
out=$(run_hook "git log --grep=\"git push\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "git log --grep='git push' must not be detected as a push"
cleanup

test_case "false-positive: git commit -m mentioning 'git push' — NOT blocked"
setup_repo
out=$(run_hook "git commit -m \"fix: make git push idempotent\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "commit message mentioning 'git push' must not be detected as a push"
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
assert_contains "$out" '"permissionDecision":"deny"' "plain git push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'git -C /some/path push origin feature' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git -C /some/path push origin feature" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "git -C push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'cd /repo && git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "cd /repo && git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "cd && git push must be detected as a push and blocked for SWE"
cleanup

test_case "positive: 'git status; git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git status; git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "semicolon-separated git push must be detected and blocked for SWE"
cleanup

test_case "positive: 'make build || git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "make build || git push" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "|| git push must be detected as a push and blocked for SWE"
cleanup

# ----- #1016: whitespace-tolerant / wrapper-form push detection --------------
# The old literal `case` substrings failed OPEN (exit 0, no block) on these
# forms. The SWE-identity path gives a definitive BLOCK when IS_PUSH fires.

test_case "#1016: 'git  push' (double space) — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "git  push origin main" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "double-space git push must not fail open"
cleanup

test_case "#1016: leading-whitespace '   git push' — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe "   git push origin main" "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "leading-whitespace git push must not fail open"
cleanup

test_case "#1016: 'bash -c \"git push origin main\"' wrapper — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe 'bash -c "git push origin main"' "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "bash -c wrapped push must not fail open"
cleanup

test_case "#1016: 'eval \"git push origin main\"' wrapper — IS_PUSH triggers (SWE blocked)"
setup_repo
out=$(run_hook_as_swe 'eval "git push origin main"' "/nonexistent.db" "tmb:swe")
assert_contains "$out" '"permissionDecision":"deny"' "eval wrapped push must not fail open"
cleanup

test_case "#1016: double-space force push still delegated to git-guards (allowed here)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
out=$(run_hook "git  push  --force origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "double-space force push exits before the unsigned gate"
cleanup

test_case "#1016: false-positive — 'bash -c \"echo git push\"' is NOT a push"
setup_repo
out=$(run_hook_as_swe 'bash -c "echo git push done"' "/nonexistent.db" "tmb:swe")
assert_not_contains "$out" '"permissionDecision":"deny"' "echo of git push inside a wrapper must not fire"
cleanup

test_case "unreadable trajectory DB: push gate fails closed (tmb_gate_read __ERR__)"
setup_repo
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
chmod 000 "$db"
out=$(run_hook "git push origin main" "$db")
chmod 644 "$db"
assert_contains "$out" '"permissionDecision":"deny"' "DB read error must deny, not allow"
assert_contains "$out" "trajectory DB unavailable" "deny names the unavailable DB"
cleanup

# First push of a feature branch cut from dev: the repos row's target_branch
# (dev, read by tmb_repo_resolve) bounds the range to the signed feature
# commit. An empty read falls back to main and pulls in dev's unsigned commit.
setup_repo
db=$(setup_db "$REPO_PATH")
git -C "$REPO_PATH" checkout -q -b dev
git -C "$REPO_PATH" push -q origin dev
git -C "$REPO_PATH" checkout -q -b feat/wal
echo "feat C" > "$REPO_PATH/c.txt"
git -C "$REPO_PATH" add c.txt
git -C "$REPO_PATH" commit -qm "feat: C"
SHA3=$(git -C "$REPO_PATH" rev-parse HEAD)
insert_task "$db" 1 "$SHA2"
insert_task "$db" 3 "$SHA3"
sign_task   "$db" 3
sqlite3 "$db" "INSERT INTO repos (name, path, target_branch) VALUES ('wal', '$REPO_PATH', 'dev');"
out=$(run_hook "git push origin feat/wal" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "WAL fixture precondition: the push of the signed feature commit is allowed"
# The WAL cases log the sqlite3 CLI's invocations, so the TS gate reads through it.
[ "$HOOK_IMPL" != ts ] || export TMB_HOOKS_SQLITE=cli
wal_gate_cases "git-push-guard" "$HOOK" "$db" "$REPO_PATH" \
  "$(jq -cn '{tool_input:{command:"git push origin feat/wal"}}')" "" '"permissionDecision":"deny"' "$REPO_PATH"
unset TMB_HOOKS_SQLITE
cleanup

# ----- GH 1196: role from identity, dir from the command ----------------
# A real linked worktree; the payload cwd sits inside it (bro's persistent
# shell left there) while the command names the main checkout.

run_hook_payload() {
  local agent="$1" cwd="$2" cmd="$3" db="${4:-/nonexistent.db}" payload
  payload=$(jq -cn --arg a "$agent" --arg d "$cwd" --arg c "$cmd" \
    'if $a == "" then {cwd:$d,tool_input:{command:$c}} else {agent_type:$a,cwd:$d,tool_input:{command:$c}} end')
  (cd "$REPO_PATH" && printf '%s' "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

setup_repo_with_worktree() {
  setup_repo
  git -C "$REPO_PATH" branch feat/wt
  git -C "$REPO_PATH" worktree add -q "$REPO_PATH/.claude/worktrees/wt" feat/wt
  WT_PATH="$REPO_PATH/.claude/worktrees/wt"
}

test_case "GH 1196: bro 'git -C <main> push' with payload cwd inside a worktree → allowed"
setup_repo_with_worktree
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_payload "" "$WT_PATH" "git -C $REPO_PATH push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro pushing the main checkout by -C is not an SWE push nor a worktree push"
cleanup

test_case "GH 1196: bro 'cd <main> && git push' with payload cwd inside a worktree → allowed"
setup_repo_with_worktree
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
sign_task   "$db" 1
insert_task "$db" 2 "$SHA2"
sign_task   "$db" 2
out=$(run_hook_payload "" "$WT_PATH" "cd $REPO_PATH && git push origin main" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "the leading cd decides the dir"
cleanup

test_case "GH 1196: bro bare 'git push' while worktrees exist → ambiguous_git_target, not an SWE rule"
setup_repo_with_worktree
db=$(setup_db "$REPO_PATH")
out=$(run_hook_payload "" "$REPO_PATH" "git push origin main" "$db")
assert_contains "$out" "ambiguous_git_target" "the deny names the real reason"
assert_contains "$out" "git -C <path> or cd <path>" "the deny carries the remedy"
assert_not_contains "$out" "SWE must never push" "bro is never told an SWE rule"
cleanup

test_case "GH 1196: SWE push is denied by identity, whatever the dir"
setup_repo_with_worktree
out=$(run_hook_payload "swe" "$REPO_PATH" "git -C $REPO_PATH push origin main")
assert_contains "$out" "SWE must never push" "identity decides the role"
cleanup

test_case "GH 1196: a heredoc that writes markdown mentioning git push is not a push"
setup_repo_with_worktree
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "$SHA1"
HEREDOC_CMD=$(printf '%s\n' "cat > $WT_PATH/notes.md <<'EOF'" 'then git push origin main' 'EOF')
out=$(run_hook_payload "swe" "$REPO_PATH" "$HEREDOC_CMD" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "heredoc content is data"
cleanup

# ----- GH 1518: rebased task commits need a verification run ------------
# feat/r holds task 5's reviewed commit RSHA, cut from origin/main. feat/r-rebased
# replays it onto main (SHA1, SHA2): REBASED has RSHA's patch-id but is no
# task's commit_sha. feat/other holds an unrelated commit on main.

setup_rebased_repo() {
  setup_repo
  db=$(setup_db "$REPO_PATH")
  git -C "$REPO_PATH" checkout -q -b feat/r origin/main
  echo "feat R" > "$REPO_PATH/r.txt"
  git -C "$REPO_PATH" add r.txt
  git -C "$REPO_PATH" commit -qm "feat: R"
  RSHA=$(git -C "$REPO_PATH" rev-parse HEAD)
  git -C "$REPO_PATH" checkout -q -b feat/r-rebased main
  git -C "$REPO_PATH" cherry-pick "$RSHA" >/dev/null
  REBASED=$(git -C "$REPO_PATH" rev-parse HEAD)
  git -C "$REPO_PATH" checkout -q -b feat/other main
  echo "other" > "$REPO_PATH/o.txt"
  git -C "$REPO_PATH" add o.txt
  git -C "$REPO_PATH" commit -qm "feat: other"
  insert_task "$db" 5 "$RSHA"
  sign_task   "$db" 5
}

record_run() {
  local db="$1" sha="$2" rc="$3"
  sqlite3 "$db" "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s)
    VALUES (5, '$sha', 'manual', '2026-10-19T00:00:00.000Z', '2026-10-19T00:01:00.000Z', $rc, 900);" >/dev/null
}

test_case "GH 1518: the reviewed task commit itself → allowed"
setup_rebased_repo
git -C "$REPO_PATH" checkout -q feat/r
out=$(run_hook "git push origin feat/r" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "the reviewed SHA is covered by its review"
cleanup

test_case "GH 1518: an integrated rebase (passing run on its SHA) → allowed"
setup_rebased_repo
record_run "$db" "$REBASED" 0
git -C "$REPO_PATH" checkout -q feat/r-rebased
out=$(run_hook "git push origin feat/r-rebased" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "a rebased SHA with a passing verification run ships"
cleanup

test_case "GH 1518: a rebased SHA with the reviewed patch-id and no run → BLOCKED"
setup_rebased_repo
git -C "$REPO_PATH" checkout -q feat/r-rebased
out=$(run_hook "git push origin feat/r-rebased" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "an unverified rebase must block"
assert_contains "$out" "$REBASED" "the deny names the rebased SHA"
assert_contains "$out" "task_id=5" "the deny names the reviewed task"
assert_contains "$out" "integrate.sh" "the deny points at integrate.sh"
cleanup

test_case "GH 1518: a rebased SHA whose only run failed → BLOCKED"
setup_rebased_repo
record_run "$db" "$REBASED" 1
git -C "$REPO_PATH" checkout -q feat/r-rebased
out=$(run_hook "git push origin feat/r-rebased" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "a failing run does not cover the rebase"
cleanup

test_case "GH 1518: an unrelated commit beside a reviewed task → allowed"
setup_rebased_repo
git -C "$REPO_PATH" checkout -q feat/other
out=$(run_hook "git push origin feat/other" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "a commit matching no reviewed patch-id keeps today's behaviour"
cleanup

test_case "GH 1518: a rebase of an unreviewed task's commit → BLOCKED even with a passing run"
setup_rebased_repo
sqlite3 "$db" "DELETE FROM validation_attempts WHERE task_id = 5;" >/dev/null
record_run "$db" "$REBASED" 0
git -C "$REPO_PATH" checkout -q feat/r-rebased
out=$(run_hook "git push origin feat/r-rebased" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "an unreviewed task's rebased commit must block"
assert_contains "$out" "$REBASED" "the deny names the rebased SHA"
assert_contains "$out" "task_id=5" "the deny names the task"
assert_contains "$out" "no passing review" "the deny says the task is unreviewed"
cleanup

test_case "GH 1518: a rebase matching a reviewed and an unreviewed task is judged by the reviewed one"
setup_rebased_repo
git -C "$REPO_PATH" checkout -q -b feat/r-again origin/main
git -C "$REPO_PATH" cherry-pick "$RSHA" >/dev/null
git -C "$REPO_PATH" commit -q --amend -m "feat: R again"
insert_task "$db" 4 "$(git -C "$REPO_PATH" rev-parse HEAD)"
record_run "$db" "$REBASED" 0
git -C "$REPO_PATH" checkout -q feat/r-rebased
out=$(run_hook "git push origin feat/r-rebased" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "the reviewed task's integrated rebase ships"
cleanup

summarize
