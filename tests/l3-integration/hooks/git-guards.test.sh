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
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-guards.sh"

run_hook() {
  (cd "$PLUGIN_ROOT" && echo "$1" | TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" 2>&1 || true)
}

test_case "no config (fresh install) is non-blocking for commits"
out=$(run_hook '{"tool_input":{"command":"git commit -m test"}}')
assert_not_contains "$out" '"permissionDecision":"block"' "should NOT block on fresh install"

test_case "non-git command passes through"
out=$(run_hook '{"tool_input":{"command":"ls -la"}}')
assert_not_contains "$out" '"permissionDecision":"block"' "ls should not fire hook"

test_case "git status is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git status"}}')
assert_not_contains "$out" '"permissionDecision":"block"' "git status should pass"

test_case "git log is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git log --oneline -5"}}')
assert_not_contains "$out" '"permissionDecision":"block"' "git log should pass"

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
assert_contains "$out" '"permissionDecision":"block"' "commit on protected main must block"
cleanup_repo

test_case "v0.3.2: 'cd .claude/worktrees/task-1 && git commit' is ALLOWED (worktree on feature branch)"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"block"' "commit from worktree on feat/cli-todo must pass"
cleanup_repo

test_case "v0.3.2: 'cd /abs/path/worktree && git commit' (absolute path) is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"block"' "absolute-path cd should also work"
cleanup_repo

test_case "v0.3.2: 'cd <main-worktree> && git commit' STILL blocks (cd to root + commit on main)"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH && git commit -m 'broken'")
assert_contains "$out" '"permissionDecision":"block"' "cd to root then commit on main should still block"
cleanup_repo

test_case "v0.3.2: 'git -C <worktree> commit' is ALLOWED (git -C path syntax)"
setup_worktree_repo
out=$(run_hook_in_repo "git -C .claude/worktrees/task-1 commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"block"' "git -C <worktree> commit should pass"
cleanup_repo

test_case "v0.3.2: 'git checkout -b' from worktree on feature branch is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git checkout -b feat/sub-task")
# Note: rule 4 still requires being on PR_TARGET to create new branches.
# From the worktree we're on feat/cli-todo, NOT on main — so this should block.
# This test confirms the worktree-aware lookup correctly identifies feat/cli-todo.
assert_contains "$out" '"permissionDecision":"block"' "rule 4 must see feat/cli-todo (not main) and block since not on PR_TARGET"
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
assert_not_contains "$out" '"permissionDecision":"block"' "detached worktree on feature branch must not block"
cleanup_repo

test_case "v0.3.3: detached-HEAD worktree with no DB match: commit allowed (fail-open)"
setup_detached_worktree_repo
# Remove the task row so DB lookup finds nothing — hook should fail-open (no block).
sqlite3 "$REPO_PATH/.claude/tmb/trajectory.db" "DELETE FROM tasks WHERE id=1;" >/dev/null
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/cli-todo && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"block"' "no DB match must not block (fail-open)"
cleanup_repo

test_case "injection: worktree basename with a single quote neither errors nor blocks"
# The slug feeds the Rule-2 DB lookup (branch_id LIKE '%/<slug>'). A quote in
# the basename must be escaped via tmb_sql_quote — the lookup still resolves
# feat/o'brien-cli (non-protected) and the hook stays silent.
dir=$(mktemp -d -t tmb-guards-quote-XXXX)
(
  cd "$dir" || exit 1
  git init -q -b main
  git config user.email t@t.t
  git config user.name T
  echo init > README.md
  git add . && git commit -qm init
  git branch "feat/o'brien-cli" HEAD
  git worktree add -q --detach ".claude/worktrees/o'brien-cli"
  mkdir -p .claude/tmb
  sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  sqlite3 .claude/tmb/trajectory.db "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
      VALUES (1, 1, 'feat/o''brien-cli', 'test task', 'd', 'pending', '', datetime('now'), datetime('now'));
  " >/dev/null
)
REPO_PATH="$dir"
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/o'brien-cli && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"block"' "quote-bearing slug must not block the feature-branch commit"
assert_eq "" "$out" "quote-bearing slug must produce no output (no errors)"
cleanup_repo

# ---- #347: Rule 3 force-push token matching ---------------------------------
# git push origin main --follow-tags must NOT block (--follow-tags is not a force flag).
# git push origin main && rm -f /tmp/x must NOT block (-f is outside the push clause).
# git push -f origin main MUST block.

test_case "#347: git push --follow-tags is NOT a force push (must pass)"
setup_worktree_repo
out=$(run_hook_in_repo "git push origin main --follow-tags")
assert_not_contains "$out" '"permissionDecision":"block"' "--follow-tags must not trigger force-push block"
cleanup_repo

test_case "#347: compound command with -f AFTER push clause is NOT a force push"
setup_worktree_repo
out=$(run_hook_in_repo "git push origin main && rm -f /tmp/x")
assert_not_contains "$out" '"permissionDecision":"block"' "rm -f after && must not trigger force-push block"
cleanup_repo

test_case "#347: git push -f to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push -f origin main")
assert_contains "$out" '"permissionDecision":"block"' "git push -f to main must block"
cleanup_repo

test_case "#347: git push --force to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push --force origin main")
assert_contains "$out" '"permissionDecision":"block"' "git push --force to main must block"
cleanup_repo

test_case "#347: git push --force-with-lease to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push --force-with-lease origin main")
assert_contains "$out" '"permissionDecision":"block"' "git push --force-with-lease to main must block"
cleanup_repo

# ---- #319: Rule 2 word-boundary subcommand matching -------------------------
# git commit-tree and commit-graph are plumbing and must NOT be blocked.
# "git commit" inside argument text (e.g. --body) must NOT be blocked.
# git merge onto a protected branch MUST be blocked.
# git rebase onto a protected branch MUST be blocked.

