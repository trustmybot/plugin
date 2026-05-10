#!/usr/bin/env bash
# Unit-style tests for the new coherence + git scorers (Phase 1).
# Builds a synthetic scratch project + DB, exercises pass/fail paths.
# Run: bash tests/dogfood/lib/scorers-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$HERE/scorers.sh"

PASS=0
FAIL=0
TMPDIR_ROOT=$(mktemp -d -t scorers-test-XXXX)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ---- helpers --------------------------------------------------------------

mk_project() {
  local p
  p=$(mktemp -d -t scorers-XXXX)
  (
    cd "$p" || exit 1
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
    echo init > README.md
    git add . && git commit -qm init
  ) >/dev/null 2>&1
  mkdir -p "$p/.claude/tmb"
  # Schema runs PRAGMA journal_mode = WAL which echoes "wal" to stdout — redirect.
  sqlite3 "$p/.claude/tmb/trajectory.db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  echo "$p"
}

mk_flow_dir() {
  mktemp -d -t scorers-flow-XXXX
}

assert_exit() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $label — expected exit=$expected, got exit=$actual"
  fi
}

# ---- coherence scorer -----------------------------------------------------

echo "== coherence: missing config = no-op (pass) =="
P=$(mk_project) && FD=$(mk_flow_dir)
l5_score_coherence "$P" "test" "$FD" "run-1" >/dev/null 2>&1
assert_exit 0 $? "no outcome-coherence.json → exit 0"

echo "== coherence: empty config = no-op (pass) =="
echo '{}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-2" >/dev/null 2>&1
assert_exit 0 $? "empty config → exit 0"

echo "== coherence: assertion satisfied =="
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now'));"
echo '{"expected_writes": {"issues": ">=1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-3" >/dev/null 2>&1
assert_exit 0 $? "issues>=1 with one row → pass"

echo "== coherence: assertion violated =="
echo '{"expected_writes": {"issues": ">=5"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-4" >/dev/null 2>&1
assert_exit 1 $? "issues>=5 with one row → fail"

echo "== coherence: WHERE clause filtering =="
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, success_criteria, status, created_at, updated_at) VALUES (1, 1, 'feat/foo', 'main', '', '', 'pending', datetime('now'), datetime('now'));"
echo '{"expected_writes": {"tasks WHERE branch_id != \"main\"": ">=1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-5" >/dev/null 2>&1
assert_exit 0 $? "tasks WHERE branch != main → pass"

echo "== coherence: exact-match operator =="
echo '{"expected_writes": {"tasks": "1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-6" >/dev/null 2>&1
assert_exit 0 $? "tasks = 1 → pass"

echo "== coherence: != operator =="
echo '{"expected_writes": {"audit": "!=99"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-7" >/dev/null 2>&1
assert_exit 0 $? "audit !=99 → pass"

echo "== coherence: invalid operator =="
echo '{"expected_writes": {"issues": "wat"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-8" >/dev/null 2>&1
assert_exit 1 $? "invalid operator → fail"

# ---- git scorer -----------------------------------------------------------

echo "== git: missing config = no-op (pass) =="
P=$(mk_project) && FD=$(mk_flow_dir)
l5_score_git "$P" "test" "$FD" "run-g1" >/dev/null 2>&1
assert_exit 0 $? "no outcome-git.json → exit 0"

echo "== git: base_branch_unchanged matches pre-run snapshot =="
echo '{"base_branch_unchanged": true}' > "$FD/outcome-git.json"
# Simulate what l5_run_claude does before firing claude-p.
mkdir -p "$P/.claude/tmb"
PRE_HEAD=$(git -C "$P" rev-parse HEAD)
printf '{"head":"%s","branch":"main"}\n' "$PRE_HEAD" > "$P/.claude/tmb/_l5_pre_run_git.json"
l5_score_git "$P" "test" "$FD" "run-g2" >/dev/null 2>&1
assert_exit 0 $? "base SHA unchanged from pre-run → pass"

echo "== git: base_branch_unchanged catches a commit during the run =="
(cd "$P" && echo "more" >> README.md && git add . && git commit -qm "bro committed to base!") >/dev/null 2>&1
l5_score_git "$P" "test" "$FD" "run-g3" >/dev/null 2>&1
assert_exit 1 $? "base advanced post-snapshot → fail"

echo "== git: missing pre-run snapshot is reported =="
P=$(mk_project) && FD=$(mk_flow_dir)
echo '{"base_branch_unchanged": true}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g3b" >/dev/null 2>&1
assert_exit 1 $? "no pre-run snapshot → fail (loud signal)"

echo "== git: worktree HEAD on expected branch =="
P=$(mk_project) && FD=$(mk_flow_dir)
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now')); INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, success_criteria, status, created_at, updated_at) VALUES (1, 1, 'feat/check', 'main', '', '', 'pending', datetime('now'), datetime('now'));"
(cd "$P" && git branch feat/check HEAD && mkdir -p .claude/worktrees && git worktree add -q .claude/worktrees/check feat/check)
echo '{"worktrees": [{"path": ".claude/worktrees/<slug>", "head_branch": "<task.branch_id>"}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g4" >/dev/null 2>&1
assert_exit 0 $? "worktree on feat/check → pass"

echo "== git: worktree HEAD on forbidden branch =="
echo '{"worktrees": [{"path": ".claude/worktrees/check", "head_not_branch": ["feat/check"]}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g5" >/dev/null 2>&1
assert_exit 1 $? "worktree on forbidden 'feat/check' → fail"

echo "== git: worktree path missing =="
echo '{"worktrees": [{"path": ".claude/worktrees/missing", "head_branch": "main"}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g6" >/dev/null 2>&1
assert_exit 1 $? "worktree path missing → fail"

# ---- summary --------------------------------------------------------------

echo
echo "scorers-test: $PASS pass / $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
