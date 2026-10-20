#!/usr/bin/env bash
# Tests for scripts/hooks/agent-arg-matches-caller.sh (PreToolUse on every
# trajectory-server tool):
#   1. a subagent payload's agent_type (swe, pr-reviewer, consultant) must equal
#      tool_input.agent; the main session (no agent_type) must pass bro
#   2. a mismatch denies naming the tool and both values, and writes one
#      agent_arg_mismatch row on the task's issue, else the system issue -1
#   3. a missing agent arg is allowed; plugin-prefixed roles compare equal
#   4. without a usable DB a mismatch still denies and a match still allows
#   5. the trajectory-gates chain denies a mismatch end to end, and a denied
#      validation_record leaves no reviewer_identity_observed row
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/agent-arg-matches-caller.sh"

TMPDIR=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-agent-arg-matches-caller.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

PROJ="$TMPDIR/proj"
DB="$PROJ/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-12T10:00:00.000Z"
sqlite3 "$DB" "
  INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (-1, 'system', 'open', '$NOW', '$NOW');
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'roles', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at)
    VALUES (42, 7, 'fix/roles', 'dev', 'd', 'running', '$NOW', '$NOW');
"

# payload <tool> <agent_type|''> <agent|''> [<task_id>]
payload() {
  jq -nc --arg tool "$1" --arg t "$2" --arg a "$3" --arg tid "${4:-}" '
    {hook_event_name: "PreToolUse", session_id: "main-session-1",
     tool_name: ("mcp__plugin_tmb_trajectory-server__" + $tool),
     tool_input: ((if $a == "" then {} else {agent: $a} end)
                  + (if $tid == "" then {} else {task_id: ($tid | tonumber)} end))}
    + (if $t == "" then {} else {agent_type: $t, agent_id: "a1b2c3d4e5f6a7b8c"} end)'
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
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type = 'agent_arg_mismatch';"
}

test_case "pr-reviewer subagent passing agent='bro' is denied with an audit row"
OUT=$(run "$PROJ" "$(payload audit_append pr-reviewer bro 42)")
assert_eq "deny" "$(decision "$OUT")" "denied"
assert_contains "$OUT" "BLOCKED: audit_append called with agent='bro' but the caller is a pr-reviewer subagent; pass agent='pr-reviewer'." "reason names tool and both values"
assert_eq "1" "$(rows)" "one row written"
ROW=$(sqlite3 "$DB" "SELECT issue_id || '|' || from_node || '|' || content_json FROM audit WHERE event_type = 'agent_arg_mismatch';")
assert_eq '7|hook:agent-arg-matches-caller|{"tool":"audit_append","given":"bro","actual":"pr-reviewer","task_id":42}' "$ROW" "row on the task's issue with tool, given, actual"

test_case "swe subagent passing agent='swe' is allowed"
OUT=$(run "$PROJ" "$(payload task_update_status swe swe 42)")
assert_eq "allow" "$(decision "$OUT")" "allowed"
assert_eq "1" "$(rows)" "no row for a match"

test_case "swe subagent passing agent='bro' is denied"
OUT=$(run "$PROJ" "$(payload bro_atomic_close tmb:swe bro)")
assert_eq "deny" "$(decision "$OUT")" "denied"
assert_contains "$OUT" "pass agent='swe'" "reason names the caller's role"
assert_eq "2" "$(rows)" "second row written"
ISSUE=$(sqlite3 "$DB" "SELECT issue_id FROM audit WHERE event_type = 'agent_arg_mismatch' ORDER BY id DESC LIMIT 1;")
assert_eq "-1" "$ISSUE" "no task_id: row on the system issue"

test_case "main session passing agent='bro' is allowed"
OUT=$(run "$PROJ" "$(payload task_update_spec "" bro 42)")
assert_eq "allow" "$(decision "$OUT")" "allowed"

test_case "main session passing agent='swe' is denied"
OUT=$(run "$PROJ" "$(payload task_update_status "" swe 42)")
assert_eq "deny" "$(decision "$OUT")" "denied"
assert_contains "$OUT" "but the caller is the main session (bro); pass agent='bro'." "reason names the main session"
assert_eq "3" "$(rows)" "third row written"

test_case "consultant agent_type cto passing agent='cto' is allowed"
OUT=$(run "$PROJ" "$(payload discussion_append cto cto)")
assert_eq "allow" "$(decision "$OUT")" "allowed"

