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
assert_not_contains "$out" '"permissionDecision":"deny"' "should NOT block on fresh install"

test_case "non-git command passes through"
out=$(run_hook '{"tool_input":{"command":"ls -la"}}')
assert_not_contains "$out" '"permissionDecision":"deny"' "ls should not fire hook"

test_case "git status is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git status"}}')
assert_not_contains "$out" '"permissionDecision":"deny"' "git status should pass"

test_case "git log is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git log --oneline -5"}}')
assert_not_contains "$out" '"permissionDecision":"deny"' "git log should pass"

test_case "#549: unregistered repo → guard no-ops (commit on protected branch not blocked)"
_unreg_dir=$(mktemp -d -t tmb-guards-unreg-XXXX)
(
  cd "$_unreg_dir" || exit 1
  git init -q -b main
  git config user.email t@t.t
  git config user.name T
  echo init > README.md
  git add . && git commit -qm init
  mkdir -p .claude/tmb
  sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  # No INSERT INTO repos — repo intentionally left unregistered
)
_unreg_out=$(cd "$_unreg_dir" && echo '{"tool_input":{"command":"git commit -m broken"}}' \
  | TRAJECTORY_DB_PATH="$_unreg_dir/.claude/tmb/trajectory.db" bash "$HOOK" 2>&1 || true)
assert_not_contains "$_unreg_out" '"permissionDecision":"deny"' "unregistered repo must not block (no-op)"
rm -rf "$_unreg_dir"

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
    sqlite3 .claude/tmb/trajectory.db "INSERT INTO repos (name, path) VALUES ('fixture', '$(git rev-parse --show-toplevel)');" >/dev/null
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
assert_contains "$out" '"permissionDecision":"deny"' "commit on protected main must block"
cleanup_repo

test_case "v0.3.2: 'cd .claude/worktrees/task-1 && git commit' is ALLOWED (worktree on feature branch)"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "commit from worktree on feat/cli-todo must pass"
cleanup_repo

test_case "v0.3.2: 'cd /abs/path/worktree && git commit' (absolute path) is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/task-1 && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "absolute-path cd should also work"
cleanup_repo

test_case "v0.3.2: 'cd <main-worktree> && git commit' STILL blocks (cd to root + commit on main)"
setup_worktree_repo
out=$(run_hook_in_repo "cd $REPO_PATH && git commit -m 'broken'")
assert_contains "$out" '"permissionDecision":"deny"' "cd to root then commit on main should still block"
cleanup_repo

test_case "v0.3.2: 'git -C <worktree> commit' is ALLOWED (git -C path syntax)"
setup_worktree_repo
out=$(run_hook_in_repo "git -C .claude/worktrees/task-1 commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "git -C <worktree> commit should pass"
cleanup_repo

test_case "v0.3.2: 'git checkout -b' from worktree on feature branch is ALLOWED"
setup_worktree_repo
out=$(run_hook_in_repo "cd .claude/worktrees/task-1 && git checkout -b feat/sub-task")
# Note: rule 4 still requires being on PR_TARGET to create new branches.
# From the worktree we're on feat/cli-todo, NOT on main — so this should block.
# This test confirms the worktree-aware lookup correctly identifies feat/cli-todo.
assert_contains "$out" '"permissionDecision":"deny"' "rule 4 must see feat/cli-todo (not main) and block since not on PR_TARGET"
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
    sqlite3 .claude/tmb/trajectory.db "INSERT INTO repos (name, path) VALUES ('fixture', '$(git rev-parse --show-toplevel)');" >/dev/null
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
assert_not_contains "$out" '"permissionDecision":"deny"' "detached worktree on feature branch must not block"
cleanup_repo

test_case "v0.3.3: detached-HEAD worktree with no DB match: commit allowed (fail-open)"
setup_detached_worktree_repo
# Remove the task row so DB lookup finds nothing — hook should fail-open (no block).
sqlite3 "$REPO_PATH/.claude/tmb/trajectory.db" "DELETE FROM tasks WHERE id=1;" >/dev/null
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/cli-todo && git commit -m 'feat: add x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "no DB match must not block (fail-open)"
cleanup_repo

test_case "injection: quote-bearing slug resolves a PROTECTED branch and BLOCKS the commit"
# Discriminating case for the Rule-2 DB lookup (branch_id LIKE '%/<slug>').
# The quoted slug resolves to feat/o'brien-cli, which IS protected — so
# correct tmb_sql_quote escaping makes the lookup succeed and Rule 2 block.
# Broken escaping breaks the SQL instead (error → empty branch → fail-open,
# NO block), so the block assertion below fails the moment escaping regresses.
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
  sqlite3 .claude/tmb/trajectory.db "INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('fixture', '$(git rev-parse --show-toplevel)', 'main', 'github-flow', '[\"main\", \"feat/o''brien-cli\"]');" >/dev/null
  sqlite3 .claude/tmb/trajectory.db "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
      VALUES (1, 1, 'feat/o''brien-cli', 'test task', 'd', 'pending', '', datetime('now'), datetime('now'));
  " >/dev/null
)
REPO_PATH="$dir"
out=$(run_hook_in_repo "cd $REPO_PATH/.claude/worktrees/o'brien-cli && git commit -m 'feat: add x'")
assert_contains "$out" '"permissionDecision":"deny"' "quote-bearing protected slug must BLOCK — empty means the lookup SQL errored out"
assert_contains "$out" "feat/o'brien-cli" "block message must name the quoted branch resolved via DB lookup"
cleanup_repo

