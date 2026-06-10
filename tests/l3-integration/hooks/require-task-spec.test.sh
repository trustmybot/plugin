#!/usr/bin/env bash
# Tests for scripts/hooks/require-task-spec.sh (DB-backed form)
# Hook contract: block SWE spawns unless the prompt cites a valid
# task_id=<N> whose row in tasks table has status IN (pending, open)
# AND a non-empty spec_body. See plugin CHANGELOG for history.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-task-spec.sh"

# Fixture: isolated TRAJECTORY_DB_PATH + a tasks table with known rows
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    spec_body TEXT
  );
  INSERT INTO tasks VALUES (1, 'pending',     'Do the thing.');
  INSERT INTO tasks VALUES (2, 'pending',     '');
  INSERT INTO tasks VALUES (3, 'open',        'Also valid.');
  INSERT INTO tasks VALUES (4, 'completed',   'Already done.');
  INSERT INTO tasks VALUES (5, 'in_progress', 'Mid-flight.');
"

swe_input() {
  jq -n --arg p "$1" '{tool_input:{subagent_type:"swe",prompt:$p}}'
}

non_swe_input() {
  jq -n --arg p "$1" '{tool_input:{subagent_type:"architect",prompt:$p}}'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

run_hook_env() {
  local input="$1" env_var="$2" env_val="$3"
  echo "$input" | env "$env_var=$env_val" bash "$HOOK" 2>&1 || true
}

test_case "non-SWE agent passes through without any gating"
out=$(run_hook "$(non_swe_input 'no task_id here at all')")
assert_eq "" "$out" "hook output for non-SWE"

test_case "SWE without task_id token in prompt is blocked"
out=$(run_hook "$(swe_input 'please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "SWE spawn requires task_id" "reason cites missing task_id"

test_case "SWE with task_id for nonexistent row is blocked"
out=$(run_hook "$(swe_input 'task_id=9999 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "does not exist in the tasks table" "reason cites missing row"

test_case "SWE with task_id referencing a completed task is blocked"
out=$(run_hook "$(swe_input 'task_id=4 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "status=completed" "reason cites wrong status"

test_case "SWE with task_id referencing an in_progress task is blocked"
out=$(run_hook "$(swe_input 'task_id=5 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "status=in_progress" "reason cites wrong status"

test_case "SWE with pending task that has empty spec_body is blocked"
out=$(run_hook "$(swe_input 'task_id=2 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "has empty spec_body" "reason cites missing body"

test_case "SWE with pending task and non-empty body passes silently"
out=$(run_hook "$(swe_input 'task_id=1 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "SWE with colon-form 'task_id: N' passes silently (separator-agnostic parser)"
out=$(run_hook "$(swe_input 'task_id: 1
please do the thing')")
assert_eq "" "$out" "silent pass for colon form"

test_case "SWE with open task and non-empty body passes silently"
out=$(run_hook "$(swe_input 'task_id=3 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "when prompt has multiple task_id tokens, first wins"
out=$(run_hook "$(swe_input 'task_id=1 and also task_id=4')")
assert_eq "" "$out" "first token is valid -> passes"

test_case "missing trajectory.db is blocked with clear reason"
out=$(run_hook_env "$(swe_input 'task_id=1')" "TRAJECTORY_DB_PATH" "$TMPDIR/nonexistent.db")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "trajectory.db not found" "reason cites missing DB"

summarize