test_case "consultant agent_type cto passing agent='bro' is denied"
OUT=$(run "$PROJ" "$(payload issue_create cto bro)")
assert_eq "deny" "$(decision "$OUT")" "denied"
assert_contains "$OUT" "a cto subagent; pass agent='cto'" "reason names the consultant"
assert_eq "4" "$(rows)" "fourth row written"

test_case "no agent arg is allowed"
OUT=$(run "$PROJ" "$(payload world_model_get pr-reviewer "")")
assert_eq "allow" "$(decision "$OUT")" "subagent without agent: allowed"
OUT=$(run "$PROJ" "$(payload world_model_get "" "")")
assert_eq "allow" "$(decision "$OUT")" "main session without agent: allowed"

test_case "role aliases normalise to the same role"
OUT=$(run "$PROJ" "$(payload validation_record tmb:pr-reviewer pr-reviewer 42)")
assert_eq "allow" "$(decision "$OUT")" "prefixed agent_type, bare agent"
OUT=$(run "$PROJ" "$(payload validation_record pr-reviewer tmb:pr-reviewer 42)")
assert_eq "allow" "$(decision "$OUT")" "bare agent_type, prefixed agent"
OUT=$(run "$PROJ" "$(payload task_get "" BRO)")
assert_eq "allow" "$(decision "$OUT")" "case-blind like the server"
assert_eq "4" "$(rows)" "no row for aliases"

test_case "subagent_type stands in for agent_type"
P=$(payload task_get "" bro | jq -c '. + {subagent_type: "swe"}')
OUT=$(run "$PROJ" "$P")
assert_eq "deny" "$(decision "$OUT")" "subagent_type swe with agent='bro': denied"
assert_eq "5" "$(rows)" "fifth row written"

test_case "unreadable DB: mismatch denies, match allows"
BROKEN="$TMPDIR/broken"
mkdir -p "$BROKEN/.claude/tmb"
printf 'not a database' > "$BROKEN/.claude/tmb/trajectory.db"
OUT=$(run "$BROKEN" "$(payload audit_append pr-reviewer bro 42)")
assert_eq "deny" "$(decision "$OUT")" "mismatch denied"
assert_contains "$OUT" "pass agent='pr-reviewer'" "the mismatch reason, not the db-unavailable one"
OUT=$(run "$BROKEN" "$(payload audit_append pr-reviewer pr-reviewer 42)")
assert_eq "allow" "$(decision "$OUT")" "match allowed"

test_case "no trajectory DB: mismatch denies, match allows"
mkdir -p "$TMPDIR/bare"
OUT=$(run "$TMPDIR/bare" "$(payload audit_append swe bro)")
assert_eq "deny" "$(decision "$OUT")" "mismatch denied"
OUT=$(run "$TMPDIR/bare" "$(payload audit_append swe swe)")
assert_eq "allow" "$(decision "$OUT")" "match allowed"

test_case "other tools are not judged"
P=$(payload task_get pr-reviewer bro | jq -c '.tool_name = "mcp__github__get_issue"')
OUT=$(run "$PROJ" "$P")
assert_eq "allow" "$(decision "$OUT")" "non-trajectory tool allowed"

# chain <payload> — the payload through the trajectory-gates registration.
chain() {
  (cd "$PROJ" && printf '%s' "$1" \
    | CLAUDE_PROJECT_DIR="$PROJ" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null || true)
}

test_case "the trajectory-gates chain denies a mismatch"
OUT=$(chain "$(payload audit_append pr-reviewer bro 42)")
assert_eq "deny" "$(decision "$OUT")" "denied through dispatch.sh"
assert_eq "6" "$(rows)" "row written through dispatch.sh"

test_case "a pr-reviewer validation_record with agent='bro' through the chain leaves no reviewer_identity_observed row"
observed() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type = 'reviewer_identity_observed';"; }
VR=$(payload validation_record pr-reviewer bro 42 | jq -c '.tool_input.attempt_n = 1 | .tool_use_id = "tu-vr1"')
OUT=$(chain "$VR")
assert_eq "deny" "$(decision "$OUT")" "denied"
assert_contains "$OUT" "pass agent='pr-reviewer'" "agent-arg-matches-caller's reason"
assert_eq "0" "$(observed)" "no observation row"
VR=$(payload validation_record pr-reviewer pr-reviewer 42 | jq -c '.tool_input.attempt_n = 1 | .tool_use_id = "tu-vr2"')
OUT=$(chain "$VR")
assert_eq "allow" "$(decision "$OUT")" "the matching call is allowed"
assert_eq "1" "$(observed)" "and reaches reviewer-identity-observe"

summarize