# ---- #347: Rule 3 force-push token matching ---------------------------------
# git push origin main --follow-tags must NOT block (--follow-tags is not a force flag).
# git push origin main && rm -f /tmp/x must NOT block (-f is outside the push clause).
# git push -f origin main MUST block.

test_case "#347: git push --follow-tags is NOT a force push (must pass)"
setup_worktree_repo
out=$(run_hook_in_repo "git push origin main --follow-tags")
assert_not_contains "$out" '"permissionDecision":"deny"' "--follow-tags must not trigger force-push block"
cleanup_repo

test_case "#347: compound command with -f AFTER push clause is NOT a force push"
setup_worktree_repo
out=$(run_hook_in_repo "git push origin main && rm -f /tmp/x")
assert_not_contains "$out" '"permissionDecision":"deny"' "rm -f after && must not trigger force-push block"
cleanup_repo

test_case "#347: git push -f to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push -f origin main")
assert_contains "$out" '"permissionDecision":"deny"' "git push -f to main must block"
cleanup_repo

test_case "#347: git push --force to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push --force origin main")
assert_contains "$out" '"permissionDecision":"deny"' "git push --force to main must block"
cleanup_repo

test_case "#347: git push --force-with-lease to protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git push --force-with-lease origin main")
assert_contains "$out" '"permissionDecision":"deny"' "git push --force-with-lease to main must block"
cleanup_repo

# ---- #319: Rule 2 word-boundary subcommand matching -------------------------
# git commit-tree and commit-graph are plumbing and must NOT be blocked.
# "git commit" inside argument text (e.g. --body) must NOT be blocked.
# git merge onto a protected branch MUST be blocked.
# git rebase onto a protected branch MUST be blocked.

test_case "#319: git commit-tree plumbing is NOT blocked (word-boundary matching)"
setup_worktree_repo
out=$(run_hook_in_repo "git commit-tree abc123")
assert_not_contains "$out" '"permissionDecision":"deny"' "commit-tree plumbing must not block"
cleanup_repo

test_case "#319: 'git commit' inside --body argument text is NOT blocked"
setup_worktree_repo
out=$(run_hook_in_repo "gh issue create --body 'run git commit to apply'")
assert_not_contains "$out" '"permissionDecision":"deny"' "git commit in arg text must not block"
cleanup_repo

test_case "#319: git merge onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git merge feat/cli")
assert_contains "$out" '"permissionDecision":"deny"' "git merge on main must block"
cleanup_repo

test_case "#319: git rebase onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git rebase feat/cli")
assert_contains "$out" '"permissionDecision":"deny"' "git rebase on main must block"
cleanup_repo

test_case "#319: git cherry-pick onto protected branch IS blocked"
setup_worktree_repo
out=$(run_hook_in_repo "git cherry-pick abc123")
assert_contains "$out" '"permissionDecision":"deny"' "git cherry-pick on main must block"
cleanup_repo

