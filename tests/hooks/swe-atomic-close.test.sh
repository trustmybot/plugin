#!/usr/bin/env bash
# Tests for scripts/hooks/swe-atomic-close.sh.
# Hook contract: SubagentStop for swe agents. Inspects git state for the
# most-recent pending task, reads the task's detached-HEAD worktree HEAD,
# and either auto-closes it (worktree has commits beyond local branch ref)
# or emits an additionalContext warning (no worktree commits).
# Silent no-op when subagent is not swe, no pending tasks, or DB/git unavailable.
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

# ---- Fixture: main repo (bro's checkout) + detached-HEAD worktree --------
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
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '\"\"'
  );
  INSERT INTO tasks (id, branch_id, status) VALUES (42, 'fix/test-branch', 'pending');
  INSERT INTO tasks (id, branch_id, status) VALUES (43, 'fix/other-branch', 'completed');
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"
export TRAJECTORY_DB_PATH="$DB"

# Create the SWE detached-HEAD worktree under .claude/worktrees/test-branch
# (slug = everything after the last '/' in branch_id = "test-branch").
WT_PATH="$REPO/.claude/worktrees/test-branch"
git branch fix/test-branch HEAD
git worktree add -q --detach "$WT_PATH"

swe_input() {
  jq -n '{subagent_type: "swe"}'
}

non_swe_input() {
  jq -n '{subagent_type: "architect"}'
}

run_hook() {
  (cd "$REPO" && echo "$1" | bash "$HOOK" 2>&1 || true)
}

# ---- Helper: make a commit inside the SWE worktree -----------------------
make_wt_commit() {
  (cd "$WT_PATH" && echo "$RANDOM" >> work.txt && git add work.txt && git commit -qm "feat: work")
}

# ========================================================
# non-swe subagent: silent no-op
# ========================================================

test_case "non-swe subagent: silent no-op"
out=$(run_hook "$(non_swe_input)")
assert_eq "" "$out" "no output for non-swe"

# ========================================================
# pending task + no worktree commits → warn no-commits
# ========================================================

test_case "swe + pending task + no worktree commits → warn no-commits"
out=$(run_hook "$(swe_input)")
assert_contains "$out" "stopped without committing" "warn body"
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_not_contains "$out" "auto-completed" "should not auto-complete"

status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "pending" "$status_after" "task status unchanged"

# ========================================================
# pending task + worktree has commits (detached HEAD) → auto-close
# ========================================================

test_case "swe + pending task + worktree commits (detached HEAD) → auto-completed"
make_wt_commit
WT_HEAD=$(git -C "$WT_PATH" rev-parse HEAD)
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "no additionalContext on auto-close"

status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$status_after" "task auto-closed to completed"

sha_after=$(sqlite3 "$DB" "SELECT commit_sha FROM tasks WHERE id=42;")
assert_eq "$WT_HEAD" "$sha_after" "commit_sha written from worktree HEAD"

# ========================================================
# task already 'completed' → silent no-op
# ========================================================

test_case "swe + no pending tasks → silent no-op"
# Task 42 is now 'completed'. Task 43 was already completed. No pending tasks.
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "silent when no pending tasks"

# ---- Test: entry-log fires for non-swe subagent (regression for #94) ----
echo '--- Test: entry-log fires regardless of subagent_type ---'

LOG="$HOME/.claude/tmb/logs/mcp-health.log"
LOG_BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)

run_hook "$(non_swe_input)" >/dev/null

LOG_AFTER=$(wc -l < "$LOG" 2>/dev/null || echo 0)
DIFF=$((LOG_AFTER - LOG_BEFORE))

assert_eq "1" "$DIFF" "non-swe input should write exactly 1 entry-log line"

LAST_LINE=$(tail -1 "$LOG")
if ! echo "$LAST_LINE" | grep -q '"kind":"swe-atomic-close-entry"'; then
  echo "FAIL: last log line is not entry-log: $LAST_LINE" >&2
  exit 1
fi
if ! echo "$LAST_LINE" | grep -q '"agent_type_resolved":"architect"'; then
  echo "FAIL: entry-log missing resolved agent_type architect: $LAST_LINE" >&2
  exit 1
fi
echo '  ok'

# ---- Test: real CC payload shape with agent_type field (regression for #103) ----
echo '--- Test: hook recognizes real CC payload (.agent_type=tmb:swe) ---'

# Real CC SubagentStop payload shape captured 2026-04-28T17:07:31Z (#94's diagnostic).
real_cc_swe_input() {
  jq -n '{
    agent_id: "test-id",
    agent_transcript_path: "/tmp/t",
    agent_type: "tmb:swe",
    cwd: "'"$REPO"'",
    hook_event_name: "SubagentStop",
    last_assistant_message: "",
    permission_mode: "default",
    session_id: "test-session",
    transcript_path: "/tmp/t"
  }'
}

# Reset task #42 to pending and make a new commit in the worktree.
sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-103" >> work-103.txt && git add work-103.txt && git commit -qm 'feat: 103 work')

out=$(run_hook "$(real_cc_swe_input)")
NEW_STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$NEW_STATUS" "hook should auto-complete pending task with real CC payload (.agent_type=tmb:swe)"
echo '  ok'

# Also test bare 'swe' value still works
sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-bare" >> work-bare.txt && git add work-bare.txt && git commit -qm 'feat: bare swe work')
bare_swe_input() {
  jq -n '{agent_type: "swe", hook_event_name: "SubagentStop"}'
}
out=$(run_hook "$(bare_swe_input)")
NEW_STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$NEW_STATUS" "hook should also accept bare 'swe' agent_type value"
echo '  ok'

summarize