test_case "#319: git commit-tree plumbing is NOT blocked (word-boundary matching)"
setup_worktree_repo
out=$(run_hook_in_repo "git commit-tree abc123")
assert_not_contains "$out" '"permissionDecision":"block"' "commit-tree plumbing must not block"
cleanup_repo

test_case "#319: 'git commit' inside --body argument text is NOT blocked"
setup_worktree_repo
out=$(run_hook_in_repo "gh issue create --body 'run git commit to apply'")
assert_not_contains "$out" '"permissionDecision":"block"' "git commit in arg text must not block"
cleanup_repo

test_case "#319: git merge onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git merge feat/cli")
assert_contains "$out" '"permissionDecision":"block"' "git merge on main must block"
cleanup_repo

test_case "#319: git rebase onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git rebase feat/cli")
assert_contains "$out" '"permissionDecision":"block"' "git rebase on main must block"
cleanup_repo

test_case "#319: git cherry-pick onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git cherry-pick abc123")
assert_contains "$out" '"permissionDecision":"block"' "git cherry-pick on main must block"
cleanup_repo

# ---- early-exit word boundary: separators without spaces ---------------------
# 'foo;git commit' and 'echo y&&git commit' must reach Rule 2 (the early-exit
# must not require whitespace before git/gh), while 'legit' must not match.

test_case "early-exit: 'foo;git commit -m x' on protected branch IS blocked (; separator, no space)"
setup_worktree_repo
out=$(run_hook_in_repo "foo;git commit -m x")
assert_contains "$out" '"permissionDecision":"block"' "semicolon-joined git commit on main must block"
cleanup_repo

test_case "early-exit: 'echo y&&git commit' on protected branch IS blocked (&& separator, no space)"
setup_worktree_repo
out=$(run_hook_in_repo "echo y&&git commit -m x")
assert_contains "$out" '"permissionDecision":"block"' "&&-joined git commit on main must block"
cleanup_repo

test_case "early-exit: 'legit foo' does NOT match the git/gh word boundary"
out=$(run_hook '{"tool_input":{"command":"legit foo"}}')
assert_eq "" "$out" "legit must early-exit with no output"

# ---- generated separator × subcommand boundary matrix ----------------------
# Each separator joined to each dangerous subcommand on a protected branch
# MUST be blocked. Hand-enumeration is error-prone (B3 incident: ';git' was
# missed); loop generation ensures full coverage.
#
# Separators tested: bare (no prefix), ';', '&&', '||', '|', '$(' , newline.
# Subcommands:       commit, merge, rebase, cherry-pick, push -f.
# Additionally: non-git lookalikes (legit, github, .git paths) × same
# separators MUST be allowed — word-boundary matching must not over-fire.

setup_worktree_repo

# Shell statement-start separators that Rule 2 currently enforces.
# Single '|' (pipe) and '$(' (subshell) are NOT included here — the hook's
# _rule2_match only recognises &&, ||, ; and ^ as statement-start signals;
# pipe and subshell composition are known gaps documented in the issue tracker.
SEPARATORS=("" ";" "&&" "||")

SUBCOMMANDS=(
  "commit -m x"
  "merge feat/other"
  "rebase main"
  "cherry-pick abc123"
  "push -f origin main"
)

# Newline is handled separately because shell arrays can't embed literal newlines cleanly.

for sep in "${SEPARATORS[@]}"; do
  for sub in "${SUBCOMMANDS[@]}"; do
    if [ -z "$sep" ]; then
      cmd="git $sub"
    else
      cmd="echo prefix${sep}git $sub"
    fi
    test_case "matrix deny: separator='${sep}' subcommand='${sub}'"
    out=$(run_hook_in_repo "$cmd")
    assert_contains "$out" '"permissionDecision":"block"' "must block: $cmd"
  done
done

# Newline separator: 'echo x\ngit commit' — newline joins must also block.
for sub in "${SUBCOMMANDS[@]}"; do
  cmd="$(printf 'echo prefix\ngit %s' "$sub")"
  test_case "matrix deny: separator=newline subcommand='${sub}'"
  out=$(run_hook_in_repo "$cmd")
  assert_contains "$out" '"permissionDecision":"block"' "must block newline-joined: git $sub"
done

# Non-git lookalikes × separators MUST allow (word-boundary must not over-fire).
# 'legit' and 'github' are common false-positive candidates.
# '.git/hooks/...' path references must not fire either.
LOOKALIKES=(
  "legit commit -m x"
  "github.com/repo"
  "ls .git/hooks"
  "cat .git/config"
)

# Extend lookalike separators with | and $( — these are not in the deny matrix
# but must still allow for non-git-lookalike commands.
ALL_SEP=("" ";" "&&" "||" "|" "\$(")

for sep in "${ALL_SEP[@]}"; do
  for lookalike in "${LOOKALIKES[@]}"; do
    if [ -z "$sep" ]; then
      cmd="$lookalike"
    else
      cmd="echo prefix${sep}${lookalike}"
    fi
    test_case "matrix allow: separator='${sep}' lookalike='${lookalike}'"
    out=$(run_hook_in_repo "$cmd")
    assert_not_contains "$out" '"permissionDecision":"block"' "must allow: $cmd"
  done
done

# Newline separator for lookalikes.
for lookalike in "${LOOKALIKES[@]}"; do
  cmd="$(printf 'echo prefix\n%s' "$lookalike")"
  test_case "matrix allow: separator=newline lookalike='${lookalike}'"
  out=$(run_hook_in_repo "$cmd")
  assert_not_contains "$out" '"permissionDecision":"block"' "must allow newline-joined: $lookalike"
done

cleanup_repo

summarize
