#!/usr/bin/env bash
# Tests for scripts/hooks/reviewer-identity-observe.sh (PreToolUse on
# validation_record):
#   1. a pr-reviewer subagent payload (agent_id + agent_type pr-reviewer, bare
#      or plugin-prefixed) writes one reviewer_identity_observed row on the
#      task's issue with {task_id, attempt_n, session_id, agent_id, consumed: 0}
#   2. swe subagent and bro main-loop (no agent_id) payloads write nothing
#   3. every observed call is allowed
#   4. an unreadable DB denies with the db-unavailable reason
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/reviewer-identity-observe.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

PROJ="$TMPDIR/proj"
DB="$PROJ/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-11T19:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'review', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at)
    VALUES (42, 7, 'fix/review', 'dev', 'd', 'closed', '$NOW', '$NOW');
"

# payload <agent_type|''> <agent_id|''>
payload() {
  jq -nc --arg t "$1" --arg g "$2" '
    {hook_event_name: "PreToolUse", session_id: "main-session-1",
     tool_name: "mcp__plugin_tmb_trajectory-server__validation_record",
     tool_input: {agent: "pr-reviewer", task_id: "42", attempt_n: 2, verdict: "pass", feedback: "ok", mcp_available: true}}
    + (if $t == "" then {} else {agent_type: $t} end)
    + (if $g == "" then {} else {agent_id: $g} end)'
}

# run <project> <payload>
run() {
  (cd "$1" && printf '%s' "$2" | CLAUDE_PROJECT_DIR="$1" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>&1 || true)
}

decision() {
  local d
  d=$(printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null || true)
  printf '%s' "${d:-allow}"
}

rows() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type = 'reviewer_identity_observed';"
}

test_case "pr-reviewer subagent payload writes the observed row"
OUT=$(run "$PROJ" "$(payload pr-reviewer a1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "observe-only: allowed"
assert_eq "1" "$(rows)" "one row written"
ROW=$(sqlite3 "$DB" "SELECT issue_id || '|' || from_node || '|' || content_json FROM audit WHERE event_type = 'reviewer_identity_observed';")
assert_eq "7|hook:reviewer-identity-observe|{\"task_id\":42,\"attempt_n\":2,\"session_id\":\"main-session-1\",\"agent_id\":\"a1b2c3d4e5f6a7b8c\",\"consumed\":0}" "$ROW" "row on the task's issue with the observed identity"

test_case "plugin-prefixed agent_type normalises to pr-reviewer"
OUT=$(run "$PROJ" "$(payload tmb:pr-reviewer b1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "2" "$(rows)" "second row written"

test_case "swe subagent payload writes nothing"
OUT=$(run "$PROJ" "$(payload tmb:swe c1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "2" "$(rows)" "no row for swe"

test_case "bro main-loop payload (no agent_id) writes nothing"
OUT=$(run "$PROJ" "$(payload "" "")")
assert_eq "allow" "$(decision "$OUT")" "allowed"
OUT=$(run "$PROJ" "$(payload pr-reviewer "")")
assert_eq "allow" "$(decision "$OUT")" "allowed without agent_id"
assert_eq "2" "$(rows)" "no row without agent_id"

test_case "unreadable DB denies"
BROKEN="$TMPDIR/broken"
mkdir -p "$BROKEN/.claude/tmb"
printf 'not a database' > "$BROKEN/.claude/tmb/trajectory.db"
OUT=$(run "$BROKEN" "$(payload pr-reviewer a1b2c3d4e5f6a7b8c)")
assert_eq "deny" "$(decision "$OUT")" "fail closed"
assert_contains "$OUT" "trajectory DB unavailable" "the db-unavailable reason"

test_case "project without a trajectory DB is allowed"
mkdir -p "$TMPDIR/bare"
OUT=$(run "$TMPDIR/bare" "$(payload pr-reviewer a1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "unresolved DB: allowed"

summarize