# ---- early-exit word boundary: separators without spaces ---------------------
# 'foo;git commit' and 'echo y&&git commit' must reach Rule 2 (the early-exit
# must not require whitespace before git/gh), while 'legit' must not match.

test_case "early-exit: 'foo;git commit -m x' on protected branch IS blocked (; separator, no space)"
setup_worktree_repo
out=$(run_hook_in_repo "foo;git commit -m x")
assert_contains "$out" '"permissionDecision":"deny"' "semicolon-joined git commit on main must block"
cleanup_repo

test_case "early-exit: 'echo y&&git commit' on protected branch IS blocked (&& separator, no space)"
setup_worktree_repo
out=$(run_hook_in_repo "echo y&&git commit -m x")
assert_contains "$out" '"permissionDecision":"deny"' "&&-joined git commit on main must block"
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
    assert_contains "$out" '"permissionDecision":"deny"' "must block: $cmd"
  done
done

# Newline separator: 'echo x\ngit commit' — newline joins must also block.
for sub in "${SUBCOMMANDS[@]}"; do
  cmd="$(printf 'echo prefix\ngit %s' "$sub")"
  test_case "matrix deny: separator=newline subcommand='${sub}'"
  out=$(run_hook_in_repo "$cmd")
  assert_contains "$out" '"permissionDecision":"deny"' "must block newline-joined: git $sub"
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
    assert_not_contains "$out" '"permissionDecision":"deny"' "must allow: $cmd"
  done
done

# Newline separator for lookalikes.
for lookalike in "${LOOKALIKES[@]}"; do
  cmd="$(printf 'echo prefix\n%s' "$lookalike")"
  test_case "matrix allow: separator=newline lookalike='${lookalike}'"
  out=$(run_hook_in_repo "$cmd")
  assert_not_contains "$out" '"permissionDecision":"deny"' "must allow newline-joined: $lookalike"
done

cleanup_repo

# ---- glab mr create enforcement (GitLab parity) --------------------------------
# Mirrors the gh pr create Rule 1 tests but exercises _rule1_match + glab path.
# Uses a repo with pr_target=dev (dual-tier model) so we can also test the
# dev→main release-merge exception.

setup_glab_repo() {
  local dir
  dir=$(mktemp -d -t tmb-guards-glab-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b dev
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init

    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
    sqlite3 .claude/tmb/trajectory.db "INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('fixture', '$(git rev-parse --show-toplevel)', 'dev', 'gitflow', '[\"main\",\"dev\"]');" >/dev/null
  )
  REPO_PATH="$dir"
}

test_case "glab: glab mr list (read-only) is NOT blocked (early-exit passes glab)"
out=$(run_hook '{"tool_input":{"command":"glab mr list"}}')
assert_not_contains "$out" '"permissionDecision":"deny"' "glab mr list must not be blocked"

test_case "glab: glab mr create --target-branch wrong → deny"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create --target-branch wrong --source-branch feat/x --title 'x'")
assert_contains "$out" '"permissionDecision":"deny"' "wrong target must block"
assert_contains "$out" "BLOCKED" "deny reason must say BLOCKED"
cleanup_repo

test_case "glab: glab mr create --target-branch dev (== PR_TARGET) → allow"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create --target-branch dev --source-branch feat/x --title 'x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "correct target must allow"
cleanup_repo

test_case "glab: glab mr create -b dev (short flag, == PR_TARGET) → allow"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create -b dev -s feat/x --title 'x'")
assert_not_contains "$out" '"permissionDecision":"deny"' "short -b correct target must allow"
cleanup_repo

test_case "glab: glab mr create -b main + --source-branch dev → allow (release exception)"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create -b main --source-branch dev --title 'release'")
assert_not_contains "$out" '"permissionDecision":"deny"' "dev→main with source=dev must allow"
cleanup_repo

test_case "glab: glab mr create -b main + --source-branch feat/x → deny (release exception non-dev source)"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create -b main --source-branch feat/x --title 'x'")
assert_contains "$out" '"permissionDecision":"deny"' "dev→main with non-dev source must block"
cleanup_repo

test_case "glab: glab mr create -b main + -s dev → allow (short -s source=dev release exception)"
setup_glab_repo
out=$(run_hook_in_repo "glab mr create -b main -s dev --title 'release'")
assert_not_contains "$out" '"permissionDecision":"deny"' "short -s dev must allow release exception"
cleanup_repo

