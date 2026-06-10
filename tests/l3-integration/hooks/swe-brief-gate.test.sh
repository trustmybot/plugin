#!/usr/bin/env bash
# Tests for scripts/hooks/swe-brief-gate.sh
#
# Hook contract: deny-until-briefed gate for SWE subagents.
# SWE must call task_brief before any other trajectory-server MCP tool.
# Sentinel is written to the audit table on the first task_brief call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-brief-gate.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Minimal schema: audit + tasks + issues.
sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    branch_id TEXT,
    from_node TEXT NOT NULL DEFAULT 'swe',
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks VALUES (10, 1, 'feat/my-feature', 'pending', 'spec here');
"

# Helper: create a fake transcript with task_id=N.
make_transcript() {
  local task_id="$1"
  local tf="$TMPDIR/transcript_${task_id}.jsonl"
  printf '{"message":{"content":[{"type":"text","text":"task_id=%s worktree: /some/path"}]}}\n' "$task_id" > "$tf"
  echo "$tf"
}

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

# ---- Non-SWE caller passes through silently ---------------------------------
test_case "non-SWE caller (bro): any tool allowed without sentinel"
TR=$(make_transcript 10)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "bro",
  tool_name: "mcp__tmb__trajectory-server__task_get",
  agent_transcript_path: $tr,
  tool_input: {}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "bro should pass through silently"

# ---- task_brief call itself is always allowed (writes sentinel) --------------
test_case "SWE caller: task_brief call allowed (writes sentinel)"
TR=$(make_transcript 10)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_brief",
  agent_transcript_path: $tr,
  tool_input: {}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "task_brief should be allowed and write sentinel"

# Verify sentinel was written.
SENTINEL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='swe_brief_fetched' AND content_json LIKE '%\"task_id\":10%';" 2>/dev/null)
assert_eq "1" "$SENTINEL" "sentinel row should exist after task_brief call"

# ---- After sentinel exists, any tool is allowed ----------------------------
test_case "SWE caller: any tool allowed after sentinel exists"
TR=$(make_transcript 10)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  agent_transcript_path: $tr,
  tool_input: {task_id: "10"}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "tool after sentinel should pass through silently"

# ---- Non-task_brief with NO sentinel is DENIED ------------------------------
test_case "SWE caller: non-task_brief tool DENIED when no sentinel (new task)"
sqlite3 "$DB" "INSERT INTO tasks VALUES (20, 1, 'feat/new-task', 'pending', 'spec');"
TR=$(make_transcript 20)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  agent_transcript_path: $tr,
  tool_input: {task_id: "20"}
}')
out=$(run_hook "$INPUT")
assert_contains "$out" '"permissionDecision":"deny"' "should deny without sentinel"
assert_contains "$out" "task_brief" "deny reason should mention task_brief"
assert_contains "$out" "20" "deny reason should mention the task_id"

# ---- tmb: prefix normalized (tmb:swe treated as swe) -----------------------
test_case "SWE caller with tmb: prefix: denied without sentinel"
sqlite3 "$DB" "INSERT INTO tasks VALUES (30, 1, 'feat/prefixed', 'pending', 'spec');" 2>/dev/null || true
TR=$(make_transcript 30)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "tmb:swe",
  tool_name: "mcp__tmb__trajectory-server__task_get",
  agent_transcript_path: $tr,
  tool_input: {}
}')
out=$(run_hook "$INPUT")
assert_contains "$out" '"permissionDecision":"deny"' "tmb:swe prefix should also be denied without sentinel"

# ---- task_brief with tmb: prefix writes sentinel and allows -----------------
test_case "SWE caller with tmb: prefix: task_brief writes sentinel"
TR=$(make_transcript 30)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "tmb:swe",
  tool_name: "mcp__tmb__trajectory-server__task_brief",
  agent_transcript_path: $tr,
  tool_input: {}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "task_brief with tmb: prefix should be allowed"
SENTINEL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='swe_brief_fetched' AND content_json LIKE '%\"task_id\":30%';" 2>/dev/null)
assert_eq "1" "$SENTINEL" "sentinel should be written for task 30"

# ---- Duplicate task_brief calls do not double-write sentinel ----------------
test_case "SWE caller: duplicate task_brief call does not create duplicate sentinel"
TR=$(make_transcript 10)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_brief",
  agent_transcript_path: $tr,
  tool_input: {}
}')
run_hook "$INPUT" >/dev/null
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='swe_brief_fetched' AND content_json LIKE '%\"task_id\":10%';" 2>/dev/null)
assert_eq "1" "$COUNT" "duplicate task_brief should not write second sentinel"

# ---- No DB: hook allows everything (can't enforce without state) ------------
test_case "No DB: hook allows any SWE tool call silently"
INPUT=$(jq -n '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {task_id: "99"}
}')
out=$(echo "$INPUT" | TRAJECTORY_DB_PATH="$TMPDIR/nonexistent.db" bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "no DB should allow all calls"

# ---- No task_id: hook allows (can't enforce without task context) -----------
test_case "No task_id in transcript or tool_input: hook allows"
INPUT=$(jq -n '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "no task_id should allow"

# ---- bro context: NOT denied regardless of tool or sentinel -----------------
test_case "bro context: task_update_status not denied even without sentinel"
sqlite3 "$DB" "INSERT INTO tasks VALUES (40, 1, 'feat/bro-task', 'pending', 'spec');" 2>/dev/null || true
TR=$(make_transcript 40)
INPUT=$(jq -n --arg tr "$TR" '{
  agent_type: "bro",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  agent_transcript_path: $tr,
  tool_input: {task_id: "40"}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "bro should never be denied by brief gate"

# ---- SQL injection via tool_input.task_id: treated as missing ----------------
test_case "Injection: task_id='1; DROP TABLE tasks;--' treated as missing (no SQL error, no row)"
AUDIT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
INPUT=$(jq -n '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {task_id: "1; DROP TABLE tasks;--"}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "injected task_id should be treated as missing (allow)"
assert_not_contains "$out" "Error" "injected task_id should not surface a SQL error"
TASKS_TABLE=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';")
assert_eq "tasks" "$TASKS_TABLE" "tasks table must survive injection attempt"
AUDIT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
assert_eq "$AUDIT_BEFORE" "$AUDIT_AFTER" "no audit row should be written for injected task_id"

test_case "Injection: task_brief with injected task_id writes no sentinel"
INPUT=$(jq -n '{
  agent_type: "swe",
  tool_name: "mcp__tmb__trajectory-server__task_brief",
  tool_input: {task_id: "1; DROP TABLE tasks;--"}
}')
out=$(run_hook "$INPUT")
assert_eq "" "$out" "injected task_brief should pass through silently"
AUDIT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
assert_eq "$AUDIT_BEFORE" "$AUDIT_AFTER" "injected task_brief should not write a sentinel row"

summarize
