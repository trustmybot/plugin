#!/usr/bin/env bash
# Tests for scripts/hooks/swe-atomic-close.sh.
# Hook contract: SubagentStop for swe agents. Inspects git state for the
# current branch, finds the matching pending task, and either auto-closes it
# (committed + pushed) or emits additionalContext warnings (no-push /
# no-commits). Silent no-op when subagent is not swe, task not pending, or
# DB/git unavailable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ---- Fixture: bare git remote (plays the role of origin) -----------------
REMOTE="$TMPDIR/remote.git"
git init -q --bare "$REMOTE"

# ---- Fixture: working repo with tasks DB ---------------------------------
REPO="$TMPDIR/repo"
git init -q -b dev "$REPO"
cd "$REPO"
git config user.email t@t.io
git config user.name t
git remote add origin "$REMOTE"
echo init > README.md
git add .
git commit -qm init
git push -q origin dev

DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL DEFAULT 1,
    branch_id TEXT NOT NULL,
    parent_branch_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tools_required TEXT NOT NULL DEFAULT '[]',
    skills_required TEXT NOT NULL DEFAULT '[]',
    success_criteria TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    spec_body TEXT NOT NULL DEFAULT '',
    commit_sha TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT INTO tasks (id, branch_id, status) VALUES (42, 'fix/test-branch', 'pending');
  INSERT INTO tasks (id, branch_id, status) VALUES (43, 'fix/other-branch', 'completed');
"
export TRAJECTORY_DB_PATH="$DB"

# Create + switch to the SWE working branch.
git checkout -q -b fix/test-branch

swe_input() {
  jq -n '{subagent_type: "swe"}'
}

non_swe_input() {
  jq -n '{subagent_type: "architect"}'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

# ---- Helper: make a commit on the current branch -------------------------
make_commit() {
  echo "$RANDOM" >> work.txt
  git add work.txt
  git commit -qm "feat: work"
}

# ========================================================
# (d) Task already 'completed' — hook is a no-op
# ========================================================

test_case "non-swe subagent: silent no-op"
out=$(run_hook "$(non_swe_input)")
assert_eq "" "$out" "no output for non-swe"

# ========================================================
# (c) Task pending + no commits → warning
# ========================================================

test_case "swe + pending task + no commits → warn no-commits"
out=$(run_hook "$(swe_input)")
assert_contains "$out" "stopped without committing" "warn body"
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_not_contains "$out" "auto-completed" "should not auto-complete"

# Confirm DB not modified.
status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "pending" "$status_after" "task status unchanged"

# ========================================================
# (b) Task pending + commits + NOT pushed → warn not-pushed
# ========================================================

test_case "swe + pending task + commits + not pushed → warn not-pushed"
make_commit
out=$(run_hook "$(swe_input)")
assert_contains "$out" "committed but did not push" "warn not-pushed body"
assert_contains "$out" "additionalContext" "additionalContext key present"

# Confirm DB not modified.
status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "pending" "$status_after" "task status unchanged"

# ========================================================
# (a) Task pending + commits + pushed → auto-close
# ========================================================

test_case "swe + pending task + commits + pushed → auto-completed"
git push -q origin fix/test-branch
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "no additionalContext on auto-close"

# Confirm DB updated to 'completed'.
status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$status_after" "task auto-closed to completed"

sha_after=$(sqlite3 "$DB" "SELECT commit_sha FROM tasks WHERE id=42;")
local_head=$(git rev-parse HEAD)
assert_eq "$local_head" "$sha_after" "commit_sha written correctly"

# ========================================================
# (d) Task already 'completed' — hook is a no-op
# ========================================================

test_case "swe + task already completed → silent no-op"
# Task 42 is now 'completed' from previous test. Make another commit + push.
make_commit
git push -q origin fix/test-branch
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "silent when task already completed"

summarize
