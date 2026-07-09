#!/usr/bin/env bash
# Tests for scripts/hooks/branch-up-to-date-with-remote.sh.
# Hook contract: when SWE attaches a worktree to <branch>, deny if <branch>
# is behind origin/<pr_target>. Allows when up-to-date, when not a worktree
# add, when offline / origin missing, when bypass env set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/branch-up-to-date-with-remote.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Set up an "origin" bare repo + a clone with a TMB DB.
ORIGIN="$TMPDIR/origin.git"
WORK="$TMPDIR/work"
git init -q --bare "$ORIGIN"

git init -q -b main "$WORK"
cd "$WORK"
git config user.email t@t.io && git config user.name t
git remote add origin "$ORIGIN"
echo init > README.md && git add . && git commit -qm init
git push -q -u origin main

mkdir -p .claude/tmb
DB="$WORK/.claude/tmb/trajectory.db"
_REPO_REALPATH=$(git rev-parse --show-toplevel)
sqlite3 "$DB" "
  CREATE TABLE IF NOT EXISTS repos (
    name              TEXT PRIMARY KEY,
    path              TEXT    NOT NULL,
    file_count        INTEGER NOT NULL DEFAULT 0,
    last_scanned_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    target_branch     TEXT,
    branching_model   TEXT,
    protected_branches TEXT
  );
  INSERT INTO repos (name, path, target_branch) VALUES ('fixture', '$_REPO_REALPATH', 'main');
"
export TRAJECTORY_DB_PATH="$DB"

input() {
  jq -n --arg cmd "$1" '{
    tool_name: "Bash",
    tool_input: { command: $cmd }
  }'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

test_case "non-worktree-add command: silent pass"
out=$(run_hook "$(input 'ls -la')")
assert_eq "" "$out" "non-worktree ignored"

test_case "worktree-add with -B (branch-create form): pass through (sibling hook handles)"
out=$(run_hook "$(input 'git worktree add -B foo .claude/worktrees/x HEAD')")
assert_eq "" "$out" "branch-create variant skipped"

test_case "branch up-to-date with origin/main: pass"
git branch fresh-branch HEAD
out=$(run_hook "$(input 'git worktree add .claude/worktrees/x fresh-branch')")
assert_eq "" "$out" "up-to-date branch allowed"

test_case "branch behind origin/main: BLOCK"
git branch stale-branch HEAD
echo "x" > a.txt && git add a.txt && git commit -qm "advance" && git push -q origin main
out=$(run_hook "$(input 'git worktree add .claude/worktrees/y stale-branch')")
assert_contains "$out" '"permissionDecision":"deny"' "deny on stale branch"
assert_contains "$out" 'behind origin/main' "reason cites the gap"

test_case "TMB_ALLOW_STALE_BRANCH=1 bypass: pass even on stale branch"
out=$(echo "$(input 'git worktree add .claude/worktrees/y stale-branch')" \
  | env TMB_ALLOW_STALE_BRANCH=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass works"

test_case "no DB (not a TMB project): pass"
unset TRAJECTORY_DB_PATH
mv "$DB" "$DB.bak"
out=$(run_hook "$(input 'git worktree add .claude/worktrees/y stale-branch')")
mv "$DB.bak" "$DB"
export TRAJECTORY_DB_PATH="$DB"
assert_eq "" "$out" "no DB allow"

test_case "branch doesn't exist locally: pass (let git's own error fire)"
out=$(run_hook "$(input 'git worktree add .claude/worktrees/y nonexistent-branch-xyz')")
assert_eq "" "$out" "missing branch passes through"

test_case "origin remote missing: pass (offline-friendly)"
git remote remove origin
out=$(run_hook "$(input 'git worktree add .claude/worktrees/y stale-branch')")
git remote add origin "$ORIGIN"
assert_eq "" "$out" "no origin = no check"

# ---- multi-repo: a `cd <sibling> && git worktree add` resolves the SIBLING ----
# In a workspace, $PWD is the first repo (or the non-repo root); the guard must
# scope to the command's cd target. Set up a second registered repo whose
# branch is behind its own origin, and confirm the cd-into-sibling worktree-add
# is blocked against the SIBLING's origin/main — not $PWD's.
SIB_ORIGIN="$TMPDIR/sib-origin.git"
SIB="$TMPDIR/sib"
git init -q --bare "$SIB_ORIGIN"
git init -q -b main "$SIB"
(
  cd "$SIB"
  git config user.email t@t.io && git config user.name t
  git remote add origin "$SIB_ORIGIN"
  echo init > README.md && git add . && git commit -qm init
  git push -q -u origin main
  git branch sib-stale HEAD
  echo x > b.txt && git add b.txt && git commit -qm advance && git push -q origin main
)
_SIB_REAL=$(git -C "$SIB" rev-parse --show-toplevel)
sqlite3 "$DB" "INSERT INTO repos (name, path, target_branch) VALUES ('sib', '$_SIB_REAL', 'main');"

test_case "multi-repo: 'cd <sibling> && git worktree add <stale>' resolves the SIBLING and blocks"
# Still cd'd in \$WORK (the first repo); the cd prefix must redirect to \$SIB.
out=$(run_hook "$(input "cd $SIB && git worktree add .claude/worktrees/z sib-stale")")
assert_contains "$out" '"permissionDecision":"deny"' "deny on the sibling's stale branch via cd target"
assert_contains "$out" 'behind origin/main' "reason cites the sibling's gap"

test_case "multi-repo: a fresh branch in the sibling passes (resolution is correct, not blanket-deny)"
git -C "$SIB" branch sib-fresh origin/main
out=$(run_hook "$(input "cd $SIB && git worktree add .claude/worktrees/z2 sib-fresh")")
assert_eq "" "$out" "up-to-date sibling branch allowed"

summarize
