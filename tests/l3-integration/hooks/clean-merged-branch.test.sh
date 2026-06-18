#!/usr/bin/env bash
# Tests for scripts/hooks/clean-merged-branch.sh.
# Hook contract: PostToolUse on Bash. After a successful `gh pr merge` /
# `glab mr merge`, derive the merged branch and — if it is NOT protected
# (main/dev), is actually merged into its base (ancestor check), and its
# worktree is clean — remove the worktree, `git branch -d` the local branch,
# and prune. Skip + warn on a dirty worktree; never force; silent (exit 0)
# on everything else; bypass via TMB_DISABLE_CLEAN_MERGED_BRANCH=1.
#
# All git state lives under a mktemp sandbox driven by `git -C` (per #810 —
# no commits leak to the caller branch). assert_not_in_plugin_repo guards
# against running with cwd inside the real plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/clean-merged-branch.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
# Run from the sandbox, never the plugin repo, so a stray commit can't land on
# the caller branch.
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

REPO="$TMPDIR/repo"
# Init on a parking branch so `dev` is never the main checkout's HEAD — that
# lets the test fast-forward `dev` (simulating a merge landing) and lets the
# hook delete branches without colliding with the checked-out ref.
git init -q -b _parking "$REPO"
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
echo init > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm init
git -C "$REPO" branch dev _parking

# input <command> [cwd] — synthesize a PostToolUse(Bash) payload. Defaults to a
# successful response and cwd=$REPO.
input() {
  local cmd="$1" cwd="${2:-$REPO}"
  jq -n --arg cmd "$cmd" --arg cwd "$cwd" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: "✓ Merged pull request",
    cwd: $cwd
  }'
}

run_hook() { printf '%s' "$1" | bash "$HOOK" 2>&1 || true; }

branch_exists() { git -C "$REPO" rev-parse --verify --quiet "refs/heads/$1" >/dev/null 2>&1; }

# Build a feature branch merged into dev, with an attached worktree.
# make_merged <branch> <slug>
make_merged() {
  local branch="$1" slug="$2"
  git -C "$REPO" branch "$branch" dev
  git -C "$REPO" worktree add -q "$TMPDIR/wt-$slug" "$branch"
  echo "feature $slug" > "$TMPDIR/wt-$slug/f-$slug.txt"
  git -C "$TMPDIR/wt-$slug" add .
  git -C "$TMPDIR/wt-$slug" commit -qm "feat $slug"
  # Fast-forward dev to the branch tip (simulates the merge landing on base).
  git -C "$REPO" branch -f dev "$branch"
}

