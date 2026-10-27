#!/usr/bin/env bash
# Tests for scripts/hooks/clean-merged-branch.sh.
# Hook contract: PostToolUse on Bash. After a successful `gh pr merge` /
# `glab mr merge`, derive the merged branch and — if it is NOT protected
# (main/dev), its work is in its base (ancestor, squash or rebase merge), and its
# worktree is clean — remove the worktree, `git branch -D` the local branch,
# and prune. Skip + warn on a dirty worktree; silent (exit 0)
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
# TMB_HOOK_TEST_IMPL=ts runs the TypeScript gate in place of the .sh.
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/clean-merged-branch.sh"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-clean-merged-branch.XXXXXX")
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

# Register the repo so the cleanup hook reads its real base/protected set from
# the repos row (target_branch=dev) rather than guessing. The repo's main
# checkout sits on `_parking`, so config — not the checked-out HEAD — names the
# base the merges land on.
DB="$TMPDIR/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
_REPO_REAL=$(git -C "$REPO" rev-parse --show-toplevel)
sqlite3 "$DB" "INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('repo', '$_REPO_REAL', 'dev', '[\"main\",\"dev\"]');"
export TRAJECTORY_DB_PATH="$DB"

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
# Exercise the DB-driven protected list with a custom, non-default branch name
# 'release'. Add it to the repo's protected set, then assert cleanup refuses it.
sqlite3 "$DB" "UPDATE repos SET protected_branches = '[\"main\",\"dev\",\"release\"]' WHERE name='repo';"
git -C "$REPO" branch release dev
out=$(run_hook "$(input 'gh pr merge release --squash')")
branch_exists release || { echo "FAIL: protected 'release' branch deleted"; exit 1; }
_pass
git -C "$REPO" branch -D release >/dev/null 2>&1 || true
sqlite3 "$DB" "UPDATE repos SET protected_branches = '[\"main\",\"dev\"]' WHERE name='repo';"

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
# Squash-merge a branch into dev from a scratch worktree on dev, then advance
# dev past it — the branch tip is never an ancestor of dev (GH 1674).
# squash_into_dev <branch>
squash_into_dev() {
  local branch="$1"
  git -C "$REPO" worktree add -q "$TMPDIR/wt-squash-base" dev
  git -C "$TMPDIR/wt-squash-base" merge -q --squash "$branch" >/dev/null
  git -C "$TMPDIR/wt-squash-base" commit -qm "$branch (#1)"
  echo "later" > "$TMPDIR/wt-squash-base/later-$RANDOM.txt"
  git -C "$TMPDIR/wt-squash-base" add .
  git -C "$TMPDIR/wt-squash-base" commit -qm "later dev work"
  git -C "$REPO" worktree remove "$TMPDIR/wt-squash-base"
}

