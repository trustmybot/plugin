#!/usr/bin/env bash
# Tests for scripts/hooks/reviewer-identity-observe.sh (PreToolUse on
# validation_record):
#   1. a pr-reviewer subagent payload (agent_id + agent_type pr-reviewer, bare
#      or plugin-prefixed) writes one reviewer_identity_observed row on the
#      task's issue with {task_id, attempt_n, session_id, agent_id, tool_use_id,
#      observed_at, consumed: 0}; a payload without tool_use_id still writes the
#      row with tool_use_id null
#   2. swe subagent and bro main-loop (no agent_id) payloads write nothing
#   3. every observed call is allowed
#   4. an unreadable DB denies with the db-unavailable reason
#   5. without jq it allows with a stderr note and writes nothing
#   6. through the trajectory-gates chain, a reviewer retry (first
#      validation_record fails on bad args, the second succeeds) leaves one
#      consumed and one superseded row; a main-loop validation_record with
#      agent='pr-reviewer' is denied by agent-arg-matches-caller and leaves the
#      existing row unconsumed and unsuperseded
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

# payload <agent_type|''> <agent_id|''> [tool_use_id|'']
payload() {
  jq -nc --arg t "$1" --arg g "$2" --arg u "${3-toolu_01ABCDEF}" '
    {hook_event_name: "PreToolUse", session_id: "main-session-1",
     tool_name: "mcp__plugin_tmb_trajectory-server__validation_record",
     tool_input: {agent: "pr-reviewer", task_id: "42", attempt_n: 2, verdict: "pass", feedback: "ok", mcp_available: true}}
    + (if $t == "" then {} else {agent_type: $t} end)
    + (if $g == "" then {} else {agent_id: $g} end)
    + (if $u == "" then {} else {tool_use_id: $u} end)'
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
ROW=$(sqlite3 "$DB" "SELECT issue_id || '|' || from_node || '|' || json_remove(content_json, '$.observed_at') FROM audit WHERE event_type = 'reviewer_identity_observed';")
assert_eq "7|hook:reviewer-identity-observe|{\"task_id\":42,\"attempt_n\":2,\"session_id\":\"main-session-1\",\"agent_id\":\"a1b2c3d4e5f6a7b8c\",\"tool_use_id\":\"toolu_01ABCDEF\",\"consumed\":0}" "$ROW" "row on the task's issue with the observed identity and tool_use_id"
OBSERVED_AT=$(sqlite3 "$DB" "SELECT json_extract(content_json, '$.observed_at') FROM audit WHERE event_type = 'reviewer_identity_observed';")
if printf '%s' "$OBSERVED_AT" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'; then OBS_ISO=yes; else OBS_ISO="no: $OBSERVED_AT"; fi
assert_eq "yes" "$OBS_ISO" "observed_at is a 24-char ms-ISO timestamp"

test_case "plugin-prefixed agent_type normalises to pr-reviewer"
OUT=$(run "$PROJ" "$(payload tmb:pr-reviewer b1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "2" "$(rows)" "second row written"

test_case "payload without tool_use_id still writes the row with tool_use_id null"
OUT=$(run "$PROJ" "$(payload pr-reviewer d1b2c3d4e5f6a7b8c "")")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "3" "$(rows)" "third row written"
assert_eq "null|0" "$(sqlite3 "$DB" "SELECT json_type(content_json, '$.tool_use_id') || '|' || json_extract(content_json, '$.consumed') FROM audit WHERE event_type = 'reviewer_identity_observed' ORDER BY id DESC LIMIT 1;")" "tool_use_id is JSON null"

test_case "swe subagent payload writes nothing"
OUT=$(run "$PROJ" "$(payload tmb:swe c1b2c3d4e5f6a7b8c)")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "3" "$(rows)" "no row for swe"

test_case "bro main-loop payload (no agent_id) writes nothing"
OUT=$(run "$PROJ" "$(payload "" "")")
assert_eq "allow" "$(decision "$OUT")" "allowed"
OUT=$(run "$PROJ" "$(payload pr-reviewer "")")
assert_eq "allow" "$(decision "$OUT")" "allowed without agent_id"
assert_eq "3" "$(rows)" "no row without agent_id"

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

test_case "no jq: allowed with a stderr note, nothing written"
. "$HERE/fixtures/no-jq-path.sh"
NOJQ=$(no_jq_path "$TMPDIR/nojq")
rc=0
ERR=$(cd "$PROJ" && payload pr-reviewer e1b2c3d4e5f6a7b8c | PATH="$NOJQ" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_contains "$ERR" "jq not found" "stderr names jq"
assert_eq "3" "$(rows)" "no row"

# chain <payload> — the payload through the trajectory-gates registration.
chain() {
  (cd "$PROJ" && printf '%s' "$1" \
    | CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null || true)
}

# server <payload> — the payload's tool_input through the built validation_record handler.
server() {
  (cd "$PROJ" && printf '%s' "$1" | jq -c '.tool_input' | CLAUDE_PROJECT_DIR="$PROJ" node --experimental-sqlite --no-warnings --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const { TrajectoryDB } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js');
    const { validationTools } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/tools/validation.js');
    const db = new TrajectoryDB('$DB');
    const res = await validationTools(db).handlers.validation_record(JSON.parse(readFileSync(0, 'utf8')));
    db.close();
    process.stdout.write(res.isError ? 'error' : 'ok');
  " 2>&1)
}

# state <attempt_n> — consumed|superseded|superseded_by per observation row, oldest first.
state() {
  sqlite3 "$DB" "SELECT group_concat(s, ' ') FROM (SELECT json_extract(content_json, '$.consumed') || '|' || COALESCE(json_extract(content_json, '$.superseded'), '-') || '|' || COALESCE(json_extract(content_json, '$.superseded_by') - (SELECT MIN(id) FROM audit WHERE event_type = 'reviewer_identity_observed' AND json_extract(content_json, '$.attempt_n') = $1), '-') AS s FROM audit WHERE event_type = 'reviewer_identity_observed' AND json_extract(content_json, '$.attempt_n') = $1 ORDER BY id);"
}

test_case "a reviewer retry through the chain leaves one consumed and one superseded row"
RETRY_BAD=$(payload pr-reviewer f1b2c3d4e5f6a7b8c toolu_retry1 | jq -c '.tool_input.attempt_n = 3 | .tool_input.verdict = "approve"')
assert_eq "allow" "$(decision "$(chain "$RETRY_BAD")")" "the first call passes the chain"
assert_eq "error" "$(server "$RETRY_BAD")" "and fails on bad args at the server"
assert_eq "0|-|-" "$(state 3)" "its row is unconsumed"
RETRY_OK=$(payload pr-reviewer f1b2c3d4e5f6a7b8c toolu_retry2 | jq -c '.tool_input.attempt_n = 3')
assert_eq "allow" "$(decision "$(chain "$RETRY_OK")")" "the retry passes the chain"
assert_eq "ok" "$(server "$RETRY_OK")" "and records the verdict"
assert_eq "0|1|1 1|-|-" "$(state 3)" "the older row is superseded by the consumed retry row"

test_case "a main-loop validation_record(agent='pr-reviewer') is denied and consumes nothing"
assert_eq "allow" "$(decision "$(chain "$(payload pr-reviewer f2b2c3d4e5f6a7b8c toolu_obs | jq -c '.tool_input.attempt_n = 4')")")" "a reviewer observation for attempt 4"
BEFORE=$(rows)
MAIN=$(payload "" "" toolu_main | jq -c '.tool_input.attempt_n = 4')
OUT=$(chain "$MAIN")
assert_eq "deny" "$(decision "$OUT")" "agent-arg-matches-caller denies the main loop"
assert_contains "$OUT" "pass agent='bro'" "agent-arg-matches-caller's reason"
assert_eq "$BEFORE" "$(rows)" "no row written"
assert_eq "0|-|-" "$(state 4)" "the reviewer row stays unconsumed and unsuperseded"

summarize
