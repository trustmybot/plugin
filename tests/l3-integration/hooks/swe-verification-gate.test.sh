#!/usr/bin/env bash
# Tests for scripts/hooks/swe-verification-gate.sh
#
# Hook contract: PreToolUse gate on task_update_status(agent=swe, status=completed).
# Reads the typed `verification` column (JSON array of command strings, Typed
# Rails #673), runs each command in the task worktree. Deny on non-zero exit or
# total timeout. Allow on pass, empty array, or valid waiver.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-verification-gate.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Workspace-above-repo layout (mirrors the real TMB workspace):
#   <ws>/.claude/tmb/trajectory.db   — DB lives here
#   <ws>/.claude/worktrees/<slug>/   — worktrees here
#   <ws>/plugin/                     — repo here (separate from ws root)
WS="$TMPDIR/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Worktrees hang off the workspace .claude dir (not the repo).
WT_ROOT="$WS/.claude/worktrees"
mkdir -p "$WT_ROOT/my-feature"

# Fake repo dir — hook runs with cwd here in workspace-above-repo tests.
REPO_DIR="$WS/plugin"
mkdir -p "$REPO_DIR"

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
    spec_body TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '[]'
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
  INSERT INTO tasks VALUES (1, 1, 'feat/my-feature', 'pending', '', '[\"bash tests/run.sh\"]');
  INSERT INTO tasks VALUES (2, 1, 'feat/no-verify', 'pending', '', '[]');
  INSERT INTO tasks VALUES (3, 1, 'feat/fail-verify', 'pending', '', '[\"exit 1\"]');
  INSERT INTO tasks VALUES (4, 1, 'feat/multi-cmd', 'pending', '', '[\"echo ok\",\"exit 0\"]');
"

# Create a passing test runner in the worktree.
mkdir -p "$WT_ROOT/my-feature/tests"
echo '#!/usr/bin/env bash' > "$WT_ROOT/my-feature/tests/run.sh"
echo 'echo "all tests pass"' >> "$WT_ROOT/my-feature/tests/run.sh"
chmod +x "$WT_ROOT/my-feature/tests/run.sh"
mkdir -p "$WT_ROOT/fail-verify"
mkdir -p "$WT_ROOT/no-verify"
mkdir -p "$WT_ROOT/multi-cmd"

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

make_input() {
  local agent="$1" status="$2" task_id="$3"
  jq -n --arg a "$agent" --arg s "$status" --arg t "$task_id" '{
    tool_name: "mcp__tmb__trajectory-server__task_update_status",
    tool_input: {agent: $a, status: $s, task_id: $t}
  }'
}