# ---------------------------------------------------------------------------
test_case "(a) merged clean branch + worktree → both removed"
make_merged feat/clean clean
[ -d "$TMPDIR/wt-clean" ] || { echo "FAIL: setup worktree missing"; exit 1; }
out=$(run_hook "$(input 'gh pr merge feat/clean --squash --delete-branch')")
assert_contains "$out" 'cleaned up merged branch feat/clean' "cleanup report"
branch_exists feat/clean && { echo "FAIL: branch still present"; exit 1; }
_pass
[ -d "$TMPDIR/wt-clean" ] && { echo "FAIL: worktree still present"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(a') glab mr merge also triggers cleanup (git/gh/glab parity)"
make_merged feat/glab glab
out=$(run_hook "$(input 'glab mr merge feat/glab --squash')")
assert_contains "$out" 'cleaned up merged branch feat/glab' "glab cleanup report"
branch_exists feat/glab && { echo "FAIL: glab branch still present"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(b) protected branch (dev) → untouched"
# Run the merge from a clean worktree checked out on dev, no explicit branch arg
# so the hook derives the current branch (dev) — which must be refused.
git -C "$REPO" worktree add -q "$TMPDIR/wt-dev" dev
out=$(run_hook "$(input 'gh pr merge --squash' "$TMPDIR/wt-dev")")
branch_exists dev || { echo "FAIL: dev branch was deleted"; exit 1; }
_pass
[ -d "$TMPDIR/wt-dev" ] || { echo "FAIL: dev worktree was removed"; exit 1; }
_pass
git -C "$REPO" worktree remove "$TMPDIR/wt-dev" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
test_case "(b') protected via repos.protected_branches → untouched"
# main is hard-excluded, but also exercise the DB-driven protected list with a
# custom branch name 'release'.
DB="$TMPDIR/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
_REPO_REAL=$(git -C "$REPO" rev-parse --show-toplevel)
sqlite3 "$DB" "
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, target_branch TEXT, branching_model TEXT, protected_branches TEXT);
  INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('repo', '${_REPO_REAL}', 'dev', '[\"release\"]');
"
git -C "$REPO" branch release dev
out=$(TRAJECTORY_DB_PATH="$DB" run_hook "$(input 'gh pr merge release --squash')")
branch_exists release || { echo "FAIL: protected 'release' branch deleted"; exit 1; }
_pass
git -C "$REPO" branch -D release >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
test_case "(c) dirty worktree → skipped with warning, not removed"
make_merged feat/dirty dirty
echo "uncommitted" > "$TMPDIR/wt-dirty/scratch.txt"
out=$(run_hook "$(input 'gh pr merge feat/dirty --squash')")
assert_contains "$out" 'uncommitted/untracked changes' "dirty warning"
branch_exists feat/dirty || { echo "FAIL: dirty branch was deleted"; exit 1; }
_pass
[ -d "$TMPDIR/wt-dirty" ] || { echo "FAIL: dirty worktree was removed"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(d) non-merge Bash command → no-op (silent)"
make_merged feat/nonmerge nonmerge
out=$(run_hook "$(input 'git status')")
assert_eq "" "$out" "non-merge command is silent"
branch_exists feat/nonmerge || { echo "FAIL: branch deleted on non-merge cmd"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(e) not-merged branch (not an ancestor of base) → untouched"
git -C "$REPO" branch feat/unmerged dev
git -C "$REPO" worktree add -q "$TMPDIR/wt-unmerged" feat/unmerged
echo diverge > "$TMPDIR/wt-unmerged/d.txt"
git -C "$TMPDIR/wt-unmerged" add .
git -C "$TMPDIR/wt-unmerged" commit -qm diverge
# dev is NOT advanced — the branch tip is not an ancestor of dev.
out=$(run_hook "$(input 'gh pr merge feat/unmerged --squash')")
branch_exists feat/unmerged || { echo "FAIL: unmerged branch deleted"; exit 1; }
_pass
git -C "$REPO" worktree remove --force "$TMPDIR/wt-unmerged" >/dev/null 2>&1 || true
git -C "$REPO" branch -D feat/unmerged >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
test_case "(f) TMB_DISABLE_CLEAN_MERGED_BRANCH=1 bypass → untouched"
make_merged feat/bypass bypass
out=$(printf '%s' "$(input 'gh pr merge feat/bypass --squash')" \
  | env TMB_DISABLE_CLEAN_MERGED_BRANCH=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass silences the hook"
branch_exists feat/bypass || { echo "FAIL: branch deleted despite bypass"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(g) failed merge response → untouched"
make_merged feat/failed failed
fail_input=$(jq -n --arg cmd 'gh pr merge feat/failed --squash' --arg cwd "$REPO" '{
  tool_name: "Bash",
  tool_input: { command: $cmd },
  tool_response: "GraphQL: Pull request is not mergeable",
  cwd: $cwd
}')
out=$(run_hook "$fail_input")
branch_exists feat/failed || { echo "FAIL: branch deleted on failed merge"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(h) merged branch with no worktree → branch still deleted"
git -C "$REPO" branch feat/nowt dev
# advance dev to a commit that includes the branch tip (branch == dev tip → ancestor)
out=$(run_hook "$(input 'gh pr merge feat/nowt --squash')")
assert_contains "$out" 'cleaned up merged branch feat/nowt' "no-worktree cleanup report"
branch_exists feat/nowt && { echo "FAIL: branch not deleted"; exit 1; }
_pass

summarize
