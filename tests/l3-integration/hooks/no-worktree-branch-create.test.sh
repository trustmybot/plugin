#!/usr/bin/env bash
# Tests for scripts/hooks/no-worktree-branch-create.sh.
# Hook contract: blocks `git worktree add -b|-B|--create-branch ...` calls
# when a TMB DB exists. Allows worktree adds that attach to existing branches.
# Silent pass-through for non-Bash, non-worktree commands, and outside TMB.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/no-worktree-branch-create.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "CREATE TABLE meta (k TEXT);"

input() {
  jq -n --arg tn "$1" --arg cmd "$2" '{
    tool_name: $tn,
    tool_input: { command: $cmd }
  }'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

test_case "non-Bash tool: silent pass"
out=$(run_hook "$(input 'Edit' 'whatever')")
assert_eq "" "$out" "non-Bash ignored"

test_case "Bash, non-worktree command: silent pass"
out=$(run_hook "$(input 'Bash' 'ls -la')")
assert_eq "" "$out" "non-worktree command ignored"

test_case "git worktree add WITHOUT -b/-B (attach existing branch): silent pass"
out=$(run_hook "$(input 'Bash' 'git worktree add .claude/worktrees/mywork fix/foo-bar')")
assert_eq "" "$out" "attach-existing allowed"

test_case "git worktree add -b NAME path: BLOCK"
out=$(run_hook "$(input 'Bash' 'git worktree add -b new/branch .claude/worktrees/x main')")
assert_contains "$out" '"permissionDecision":"deny"' "deny on -b"
assert_contains "$out" 'Branch authority belongs to bro' "reason cites doctrine"

test_case "git worktree add -B NAME path: BLOCK"
out=$(run_hook "$(input 'Bash' 'git worktree add -B fix/typo-foo .claude/worktrees/y HEAD')")
assert_contains "$out" '"permissionDecision":"deny"' "deny on -B"

test_case "git worktree add --create-branch NAME path: BLOCK"
out=$(run_hook "$(input 'Bash' 'git worktree add --create-branch new .claude/worktrees/z HEAD')")
assert_contains "$out" '"permissionDecision":"deny"' "deny on --create-branch"

test_case "TMB_ALLOW_WORKTREE_BRANCH_CREATE bypass: pass even on -B"
out=$(echo "$(input 'Bash' 'git worktree add -B foo .claude/worktrees/x HEAD')" \
  | env TMB_ALLOW_WORKTREE_BRANCH_CREATE=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass works"

# --- #2869: --detach checks ---

test_case "git worktree add --detach path branch: BLOCK"
out=$(run_hook "$(input 'Bash' 'git worktree add --detach .claude/worktrees/x fix/foo')")
assert_contains "$out" '"permissionDecision":"deny"' "deny on --detach"
assert_contains "$out" 'strands SWE' "reason cites #2869 doctrine"

test_case "git worktree add (no --detach): silent pass"
out=$(run_hook "$(input 'Bash' 'git worktree add .claude/worktrees/y fix/bar')")
assert_eq "" "$out" "plain worktree add allowed"

test_case "TMB_ALLOW_WORKTREE_DETACH bypass: pass even with --detach"
out=$(echo "$(input 'Bash' 'git worktree add --detach .claude/worktrees/x fix/foo')" \
  | env TMB_ALLOW_WORKTREE_DETACH=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "detach bypass works"

test_case "no DB (not a TMB project): pass even on -B"
rm -f "$DB"
out=$(run_hook "$(input 'Bash' 'git worktree add -B foo .claude/worktrees/x HEAD')")
assert_eq "" "$out" "no DB = not TMB = allow"

test_case "no DB (not a TMB project): pass even on --detach"
out=$(run_hook "$(input 'Bash' 'git worktree add --detach .claude/worktrees/x fix/foo')")
assert_eq "" "$out" "no DB = not TMB = allow detach too"

summarize
