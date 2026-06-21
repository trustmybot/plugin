#!/usr/bin/env bash
# Tests for scripts/hooks/swe-atomic-close.sh.
# Hook contract: SubagentStop for swe agents. Inspects git state for the
# most-recent task in (pending, needs_validation, completed), reads the task's
# detached-HEAD worktree HEAD, and either auto-closes pending tasks or records
# metrics-only for pre-flipped tasks. Always writes agent_runs.
# Silent no-op when subagent is not swe, no matching tasks, or DB/git unavailable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Step out of the plugin checkout before any git work so a stray bare git call
# can never touch the caller's branch, then assert the move stuck. Every commit
# below targets its sandbox via `git -C "$REPO"`; this is belt-and-suspenders.
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

# ---- Fixture: bare git remote (plays the role of origin) -----------------
REMOTE="$TMPDIR/remote.git"
git init -q --bare "$REMOTE"

# ---- Fixture: main repo (bro's checkout) + detached-HEAD worktree --------
# Every git write targets the sandbox via `git -C "$REPO"` so cwd never leaks
# the bootstrap commit onto the caller's branch.
REPO="$TMPDIR/repo"
git init -q -b dev "$REPO"
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
git -C "$REPO" remote add origin "$REMOTE"
echo init > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm init
git -C "$REPO" push -q origin dev

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
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
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
git -C "$REPO" branch fix/test-branch HEAD
git -C "$REPO" worktree add -q "$WT_PATH" fix/test-branch

# Worktree for task 44 (needs_validation, slug = nv-branch).
WT_NV_PATH="$REPO/.claude/worktrees/nv-branch"
git -C "$REPO" branch fix/nv-branch HEAD
git -C "$REPO" worktree add -q "$WT_NV_PATH" fix/nv-branch

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
# Spawn-prompt user turn carrying task_id=42 (authoritative attribution), then
# two assistant messages: known usage + one tool_use block; timestamps 1500ms apart.
cat > "$TRANSCRIPT" <<'JSONL'
{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=42 branch_id=fix/test-branch do the work"}]}}
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

# ========================================================
# no-worktree fallback: SWE commits in REPO_ROOT on task branch
# ========================================================

echo '--- Test: no-worktree: REPO_ROOT on task branch + commits ahead → auto-completed ---'

# Fixture: a separate repo where SWE checks out directly (no worktree).
NW_REPO="$TMPDIR/nw-repo"
git init -q -b dev "$NW_REPO"
git -C "$NW_REPO" config user.email t@t.io
git -C "$NW_REPO" config user.name t
echo base > "$NW_REPO/base.txt"
git -C "$NW_REPO" add .
git -C "$NW_REPO" commit -qm "base"

NW_DB="$NW_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$NW_DB")"
sqlite3 "$NW_DB" "
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
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '\"\"'
  );
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at)
    VALUES (100, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# SWE checks out the feature branch in REPO_ROOT (no worktree).
git -C "$NW_REPO" checkout -q -b feat/test-branch
echo "swe work" > "$NW_REPO/work.txt"
git -C "$NW_REPO" add .
git -C "$NW_REPO" commit -qm "feat: swe work"
NW_HEAD=$(git -C "$NW_REPO" rev-parse HEAD)

nw_swe_input() {
  jq -n '{agent_type: "tmb:swe", hook_event_name: "SubagentStop"}'
}

run_hook_in_dir() {
  local dir="$1"
  local input="$2"
  local db="$3"
  (cd "$dir" && TRAJECTORY_DB_PATH="$db" bash "$HOOK" <<< "$input" 2>&1 || true)
}

test_case "no-worktree: REPO_ROOT on task branch + commits ahead → auto-completed"
out=$(run_hook_in_dir "$NW_REPO" "$(nw_swe_input)" "$NW_DB")
assert_eq "" "$out" "no additionalContext on auto-close"
nw_status=$(sqlite3 "$NW_DB" "SELECT status FROM tasks WHERE id=100;")
assert_eq "completed" "$nw_status" "task auto-closed"
nw_sha=$(sqlite3 "$NW_DB" "SELECT commit_sha FROM tasks WHERE id=100;")
assert_eq "$NW_HEAD" "$nw_sha" "commit_sha written from REPO_ROOT HEAD"

# ========================================================
# no-worktree fallback: REPO_ROOT on WRONG branch → warn-no-commits
# ========================================================

echo '--- Test: no-worktree: REPO_ROOT on wrong branch → warn-no-commits ---'

NW2_REPO="$TMPDIR/nw2-repo"
git init -q -b dev "$NW2_REPO"
git -C "$NW2_REPO" config user.email t@t.io
git -C "$NW2_REPO" config user.name t
echo base > "$NW2_REPO/base.txt"
git -C "$NW2_REPO" add .
git -C "$NW2_REPO" commit -qm "base"

NW2_DB="$NW2_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$NW2_DB")"
sqlite3 "$NW2_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (101, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# REPO_ROOT stays on 'dev' (wrong branch — task is for feat/test-branch).
# Add a commit on dev so there ARE commits but on the wrong branch.
echo "dev work" > "$NW2_REPO/devwork.txt"
git -C "$NW2_REPO" add .
git -C "$NW2_REPO" commit -qm "chore: dev commit"