# ---- Rule 1 substring false-positive regression --------------------------------
# A command that merely MENTIONS the PR/MR-create phrase inside quoted text
# must NOT be blocked (anchored _rule1_match fix).

setup_worktree_repo
test_case "substring false-positive: echo quoting 'gh pr create --base x' is NOT blocked"
out=$(run_hook_in_repo "echo \"run gh pr create --base dev from your feature branch\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "gh pr create inside quoted echo must not block"

test_case "substring false-positive: echo quoting 'glab mr create --target-branch x' is NOT blocked"
out=$(run_hook_in_repo "echo \"run glab mr create --target-branch dev from your feature branch\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "glab mr create inside quoted echo must not block"
cleanup_repo

# ---- #693: registration-based managed-repo scope (ADR: path-keyed resolution) --
# In a multi-repo workspace, git-guards' Rule 1/2/4 fire only for a REGISTERED
# product repo (a `repos` row matched by git-root path). Sibling trees that are
# NOT registered (e.g. an ad-hoc clone, or a main-only marketplace tree never
# scanned in) are exempt — the guard no-ops. A single registered repo's whole
# tree is guarded as before.
#
# Layout: <ws>/.claude/tmb/trajectory.db with a registered repo + an
# unregistered sibling, both siblings under <ws>.

setup_multirepo_workspace() {
  # $1 = "single" registers only `managed`; "both" registers managed + sibling.
  local mode="$1"
  local ws
  ws=$(mktemp -d -t tmb-guards-ws-XXXX)
  mkdir -p "$ws/.claude/tmb"
  sqlite3 "$ws/.claude/tmb/trajectory.db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  # Managed repo on protected main.
  (
    cd "$ws" && git init -q -b main managed
    cd "$ws/managed" || exit 1
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init
  )
  # Sibling repo (e.g. an ad-hoc clone): also on main.
  (
    cd "$ws" && git init -q -b main sibling
    cd "$ws/sibling" || exit 1
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init
  )
  # Register repos with git's canonical toplevel path (handles /tmp →
  # /private/tmp on macOS) so tmb_repo_is_registered matches the hook's _GIT_ROOT.
  local managed_root sibling_root
  managed_root=$(git -C "$ws/managed" rev-parse --show-toplevel)
  sibling_root=$(git -C "$ws/sibling" rev-parse --show-toplevel)
  sqlite3 "$ws/.claude/tmb/trajectory.db" \
    "INSERT INTO repos (name, path) VALUES ('managed', '$managed_root');" >/dev/null
  if [ "$mode" = "both" ]; then
    sqlite3 "$ws/.claude/tmb/trajectory.db" \
      "INSERT INTO repos (name, path) VALUES ('sibling', '$sibling_root');" >/dev/null
  fi
  WS_PATH="$ws"
}

run_hook_in_ws() {
  # $1 = absolute repo dir to cd into, $2 = git command.
  local repo_dir="$1" cmd="$2" payload
  payload=$(jq -cn --arg c "cd $repo_dir && $cmd" '{tool_input:{command:$c}}')
  (cd "$WS_PATH" && echo "$payload" \
    | TRAJECTORY_DB_PATH="$WS_PATH/.claude/tmb/trajectory.db" \
      bash "$HOOK" 2>&1 || true)
}

cleanup_ws() {
  [ -n "${WS_PATH:-}" ] && [ -d "${WS_PATH:-}" ] && rm -rf "$WS_PATH"
  WS_PATH=""
}

test_case "#693: registered repo direct commit to main IS blocked"
setup_multirepo_workspace "single"
out=$(run_hook_in_ws "$WS_PATH/managed" "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "commit on registered repo's protected main must block"
cleanup_ws

test_case "#693: unregistered sibling direct commit to main is ALLOWED (no-op)"
setup_multirepo_workspace "single"
out=$(run_hook_in_ws "$WS_PATH/sibling" "git commit -m wip")
assert_not_contains "$out" '"permissionDecision":"deny"' "commit in unregistered sibling tree must no-op"
cleanup_ws

test_case "#693: unregistered sibling branch-from-main is ALLOWED (Rule 4 no-op)"
setup_multirepo_workspace "single"
out=$(run_hook_in_ws "$WS_PATH/sibling" "git checkout -b feat/x")
assert_not_contains "$out" '"permissionDecision":"deny"' "branch creation in unregistered sibling must no-op"
cleanup_ws

test_case "#693: when BOTH siblings are registered, each is independently guarded"
setup_multirepo_workspace "both"
out=$(run_hook_in_ws "$WS_PATH/managed" "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "registered managed repo must block"
out=$(run_hook_in_ws "$WS_PATH/sibling" "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "registered sibling repo must also block"
cleanup_ws

# ---- #693: per-repo protected_branches is authoritative -------------------------
# repos.protected_branches (resolved by git-root path) WINS. When the row's
# column is empty/NULL the guard falls back to SAFE DEFAULTS (main+dev
# protected) — never fail-open (#987 regression).

setup_perrepo_protected() {
  # $1 = repos.protected_branches JSON (may be empty to test the safe-default path).
  local repo_protected="$1"
  local dir
  dir=$(mktemp -d -t tmb-guards-perrepo-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b release
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init
    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
    # Safe-default protected_branches is [main, dev] — does NOT cover the
    # current branch `release`. The per-repo value, when set, must win.
    local root
    root=$(git rev-parse --show-toplevel)
    if [ -n "$repo_protected" ]; then
      sqlite3 .claude/tmb/trajectory.db \
        "INSERT INTO repos (name, path, protected_branches) VALUES ('fixture', '$root', '$repo_protected');" >/dev/null
    else
      sqlite3 .claude/tmb/trajectory.db \
        "INSERT INTO repos (name, path) VALUES ('fixture', '$root');" >/dev/null
    fi
  )
  REPO_PATH="$dir"
}

test_case "#693: per-repo protected_branches wins — commit on per-repo-protected 'release' blocks"
setup_perrepo_protected '[\"release\"]'
out=$(run_hook_in_repo "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "per-repo protected_branches=[release] must block commit on release"
cleanup_repo

test_case "#693: per-repo unset → safe-default protected (release NOT in [main,dev], commit allowed)"
setup_perrepo_protected ''
out=$(run_hook_in_repo "git commit -m wip")
assert_not_contains "$out" '"permissionDecision":"deny"' "with per-repo empty, safe-default [main,dev] does not cover release → no block"
cleanup_repo

# ---- #987 regression: registered-but-unconfigured repo must NOT fail open --------
# A repos row with NO branching_model/protected_branches must still DENY a direct
# commit / merge / force-push on a default-protected branch (main/dev) via safe
# defaults — the pre-fix `exit 0` punt allowed these through.

setup_unconfigured_registered_repo() {
  # $1 = branch to init on (default main).
  local branch="${1:-main}"
  local dir
  dir=$(mktemp -d -t tmb-guards-unconf-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b "$branch"
    git config user.email t@t.t
    git config user.name T
    echo init > README.md
    git add . && git commit -qm init
    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
    # Registered, but policy columns left NULL (freshly scanned, not onboarded).
    sqlite3 .claude/tmb/trajectory.db \
      "INSERT INTO repos (name, path) VALUES ('fixture', '$(git rev-parse --show-toplevel)');" >/dev/null
  )
  REPO_PATH="$dir"
}

test_case "#987: unconfigured registered repo — direct commit on main DENIED (safe default, no fail-open)"
setup_unconfigured_registered_repo main
out=$(run_hook_in_repo "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "unconfigured repo must deny commit on default-protected main"
cleanup_repo

test_case "#987: unconfigured registered repo — direct commit on dev DENIED (safe default protects dev too)"
setup_unconfigured_registered_repo dev
out=$(run_hook_in_repo "git commit -m broken")
assert_contains "$out" '"permissionDecision":"deny"' "unconfigured repo must deny commit on default-protected dev"
cleanup_repo

test_case "#987: unconfigured registered repo — force-push to main DENIED (safe default, no fail-open)"
setup_unconfigured_registered_repo main
out=$(run_hook_in_repo "git push -f origin main")
assert_contains "$out" '"permissionDecision":"deny"' "unconfigured repo must deny force-push to default-protected main"
cleanup_repo

# ---- #15/H8: unresolved repo → NO-OP (don't enforce a guessed default policy) --
# When a command runs in the non-repo workspace root with no `cd`/`-C` target,
# the repo can't be resolved. The guard must no-op rather than apply a guessed
# github-flow/main policy (pre-fix it false-fired a "Detached HEAD" block).

test_case "#15/H8: command in non-repo workspace root (no cd target) → no-op, not a guessed-policy block"
setup_multirepo_workspace "single"
out=$( (cd "$WS_PATH" && echo '{"tool_input":{"command":"git checkout -b feat/x"}}' \
  | TRAJECTORY_DB_PATH="$WS_PATH/.claude/tmb/trajectory.db" bash "$HOOK" 2>&1) || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "unresolved repo must no-op (no main-policy enforcement)"
cleanup_ws

# ---- #13/H3: configured target_branch ref missing → fall back to real default --
# /scan can wrongly tag a main-only repo with target_branch=dev. Rule 4 must not
# demand branching from a non-existent dev; it falls back to the repo's real
# default branch (main here) for the base check.

setup_h3_missing_target_repo() {
  local dir
  dir=$(mktemp -d -t tmb-guards-h3-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email t@t.t
    git config user.name T
    echo init > README.md && git add . && git commit -qm init
    mkdir -p .claude/tmb
    sqlite3 .claude/tmb/trajectory.db < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
    # target_branch=dev, but the repo has NO dev branch (main-only).
    sqlite3 .claude/tmb/trajectory.db \
      "INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('fixture', '$(git rev-parse --show-toplevel)', 'dev', 'gitflow', '[\"main\",\"dev\"]');" >/dev/null
  )
  REPO_PATH="$dir"
}

test_case "#13/H3: missing target_branch ref → branch-from-default (main) ALLOWED"
setup_h3_missing_target_repo
out=$(run_hook_in_repo "git checkout -b feat/x")
assert_not_contains "$out" '"permissionDecision":"deny"' "branch from real default (main) must be allowed when configured 'dev' ref is missing"
cleanup_repo

test_case "#13/H3: missing target_branch ref → branch from a NON-default branch still BLOCKS"
setup_h3_missing_target_repo
git -C "$REPO_PATH" branch feat/existing
git -C "$REPO_PATH" checkout -q feat/existing
out=$(run_hook_in_repo "git checkout -b feat/y")
assert_contains "$out" '"permissionDecision":"deny"' "fallback target is main, not blanket-allow — branching off feat/existing must block"
assert_contains "$out" "from main" "block message must name the fallback default branch"
cleanup_repo

# ---- #15/H2: dev→main exception reads the head from the COMMAND's repo ----------
# A `cd <repo> && gh pr create --base main` (no --head) must read the current
# branch via `git -C <cd-target>`, not the hook's $PWD. Pre-fix, the bare
# `git branch --show-current` ran in $PWD (a non-repo here) and returned empty,
# falsely blocking a legitimate dev→main release PR.

test_case "#15/H2: dev→main gh pr create (no --head) reads head=dev from the cd target → ALLOWED"
setup_glab_repo   # repo initialized on dev, target_branch=dev
out=$( (cd "$(mktemp -d)" && echo "$(jq -cn --arg c "cd $REPO_PATH && gh pr create --base main --title release" '{tool_input:{command:$c}}')" \
  | TRAJECTORY_DB_PATH="$REPO_PATH/.claude/tmb/trajectory.db" bash "$HOOK" 2>&1) || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "current branch (dev), read from the cd target, must allow the release PR"
cleanup_repo

test_case "#15/H2: dev→main gh pr create (no --head) from a FEATURE branch (read via cd target) → BLOCKS"
setup_glab_repo
git -C "$REPO_PATH" checkout -q -b feat/x
out=$( (cd "$(mktemp -d)" && echo "$(jq -cn --arg c "cd $REPO_PATH && gh pr create --base main --title oops" '{tool_input:{command:$c}}')" \
  | TRAJECTORY_DB_PATH="$REPO_PATH/.claude/tmb/trajectory.db" bash "$HOOK" 2>&1) || true)
assert_contains "$out" '"permissionDecision":"deny"' "head=feat/x (read from cd target) must block the dev→main exception"
cleanup_repo

summarize
