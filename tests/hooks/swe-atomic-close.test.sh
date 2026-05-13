#!/usr/bin/env bash
# Tests for scripts/hooks/swe-atomic-close.sh.
# Hook contract: SubagentStop for swe agents. Inspects git state for the
# most-recent task in (pending, needs_validation, completed), reads the task's
# detached-HEAD worktree HEAD, and either auto-closes pending tasks or records
# metrics-only for pre-flipped tasks. Always writes agent_runs.
# Silent no-op when subagent is not swe, no matching tasks, or DB/git unavailable.
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
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    spec_body TEXT NOT NULL DEFAULT '',
    commit_sha TEXT,
    repo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE repos (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    issue_id INTEGER,
    agent_type TEXT NOT NULL DEFAULT 'swe',
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tokens_total INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '\"\"'
  );
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (42, 'fix/test-branch', 'dev', 'pending', datetime('now', '+10 seconds'));
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (43, 'fix/other-branch', 'dev', 'completed', datetime('now'));
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (44, 'fix/nv-branch', 'dev', 'needs_validation', datetime('now'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"
export TRAJECTORY_DB_PATH="$DB"

# Create the SWE worktrees attached to the named branch — the worktree owns
# the branch ref so SWE's commits advance it directly.
# Slug = everything after the last '/' in branch_id.
WT_PATH="$REPO/.claude/worktrees/test-branch"
git branch fix/test-branch HEAD
git worktree add -q "$WT_PATH" fix/test-branch

# Worktree for task 44 (needs_validation, slug = nv-branch).
WT_NV_PATH="$REPO/.claude/worktrees/nv-branch"
git branch fix/nv-branch HEAD
git worktree add -q "$WT_NV_PATH" fix/nv-branch

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
AR_COUNT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=42;")
out=$(run_hook "$(swe_input)")
assert_contains "$out" "stopped without committing" "warn body"
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_not_contains "$out" "auto-completed" "should not auto-complete"

status_after=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "pending" "$status_after" "task status unchanged"

test_case "swe + pending task + no worktree commits → agent_runs row written"
AR_COUNT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=42;")
assert_eq "$((AR_COUNT_BEFORE + 1))" "$AR_COUNT_AFTER" "agent_runs row written even on warn-no-commits"

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
# task already 'completed' → metrics-only (no stdout, writes agent_runs)
# ========================================================

test_case "swe + completed task → metrics-only, no additionalContext"
# Task 42 is now 'completed'. Ensure it's the most-recently-updated so the hook selects it.
sqlite3 "$DB" "UPDATE tasks SET updated_at=datetime('now', '+20 seconds') WHERE id=42;"
AR_COUNT_BEFORE_COMPLETED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=42;")
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "no additionalContext on metrics-only"

test_case "swe + completed task → agent_runs row written"
AR_COUNT_AFTER_COMPLETED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=42;")
assert_eq "$((AR_COUNT_BEFORE_COMPLETED + 1))" "$AR_COUNT_AFTER_COMPLETED" "agent_runs row written for completed task"

# ========================================================
# NEW: needs_validation + worktree has commit → metrics-only, status preserved
# ========================================================

echo '--- Test: needs_validation + worktree commit → metrics-only ---'

make_nv_commit() {
  (cd "$WT_NV_PATH" && echo "$RANDOM" >> nv-work.txt && git add nv-work.txt && git commit -qm "feat: nv work")
}

# Reset task 44 freshness so it's the most-recently-updated.
sqlite3 "$DB" "UPDATE tasks SET updated_at=datetime('now', '+30 seconds') WHERE id=44;"
make_nv_commit

test_case "needs_validation + worktree commit → no additionalContext"
AR_COUNT_NV_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=44;")
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "no additionalContext for metrics-only"

test_case "needs_validation + worktree commit → status stays needs_validation"
nv_status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=44;")
assert_eq "needs_validation" "$nv_status" "status not flipped by hook"

test_case "needs_validation + worktree commit → agent_runs row written"
AR_COUNT_NV_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=44;")
assert_eq "$((AR_COUNT_NV_BEFORE + 1))" "$AR_COUNT_NV_AFTER" "agent_runs row inserted"

# ========================================================
# NEW: needs_validation + no worktree commit → metrics-only, agent_runs written
# ========================================================

echo '--- Test: needs_validation + no worktree commit → metrics-only ---'

# Reset the worktree to match its parent_branch tip — branch ref + worktree
# HEAD both move back so HAS_COMMITS=false. The hook detects "no commits"
# by comparing worktree HEAD to parent branch tip.
PARENT_TIP=$(git -C "$REPO" rev-parse dev)
git -C "$WT_NV_PATH" reset --hard -q "$PARENT_TIP"
sqlite3 "$DB" "UPDATE tasks SET updated_at=datetime('now', '+35 seconds') WHERE id=44;"

test_case "needs_validation + no commit → no additionalContext"
AR_COUNT_NV2_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=44;")
out=$(run_hook "$(swe_input)")
assert_eq "" "$out" "no additionalContext even with no commits"

test_case "needs_validation + no commit → status stays needs_validation"
nv_status2=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=44;")
assert_eq "needs_validation" "$nv_status2" "status unchanged"

test_case "needs_validation + no commit → agent_runs row written"
AR_COUNT_NV2_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=44;")
assert_eq "$((AR_COUNT_NV2_BEFORE + 1))" "$AR_COUNT_NV2_AFTER" "agent_runs written for no-commit needs_validation spawn"

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

# Reset task #42 to pending and make it the most-recently-updated task.
# Use +60s to guarantee task 42 sorts above task 44 (whose NV-test update used +5s).
sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-103" >> work-103.txt && git add work-103.txt && git commit -qm 'feat: 103 work')

out=$(run_hook "$(real_cc_swe_input)")
NEW_STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$NEW_STATUS" "hook should auto-complete pending task with real CC payload (.agent_type=tmb:swe)"
echo '  ok'

# Also test bare 'swe' value still works
sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-bare" >> work-bare.txt && git add work-bare.txt && git commit -qm 'feat: bare swe work')
bare_swe_input() {
  jq -n '{agent_type: "swe", hook_event_name: "SubagentStop"}'
}
out=$(run_hook "$(bare_swe_input)")
NEW_STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$NEW_STATUS" "hook should also accept bare 'swe' agent_type value"
echo '  ok'

# ========================================================
# transcript parsing: real values populated in agent_runs
# ========================================================

echo '--- Test: transcript parsed → agent_runs has real token/duration values ---'

TRANSCRIPT="$TMPDIR/synthetic-transcript.jsonl"
# Two assistant messages: known usage + one tool_use block; timestamps 1500ms apart.
cat > "$TRANSCRIPT" <<'JSONL'
{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]}}
{"timestamp":"2026-04-01T00:00:01.500Z","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":75},"content":[]}}
JSONL

sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-transcript" >> work-transcript.txt && git add work-transcript.txt && git commit -qm 'feat: transcript work')

transcript_input() {
  local path="$1"
  jq -n --arg tp "$path" '{subagent_type: "swe", agent_transcript_path: $tp}'
}

out=$(run_hook "$(transcript_input "$TRANSCRIPT")")

AR_ROW=$(sqlite3 "$DB" "SELECT tokens_in, tokens_out, tokens_total, tool_uses, duration_ms FROM agent_runs ORDER BY id DESC LIMIT 1;")
AR_TI=$(echo "$AR_ROW" | cut -d'|' -f1)
AR_TO=$(echo "$AR_ROW" | cut -d'|' -f2)
AR_TT=$(echo "$AR_ROW" | cut -d'|' -f3)
AR_TU=$(echo "$AR_ROW" | cut -d'|' -f4)
AR_DM=$(echo "$AR_ROW" | cut -d'|' -f5)

test_case "transcript parsed: tokens_in=300"
assert_eq "300" "$AR_TI" "tokens_in"

test_case "transcript parsed: tokens_out=125"
assert_eq "125" "$AR_TO" "tokens_out"

test_case "transcript parsed: tokens_total=425"
assert_eq "425" "$AR_TT" "tokens_total"

test_case "transcript parsed: tool_uses=1"
assert_eq "1" "$AR_TU" "tool_uses"