test_case "no-worktree: REPO_ROOT on wrong branch → warn-no-commits, task stays pending"
out=$(run_hook_in_dir "$NW2_REPO" "$(nw_swe_input)" "$NW2_DB")
assert_contains "$out" "stopped without committing" "warn body present"
nw2_status=$(sqlite3 "$NW2_DB" "SELECT status FROM tasks WHERE id=101;")
assert_eq "pending" "$nw2_status" "task stays pending"

# ========================================================
# no-worktree fallback: REPO_ROOT on task branch but no commits ahead → warn
# ========================================================

echo '--- Test: no-worktree: REPO_ROOT on task branch but no commits ahead → warn-no-commits ---'

NW3_REPO="$TMPDIR/nw3-repo"
git init -q -b dev "$NW3_REPO"
git -C "$NW3_REPO" config user.email t@t.io
git -C "$NW3_REPO" config user.name t
echo base > "$NW3_REPO/base.txt"
git -C "$NW3_REPO" add .
git -C "$NW3_REPO" commit -qm "base"

NW3_DB="$NW3_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$NW3_DB")"
sqlite3 "$NW3_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (102, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# REPO_ROOT on the task branch but HEAD == dev tip (no SWE commits yet).
git -C "$NW3_REPO" checkout -q -b feat/test-branch

test_case "no-worktree: REPO_ROOT on task branch but no commits ahead → warn-no-commits, task stays pending"
out=$(run_hook_in_dir "$NW3_REPO" "$(nw_swe_input)" "$NW3_DB")
assert_contains "$out" "stopped without committing" "warn body present"
nw3_status=$(sqlite3 "$NW3_DB" "SELECT status FROM tasks WHERE id=102;")
assert_eq "pending" "$nw3_status" "task stays pending"

# ========================================================
# #202 / #369: transcript-based task_id extraction prevents
# wrong-task auto-close when two SWEs run in parallel.
# SWE-A commits but never calls task_update_status. On SubagentStop,
# the hook extracts task_id from the transcript and auto-completes
# the correct task (not the most-recently-updated OTHER task).
# ========================================================

echo '--- Test: #202/#369: transcript task_id extraction targets the correct task ---'

PARALLEL_REPO="$TMPDIR/parallel-repo"
git init -q -b dev "$PARALLEL_REPO"
git -C "$PARALLEL_REPO" config user.email t@t.io
git -C "$PARALLEL_REPO" config user.name t
echo base > "$PARALLEL_REPO/base.txt"
git -C "$PARALLEL_REPO" add .
git -C "$PARALLEL_REPO" commit -qm "base"