# ---- Non-SWE caller: allowed ------------------------------------------------
test_case "non-SWE caller (bro) completing task: allowed"
out=$(run_hook "$(make_input bro completed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro completing should not be gated"

# ---- SWE setting status != completed: allowed -------------------------------
test_case "SWE setting status=running: allowed (not completing)"
out=$(run_hook "$(make_input swe running 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "status=running should not trigger gate"

test_case "SWE setting status=failed: allowed"
out=$(run_hook "$(make_input swe failed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "status=failed should not trigger gate"

# ---- Empty typed verification[]: allow with advisory ------------------------
test_case "SWE completing task with empty typed verification[]: allowed with advisory"
out=$(run_hook "$(make_input swe completed 2)")
assert_not_contains "$out" '"permissionDecision":"deny"' "empty verification[] should allow"
assert_contains "$out" "additionalContext" "should emit advisory additionalContext"
assert_contains "$out" "no typed verification" "advisory should mention missing typed field"

# ---- Passing verification: allowed ------------------------------------------
test_case "SWE completing task with passing verification: allowed"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "passing verification should allow"

# ---- Failing verification: DENIED ------------------------------------------
test_case "SWE completing task with failing verification command: DENIED"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 3)")
assert_contains "$out" '"permissionDecision":"deny"' "failing verification should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Multi-command verification that passes: allowed ------------------------
test_case "SWE completing task with multi-command verification (all pass): allowed"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 4)")
assert_not_contains "$out" '"permissionDecision":"deny"' "multi-command all-pass should allow"

# ---- Waiver with >=10 chars: allowed + audit row ----------------------------
test_case "SWE completing with valid waiver (>=10 chars): allowed"
WAIVER="emergency hotfix, tests not applicable here"
INPUT=$(jq -n --arg w "$WAIVER" '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "3", waive_verification_gate_reason: $w}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "valid waiver should allow"
AUDIT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived';" 2>/dev/null)
assert_eq "1" "$AUDIT" "waiver should write audit row"

# ---- Waiver with <10 chars: NOT a valid waiver, falls through to verification ---
test_case "SWE completing with short waiver (<10 chars): not treated as waiver"
INPUT=$(jq -n '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "3", waive_verification_gate_reason: "short"}
}')
out=$(cd "$REPO_DIR" && run_hook "$INPUT")
assert_contains "$out" '"permissionDecision":"deny"' "short waiver should not bypass verification"

# ---- No DB: allowed ---------------------------------------------------------
test_case "No DB: gate allows silently"
out=$(echo '{"tool_input":{"agent":"swe","status":"completed","task_id":"1"}}' | \
  TRAJECTORY_DB_PATH="$TMPDIR/nonexistent.db" bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "no DB should allow"

# ---- Timeout: DENIED --------------------------------------------------------
test_case "Verification timeout: DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (99, 1, 'feat/slow-test', 'pending', '', '[\"sleep 5\",\"echo done\"]');
"
mkdir -p "$WT_ROOT/slow-test"
out=$(cd "$REPO_DIR" && \
  TMB_VERIFICATION_TIMEOUT_S=0 run_hook "$(make_input swe completed 99)")
assert_contains "$out" '"permissionDecision":"deny"' "timeout should deny"
assert_contains "$out" "timed out" "deny reason should mention timeout"

# ---- SQL injection via task_id: treated as missing ---------------------------
test_case "Injection: task_id='1; DROP TABLE tasks;--' treated as missing (no SQL error, no row)"
AUDIT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
INPUT=$(jq -n '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "1; DROP TABLE tasks;--", waive_verification_gate_reason: "waiver text long enough"}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "injected task_id should be treated as missing (allow)"
assert_not_contains "$out" "Error" "injected task_id should not surface a SQL error"
TASKS_TABLE=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';")
assert_eq "tasks" "$TASKS_TABLE" "tasks table must survive injection attempt"
AUDIT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
assert_eq "$AUDIT_BEFORE" "$AUDIT_AFTER" "no audit row should be written for injected task_id"

# ---- Waiver reason with single quotes: audit row written intact --------------
test_case "Waiver reason containing single quotes: allowed, audit row intact"
WAIVER="tests can't run here — it's a doc-only change"
INPUT=$(jq -n --arg w "$WAIVER" '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "4", waive_verification_gate_reason: $w}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "quoted waiver should allow"
ROW=$(sqlite3 "$DB" "SELECT content_json FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;")
assert_contains "$ROW" "it's a doc-only change" "stored content_json should retain single quotes"
EXTRACTED=$(sqlite3 "$DB" "SELECT json_extract(content_json, '\$.waiver_reason') FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;")
assert_contains "$EXTRACTED" "can't run here" "content_json should be valid JSON (json_extract works)"

# ---- Multi-command typed verification[]: passing -----------------------------
test_case "multi-command typed verification[]: all pass → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (10, 1, 'feat/typed-pass', 'pending', '', '[\"echo typed-ok\",\"exit 0\"]');
"
mkdir -p "$WT_ROOT/typed-pass"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "typed multi-command all-pass should allow"

# ---- Typed verification[]: failing command -----------------------------------
test_case "typed verification[]: failing command → DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (11, 1, 'feat/typed-fail', 'pending', '', '[\"exit 1\"]');
"
mkdir -p "$WT_ROOT/typed-fail"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 11)")
assert_contains "$out" '"permissionDecision":"deny"' "typed failing cmd should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Typed verification[] with shell metacharacters in a command -------------
test_case "typed verification[]: command with pipes/redirects runs verbatim → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (12, 1, 'feat/typed-shell', 'pending', '', '[\"echo a | grep a\"]');
"
mkdir -p "$WT_ROOT/typed-shell"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 12)")
assert_not_contains "$out" '"permissionDecision":"deny"' "shell-metachar command should run and pass"

# ---- Workspace-above-repo layout: gate runs (no skip warning) ----------------
# Layout: ws/.claude/tmb/trajectory.db  +  ws/.claude/worktrees/<slug>/
# Hook runs from ws/plugin (the repo), not the workspace root.
# With the old PWD walk-up the gate would skip (worktrees not under ws/plugin).
# With the new DB-derived resolution the gate finds ws/.claude/worktrees/.
test_case "workspace-above-repo layout: gate resolves worktree and runs (no skip)"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (20, 1, 'feat/ws-above-repo', 'pending', '', '[\"echo ws-above-repo-ok\"]');
"
mkdir -p "$WT_ROOT/ws-above-repo"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 20)")
assert_not_contains "$out" "verification gate skipped" "workspace-above-repo gate must not skip"
assert_not_contains "$out" '"permissionDecision":"deny"' "workspace-above-repo passing cmd should allow"

summarize