test_case "transcript parsed: duration_ms close to 1500"
if [ "$AR_DM" -ge 1490 ] && [ "$AR_DM" -le 1510 ]; then
  _pass
else
  _fail "duration_ms expected ~1500, got $AR_DM"
fi

# ========================================================
# edge case: no agent_transcript_path → zeros
# ========================================================

echo '--- Test: no agent_transcript_path → agent_runs zeros ---'

sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-nopath" >> work-nopath.txt && git add work-nopath.txt && git commit -qm 'feat: nopath work')

no_transcript_input() {
  jq -n '{subagent_type: "swe"}'
}

run_hook "$(no_transcript_input)" >/dev/null

AR_ROW2=$(sqlite3 "$DB" "SELECT tokens_in, tokens_out, tokens_total, tool_uses, duration_ms FROM agent_runs ORDER BY id DESC LIMIT 1;")
AR_TI2=$(echo "$AR_ROW2" | cut -d'|' -f1)
AR_TO2=$(echo "$AR_ROW2" | cut -d'|' -f2)
AR_TT2=$(echo "$AR_ROW2" | cut -d'|' -f3)

test_case "no transcript path: tokens_in=0"
assert_eq "0" "$AR_TI2" "tokens_in when no transcript"

test_case "no transcript path: tokens_out=0"
assert_eq "0" "$AR_TO2" "tokens_out when no transcript"

test_case "no transcript path: tokens_total=0"
assert_eq "0" "$AR_TT2" "tokens_total when no transcript"

# ========================================================
# edge case: agent_transcript_path points to missing file → zeros + parse-failed log
# ========================================================

echo '--- Test: missing transcript file → zeros + parse-failed log entry ---'

sqlite3 "$DB" "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;"
(cd "$WT_PATH" && echo "$RANDOM-missing" >> work-missing.txt && git add work-missing.txt && git commit -qm 'feat: missing file work')

missing_transcript_input() {
  jq -n '{subagent_type: "swe", agent_transcript_path: "/tmp/does-not-exist-tmb-test.jsonl"}'
}

LOG="$HOME/.claude/tmb/logs/mcp-health.log"
LOG_BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)

run_hook "$(missing_transcript_input)" >/dev/null

AR_ROW3=$(sqlite3 "$DB" "SELECT tokens_in, tokens_out, tokens_total FROM agent_runs ORDER BY id DESC LIMIT 1;")
AR_TI3=$(echo "$AR_ROW3" | cut -d'|' -f1)
AR_TO3=$(echo "$AR_ROW3" | cut -d'|' -f2)
AR_TT3=$(echo "$AR_ROW3" | cut -d'|' -f3)

test_case "missing file: tokens_in=0"
assert_eq "0" "$AR_TI3" "tokens_in when file missing"

test_case "missing file: tokens_out=0"
assert_eq "0" "$AR_TO3" "tokens_out when file missing"

test_case "missing file: tokens_total=0"
assert_eq "0" "$AR_TT3" "tokens_total when file missing"

LOG_AFTER=$(wc -l < "$LOG" 2>/dev/null || echo 0)
PARSE_FAILED_LINES=$(grep '"kind":"agent-runs-stats-parse-failed"' "$LOG" 2>/dev/null | wc -l | tr -d ' ')

test_case "missing file: parse-failed diagnostic written to log"
if [ "$PARSE_FAILED_LINES" -ge 1 ]; then
  _pass
else
  _fail "expected at least 1 agent-runs-stats-parse-failed log line, got $PARSE_FAILED_LINES"
fi

summarize