test_case "(e') squash-merged multi-commit branch + worktree → both removed (GH 1674)"
git -C "$REPO" branch feat/squashed dev
git -C "$REPO" worktree add -q "$TMPDIR/wt-squashed" feat/squashed
echo one > "$TMPDIR/wt-squashed/sq.txt"
git -C "$TMPDIR/wt-squashed" add .
git -C "$TMPDIR/wt-squashed" commit -qm "squash part 1"
echo two > "$TMPDIR/wt-squashed/sq.txt"
echo extra > "$TMPDIR/wt-squashed/sq2.txt"
git -C "$TMPDIR/wt-squashed" add .
git -C "$TMPDIR/wt-squashed" commit -qm "squash part 2"
squash_into_dev feat/squashed
git -C "$REPO" merge-base --is-ancestor feat/squashed dev && { echo "FAIL: setup — squashed tip is an ancestor"; exit 1; }
out=$(run_hook "$(input 'gh pr merge feat/squashed --squash')")
assert_contains "$out" 'cleaned up merged branch feat/squashed' "squash cleanup report"
branch_exists feat/squashed && { echo "FAIL: squash-merged branch still present"; exit 1; }
_pass
[ -d "$TMPDIR/wt-squashed" ] && { echo "FAIL: squash-merged worktree still present"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(e'') squash-merged branch with an unmerged follow-up commit → kept (GH 1674)"
git -C "$REPO" branch feat/partial dev
git -C "$REPO" worktree add -q "$TMPDIR/wt-partial" feat/partial
echo first > "$TMPDIR/wt-partial/p.txt"
git -C "$TMPDIR/wt-partial" add .
git -C "$TMPDIR/wt-partial" commit -qm "partial part 1"
squash_into_dev feat/partial
echo followup > "$TMPDIR/wt-partial/p2.txt"
git -C "$TMPDIR/wt-partial" add .
git -C "$TMPDIR/wt-partial" commit -qm "follow-up not in dev"
out=$(run_hook "$(input 'gh pr merge feat/partial --squash')")
assert_not_contains "$out" 'cleaned up merged branch' "no cleanup report"
branch_exists feat/partial || { echo "FAIL: branch with unmerged work deleted"; exit 1; }
_pass
git -C "$REPO" worktree remove --force "$TMPDIR/wt-partial" >/dev/null 2>&1 || true
git -C "$REPO" branch -D feat/partial >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
test_case "(e''') 2000 unmerged commits — git cherry output past the pipe buffer → kept (GH 1674)"
# A cherry list this long once let `printf | grep -q` die of SIGPIPE under
# pipefail, which `!` read as "no + lines" and the branch was force-deleted.
{
  for i in $(seq 1 2000); do
    printf 'commit refs/heads/feat/huge\ncommitter t <t@t.io> %d +0000\ndata 4\nbig\n' "$((1700000000 + i))"
    [ "$i" -eq 1 ] && printf 'from refs/heads/dev\n'
    printf 'M 100644 inline huge.txt\ndata %d\n%s\n' "$(( ${#i} + 1 ))" "$i"
  done
} | git -C "$REPO" fast-import --quiet
[ "$(git -C "$REPO" rev-list --count dev..feat/huge)" -eq 2000 ] || { echo "FAIL: setup — expected 2000 unmerged commits"; exit 1; }
out=$(run_hook "$(input 'gh pr merge feat/huge --squash')")
assert_not_contains "$out" 'cleaned up merged branch' "no cleanup report"
branch_exists feat/huge || { echo "FAIL: branch with 2000 unmerged commits deleted"; exit 1; }
_pass
git -C "$REPO" branch -D feat/huge >/dev/null 2>&1 || true

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

# ---------------------------------------------------------------------------
test_case "(i) multi-repo: 'cd <sibling> && gh pr merge' resolves the SIBLING repo, not the payload cwd/\$PWD"
# A second, independent repo. The merge command cd's into it, but the payload
# .cwd still points at the FIRST repo — proving the hook scopes to the command's
# cd target (shared cmd_cwd), not .cwd/$PWD.
SIB="$TMPDIR/sibling"
# Init on a parking branch so `main` is never the main checkout's HEAD — lets us
# fast-forward main (simulating the merge landing) without colliding with it.
git init -q -b _parking "$SIB"
git -C "$SIB" config user.email t@t.io
git -C "$SIB" config user.name t
echo init > "$SIB/README.md"
git -C "$SIB" add .
git -C "$SIB" commit -qm init
git -C "$SIB" branch main _parking
git -C "$SIB" branch feat/sib main
git -C "$SIB" worktree add -q "$TMPDIR/wt-sib" feat/sib
echo work > "$TMPDIR/wt-sib/s.txt"
git -C "$TMPDIR/wt-sib" add .
git -C "$TMPDIR/wt-sib" commit -qm "feat sib"
# The sibling's configured base branch (main) is the merge base.
git -C "$SIB" branch -f main feat/sib
_SIB_REAL=$(git -C "$SIB" rev-parse --show-toplevel)
sqlite3 "$DB" "INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('sibling', '$_SIB_REAL', 'main', '[\"main\"]');"
# input() defaults .cwd to \$REPO (the WRONG repo); the cd prefix must win.
out=$(run_hook "$(input "cd $SIB && gh pr merge feat/sib --squash")")
assert_contains "$out" 'cleaned up merged branch feat/sib' "cd target (sibling) must be resolved, not payload cwd"
git -C "$SIB" rev-parse --verify --quiet refs/heads/feat/sib >/dev/null 2>&1 && { echo "FAIL: sibling branch not deleted"; exit 1; }
_pass
# The first repo must be untouched (the merge never scoped to it).
branch_exists dev || { echo "FAIL: first repo's dev branch affected"; exit 1; }
_pass

# ---------------------------------------------------------------------------
test_case "(e) base resolves to a missing ref → merged branch left alone"
make_merged feat/nobase nobase
sqlite3 "$DB" "UPDATE repos SET target_branch = NULL WHERE name='repo';"
git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/gone
out=$(run_hook "$(input 'gh pr merge feat/nobase --squash')")
assert_not_contains "$out" 'cleaned up merged branch' "no cleanup report"
branch_exists feat/nobase || { echo "FAIL: branch deleted without a resolvable base"; exit 1; }
_pass
git -C "$REPO" symbolic-ref --delete refs/remotes/origin/HEAD
sqlite3 "$DB" "UPDATE repos SET target_branch = 'dev' WHERE name='repo';"

summarize