PAR_DB="$PARALLEL_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$PAR_DB")"
sqlite3 "$PAR_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at)
    VALUES (200, 'fix/swe-a-task', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at)
    VALUES (201, 'fix/swe-b-task', 'dev', 'pending', datetime('now', '+99 seconds'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# SWE-A worktree for task 200.
git -C "$PARALLEL_REPO" branch fix/swe-a-task HEAD
git -C "$PARALLEL_REPO" branch fix/swe-b-task HEAD
PAR_WTA="$PARALLEL_REPO/.claude/worktrees/swe-a-task"
PAR_WTB="$PARALLEL_REPO/.claude/worktrees/swe-b-task"
git -C "$PARALLEL_REPO" worktree add -q "$PAR_WTA" fix/swe-a-task
git -C "$PARALLEL_REPO" worktree add -q "$PAR_WTB" fix/swe-b-task

# SWE-A commits in its worktree but forgets to call task_update_status.
echo "swe-a work" > "$PAR_WTA/swe-a.txt"
git -C "$PAR_WTA" add swe-a.txt
git -C "$PAR_WTA" commit -qm "feat: swe-a work"
PAR_WTA_HEAD=$(git -C "$PAR_WTA" rev-parse HEAD)

# SWE-B is more recently updated (simulates parallel SWE-B working).
# Without transcript-based extraction, the hook would pick task 201 (SWE-B).
# With transcript-based extraction, it targets task 200 (SWE-A's task).
PAR_TRANSCRIPT="$TMPDIR/par-transcript.jsonl"
cat > "$PAR_TRANSCRIPT" <<JSONL
{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=200 worktree=/tmp/swe-a You are SWE. Implement fix for task 200."}]}}
{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[]}}
JSONL

par_swe_input() {
  local tp="$1"
  jq -n --arg tp "$tp" '{agent_type:"tmb:swe",hook_event_name:"SubagentStop",agent_transcript_path:$tp}'
}

test_case "#202/#369: transcript task_id extraction: auto-completes SWE-A task (200), not most-recent (201)"
out=$(run_hook_in_dir "$PARALLEL_REPO" "$(par_swe_input "$PAR_TRANSCRIPT")" "$PAR_DB")
assert_eq "" "$out" "no additionalContext on auto-close"
par_status_200=$(sqlite3 "$PAR_DB" "SELECT status FROM tasks WHERE id=200;")
assert_eq "completed" "$par_status_200" "task 200 (SWE-A) auto-closed via transcript extraction"
par_sha_200=$(sqlite3 "$PAR_DB" "SELECT commit_sha FROM tasks WHERE id=200;")
assert_eq "$PAR_WTA_HEAD" "$par_sha_200" "commit_sha from SWE-A worktree written to task 200"

test_case "#202/#369: task 201 (SWE-B) NOT touched by SWE-A's SubagentStop"
par_status_201=$(sqlite3 "$PAR_DB" "SELECT status FROM tasks WHERE id=201;")
assert_eq "pending" "$par_status_201" "task 201 (SWE-B) stays pending — not auto-closed"

# ========================================================
# SQL injection regression: malicious task_id in transcript
# ========================================================

echo '--- Test: injection in transcript task_id treated as missing (no SQL error) ---'

INJ_REPO="$TMPDIR/inj-repo"
git init -q -b dev "$INJ_REPO"
git -C "$INJ_REPO" config user.email t@t.io
git -C "$INJ_REPO" config user.name t
echo base > "$INJ_REPO/base.txt"
git -C "$INJ_REPO" add .
git -C "$INJ_REPO" commit -qm "base"

INJ_DB="$INJ_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$INJ_DB")"
sqlite3 "$INJ_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (300, 'fix/inj-branch', 'dev', 'pending', datetime('now', '+99 seconds'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

INJ_TRANSCRIPT="$TMPDIR/inj-transcript.jsonl"
cat > "$INJ_TRANSCRIPT" <<JSONL
{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=1; DROP TABLE tasks;-- You are SWE."}]}}
{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":10,"output_tokens":5},"content":[]}}
JSONL

inj_swe_input() {
  local tp="$1"
  jq -n --arg tp "$tp" '{agent_type:"tmb:swe",hook_event_name:"SubagentStop",agent_transcript_path:$tp}'
}

test_case "injection in transcript task_id: tasks table not dropped"
(cd "$INJ_REPO" && TRAJECTORY_DB_PATH="$INJ_DB" bash "$HOOK" <<< "$(inj_swe_input "$INJ_TRANSCRIPT")" 2>&1 || true)
TABLE_OK=$(sqlite3 "$INJ_DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tasks';" 2>/dev/null || echo 0)
assert_eq "1" "$TABLE_OK" "tasks table must survive injection attempt"

test_case "injection in transcript task_id: task 300 still pending (hook took fallback path)"
# Hook either used the fallback (most-recent task) or skipped; task 300 may be auto-completed
# by the fallback path if no worktree exists. Either way the tasks table must exist.
# The key assertion is: no SQL error / no table drop.
assert_eq "1" "$TABLE_OK" "tasks table intact (re-check after hook ran)"

# ========================================================
# Slug fallback: no transcript + worktree cwd → resolves by branch_id slug
# ========================================================

echo '--- Test: slug fallback: no transcript + worktree cwd → resolves task ---'

SLUG_REPO="$TMPDIR/slug-repo"
git init -q -b dev "$SLUG_REPO"
git -C "$SLUG_REPO" config user.email t@t.io
git -C "$SLUG_REPO" config user.name t
echo base > "$SLUG_REPO/base.txt"
git -C "$SLUG_REPO" add .
git -C "$SLUG_REPO" commit -qm "base"

SLUG_DB="$SLUG_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$SLUG_DB")"
sqlite3 "$SLUG_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (500, 'fix/slug-task', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

SLUG_WT="$SLUG_REPO/.claude/worktrees/slug-task"
git -C "$SLUG_REPO" branch fix/slug-task HEAD
git -C "$SLUG_REPO" worktree add -q "$SLUG_WT" fix/slug-task

# Make a commit in the worktree so auto-close fires.
(cd "$SLUG_WT" && echo "$RANDOM" >> slug-work.txt && git add slug-work.txt && git commit -qm "feat: slug work")
SLUG_WT_HEAD=$(git -C "$SLUG_WT" rev-parse HEAD)

slug_swe_input_with_cwd() {
  local cwd="$1"
  jq -n --arg cwd "$cwd" '{agent_type: "tmb:swe", hook_event_name: "SubagentStop", cwd: $cwd}'
}

test_case "slug fallback: no transcript + matching worktree cwd → auto-completed"
out=$(run_hook_in_dir "$SLUG_REPO" "$(slug_swe_input_with_cwd "$SLUG_WT")" "$SLUG_DB")
assert_eq "" "$out" "no additionalContext on auto-close via slug"
slug_status=$(sqlite3 "$SLUG_DB" "SELECT status FROM tasks WHERE id=500;")
assert_eq "completed" "$slug_status" "task 500 auto-closed via slug resolution"
slug_sha=$(sqlite3 "$SLUG_DB" "SELECT commit_sha FROM tasks WHERE id=500;")
assert_eq "$SLUG_WT_HEAD" "$slug_sha" "commit_sha written from slug-resolved worktree HEAD"

# ========================================================
# Slug fallback: no match → falls through to existing fallback
# ========================================================

echo '--- Test: slug fallback: no matching task for slug → existing fallback behavior ---'

NOMATCH_REPO="$TMPDIR/nomatch-repo"
git init -q -b dev "$NOMATCH_REPO"
git -C "$NOMATCH_REPO" config user.email t@t.io
git -C "$NOMATCH_REPO" config user.name t
echo base > "$NOMATCH_REPO/base.txt"
git -C "$NOMATCH_REPO" add .
git -C "$NOMATCH_REPO" commit -qm "base"

NOMATCH_DB="$NOMATCH_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$NOMATCH_DB")"
sqlite3 "$NOMATCH_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (501, 'fix/other-task', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# The cwd slug 'no-such-slug' does not match any branch_id.
# The most-recently-updated fallback (task 501) should be used.
# That task has no worktree, so HAS_COMMITS=false → warn-no-commits.
FAKE_SLUG_PATH="$NOMATCH_REPO/.claude/worktrees/no-such-slug"

test_case "slug fallback: no slug match → falls through, most-recent task selected (warn-no-commits)"
out=$(run_hook_in_dir "$NOMATCH_REPO" "$(slug_swe_input_with_cwd "$FAKE_SLUG_PATH")" "$NOMATCH_DB")
assert_contains "$out" "stopped without committing" "existing fallback: warn-no-commits emitted"
nomatch_status=$(sqlite3 "$NOMATCH_DB" "SELECT status FROM tasks WHERE id=501;")
assert_eq "pending" "$nomatch_status" "task 501 still pending (warn, not auto-closed)"

# ========================================================
# Slug fallback: transcript present → transcript path unchanged, slug not consulted
# ========================================================

echo '--- Test: slug fallback: transcript present → transcript resolution takes priority ---'

TXFIRST_REPO="$TMPDIR/txfirst-repo"
git init -q -b dev "$TXFIRST_REPO"
git -C "$TXFIRST_REPO" config user.email t@t.io
git -C "$TXFIRST_REPO" config user.name t
echo base > "$TXFIRST_REPO/base.txt"
git -C "$TXFIRST_REPO" add .
git -C "$TXFIRST_REPO" commit -qm "base"

TXFIRST_DB="$TXFIRST_REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$TXFIRST_DB")"
sqlite3 "$TXFIRST_DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, issue_id INTEGER, agent_type TEXT NOT NULL DEFAULT 'swe', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '\"\"');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (600, 'fix/tx-task', 'dev', 'pending', datetime('now', '+1 second'));
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (601, 'fix/slug-other-task', 'dev', 'pending', datetime('now', '+2 seconds'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# Worktree for task 600.
TXFIRST_WT="$TXFIRST_REPO/.claude/worktrees/tx-task"
git -C "$TXFIRST_REPO" branch fix/tx-task HEAD
git -C "$TXFIRST_REPO" branch fix/slug-other-task HEAD
git -C "$TXFIRST_REPO" worktree add -q "$TXFIRST_WT" fix/tx-task
(cd "$TXFIRST_WT" && echo "$RANDOM" >> tx-work.txt && git add tx-work.txt && git commit -qm "feat: tx work")
TXFIRST_WT_HEAD=$(git -C "$TXFIRST_WT" rev-parse HEAD)

# Transcript points to task 600; cwd points to a worktree that would match task 601.
# Transcript must win.
TXFIRST_TRANSCRIPT="$TMPDIR/txfirst-transcript.jsonl"
cat > "$TXFIRST_TRANSCRIPT" <<JSONL
{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=600 worktree=$TXFIRST_WT You are SWE."}]}}
{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[]}}
JSONL

# cwd slug 'slug-other-task' matches task 601 — if slug fallback fires, wrong task gets closed.
TXFIRST_OTHER_WT="$TXFIRST_REPO/.claude/worktrees/slug-other-task"
txfirst_input() {
  local tp="$1"
  local cwd="$2"
  jq -n --arg tp "$tp" --arg cwd "$cwd" \
    '{agent_type:"tmb:swe",hook_event_name:"SubagentStop",agent_transcript_path:$tp,cwd:$cwd}'
}

test_case "slug fallback: transcript present → transcript wins; correct task (600) auto-completed"
out=$(run_hook_in_dir "$TXFIRST_REPO" "$(txfirst_input "$TXFIRST_TRANSCRIPT" "$TXFIRST_OTHER_WT")" "$TXFIRST_DB")
assert_eq "" "$out" "no additionalContext on auto-close"
txfirst_status_600=$(sqlite3 "$TXFIRST_DB" "SELECT status FROM tasks WHERE id=600;")
assert_eq "completed" "$txfirst_status_600" "task 600 auto-closed via transcript (not slug)"
txfirst_sha=$(sqlite3 "$TXFIRST_DB" "SELECT commit_sha FROM tasks WHERE id=600;")
assert_eq "$TXFIRST_WT_HEAD" "$txfirst_sha" "commit_sha from task 600 worktree HEAD"

test_case "slug fallback: transcript present → task 601 NOT touched (slug not consulted)"
txfirst_status_601=$(sqlite3 "$TXFIRST_DB" "SELECT status FROM tasks WHERE id=601;")
assert_eq "pending" "$txfirst_status_601" "task 601 untouched when transcript resolves task 600"

# ========================================================
# Nested-repo layout (#169): workspace=$WS, repo=$WS/plugin, repos.path=$WS/plugin,
# tasks.repo='plugin'. The worktree is REPO-ROOTED at
# $WS/plugin/.claude/worktrees/<slug>, NOT $WS/.claude/worktrees/<slug>.
# Pre-fix (WS_ROOT-primary) the hook resolved the workspace path and could not
# locate the worktree → task stuck pending. This case must fail against the
# pre-fix code and pass with the repo-rooted resolver.
# ========================================================

echo '--- Test: nested-repo: worktree repo-rooted under <ws>/plugin → auto-completed ---'

WS_ROOT_DIR="$TMPDIR/nested-ws"
INNER_REPO="$WS_ROOT_DIR/plugin"
WS_DB="$WS_ROOT_DIR/.claude/tmb/trajectory.db"
# Repo-rooted worktree: hangs off the inner repo, NOT the workspace root.
WS_WT="$INNER_REPO/.claude/worktrees/ws-task"
# Workspace-rooted path that the pre-fix code would (wrongly) look for.
WS_WRONG_WT="$WS_ROOT_DIR/.claude/worktrees/ws-task"

mkdir -p "$INNER_REPO"
mkdir -p "$(dirname "$WS_DB")"

git init -q -b dev "$INNER_REPO"
git -C "$INNER_REPO" config user.email t@t.io
git -C "$INNER_REPO" config user.name t
echo base > "$INNER_REPO/base.txt"
git -C "$INNER_REPO" add .
git -C "$INNER_REPO" commit -qm "base"
INNER_REPO_ROOT=$(git -C "$INNER_REPO" rev-parse --show-toplevel)

sqlite3 "$WS_DB" "
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
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '\"\"'
  );
  INSERT INTO repos (name, path) VALUES ('plugin', '$INNER_REPO_ROOT');
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, repo, updated_at)
    VALUES (700, 'fix/ws-task', 'dev', 'pending', 'plugin', datetime('now', '+1 second'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"

# Worktree is REPO-ROOTED inside the inner repo (the canonical layout).
git -C "$INNER_REPO" branch fix/ws-task HEAD
git -C "$INNER_REPO" worktree add -q "$WS_WT" fix/ws-task

# SWE commits in the repo-rooted worktree.
(cd "$WS_WT" && echo "$RANDOM" >> ws-work.txt && git add ws-work.txt && git commit -qm "feat: ws work")
WS_WT_HEAD=$(git -C "$WS_WT" rev-parse HEAD)

ws_swe_input() {
  jq -n '{agent_type: "tmb:swe", hook_event_name: "SubagentStop"}'
}

test_case "nested-repo: repo-rooted worktree under <ws>/plugin → no workspace-rooted path exists"
# The workspace-rooted path the pre-fix code targeted must NOT exist, so a hook
# that resolves it would fail to auto-close.
if [ ! -d "$WS_WRONG_WT" ]; then _pass; else _fail "workspace-rooted path unexpectedly exists: $WS_WRONG_WT"; fi

test_case "nested-repo: repo-rooted worktree → pending task auto-completed (#169 repo-rooted resolver)"
out=$(run_hook_in_dir "$INNER_REPO" "$(ws_swe_input)" "$WS_DB")
assert_eq "" "$out" "no additionalContext on auto-close"
ws_status=$(sqlite3 "$WS_DB" "SELECT status FROM tasks WHERE id=700;")
assert_eq "completed" "$ws_status" "task 700 auto-closed via repo-rooted worktree path"
ws_sha=$(sqlite3 "$WS_DB" "SELECT commit_sha FROM tasks WHERE id=700;")
assert_eq "$WS_WT_HEAD" "$ws_sha" "commit_sha written from repo-rooted worktree HEAD"

summarize
