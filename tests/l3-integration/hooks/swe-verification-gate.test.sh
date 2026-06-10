#!/usr/bin/env bash
# Tests for scripts/hooks/swe-verification-gate.sh
#
# Hook contract: PreToolUse gate on task_update_status(agent=swe, status=completed).
# Extracts ## Verification block from spec_body, runs each command in the
# task worktree. Deny on non-zero exit or total timeout. Allow on pass, no block,
# or valid waiver.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-verification-gate.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Create a fake worktree directory for tests.
WT_ROOT="$TMPDIR/repo/.claude/worktrees"
mkdir -p "$WT_ROOT/my-feature"

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
  INSERT INTO tasks VALUES (1, 1, 'feat/my-feature', 'pending', '## Verification' || char(10) || 'bash tests/run.sh' || char(10));
  INSERT INTO tasks VALUES (2, 1, 'feat/no-verify', 'pending', '## Description' || char(10) || 'No verification block here.' || char(10));
  INSERT INTO tasks VALUES (3, 1, 'feat/fail-verify', 'pending', '## Verification' || char(10) || 'exit 1' || char(10));
  INSERT INTO tasks VALUES (4, 1, 'feat/multi-cmd', 'pending', '## Verification' || char(10) || 'echo ok' || char(10) || 'exit 0' || char(10));
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

# ---- No ## Verification block: allow with advisory --------------------------
test_case "SWE completing task with no ## Verification block: allowed with advisory"
out=$(run_hook "$(make_input swe completed 2)")
assert_not_contains "$out" '"permissionDecision":"deny"' "no verification block should allow"
assert_contains "$out" "additionalContext" "should emit advisory additionalContext"
assert_contains "$out" "no ## Verification block" "advisory should mention missing block"

# ---- Passing verification: allowed ------------------------------------------
test_case "SWE completing task with passing verification: allowed"
out=$(cd "$TMPDIR/repo" && run_hook "$(make_input swe completed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "passing verification should allow"

# ---- Failing verification: DENIED ------------------------------------------
test_case "SWE completing task with failing verification command: DENIED"
out=$(cd "$TMPDIR/repo" && run_hook "$(make_input swe completed 3)")
assert_contains "$out" '"permissionDecision":"deny"' "failing verification should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Multi-command verification that passes: allowed ------------------------
test_case "SWE completing task with multi-command verification (all pass): allowed"
out=$(cd "$TMPDIR/repo" && run_hook "$(make_input swe completed 4)")
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
out=$(cd "$TMPDIR/repo" && run_hook "$INPUT")
assert_contains "$out" '"permissionDecision":"deny"' "short waiver should not bypass verification"

# ---- No DB: allowed ---------------------------------------------------------
test_case "No DB: gate allows silently"
out=$(echo '{"tool_input":{"agent":"swe","status":"completed","task_id":"1"}}' | \
  TRAJECTORY_DB_PATH="$TMPDIR/nonexistent.db" bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "no DB should allow"

# ---- Timeout: DENIED --------------------------------------------------------
test_case "Verification timeout: DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (99, 1, 'feat/slow-test', 'pending',
    '## Verification' || char(10) || 'sleep 5' || char(10) || 'echo done' || char(10));
"
mkdir -p "$WT_ROOT/slow-test"
out=$(cd "$TMPDIR/repo" && \
  TMB_VERIFICATION_TIMEOUT_S=0 run_hook "$(make_input swe completed 99)")
assert_contains "$out" '"permissionDecision":"deny"' "timeout should deny"
assert_contains "$out" "timed out" "deny reason should mention timeout"

summarize
