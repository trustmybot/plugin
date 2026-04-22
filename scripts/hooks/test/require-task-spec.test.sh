#!/usr/bin/env bash
# Test harness for require-task-spec.sh
set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/require-task-spec.sh"

PASS=0
FAIL=0

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

DB="$TMPDIR/trajectory.db"
export CLAUDE_PLUGIN_DATA="$TMPDIR"

sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    spec_body_md TEXT
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

assert_blocks() {
  local label="$1" input="$2" fragment="$3"
  local out
  out=$(echo "$input" | bash "$HOOK")
  if echo "$out" | grep -q '"decision":"block"' && echo "$out" | grep -q "$fragment"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected block containing: $fragment"
    echo "  got: $out"
    FAIL=$((FAIL + 1))
  fi
}

assert_passes() {
  local label="$1" input="$2"
  local out
  out=$(echo "$input" | bash "$HOOK")
  if [ -z "$out" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected silent exit 0, got: $out"
    FAIL=$((FAIL + 1))
  fi
}

assert_blocks_env() {
  local label="$1" input="$2" fragment="$3" env_var="$4" env_val="$5"
  local out
  out=$(echo "$input" | env "$env_var=$env_val" bash "$HOOK")
  if echo "$out" | grep -q '"decision":"block"' && echo "$out" | grep -q "$fragment"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected block containing: $fragment"
    echo "  got: $out"
    FAIL=$((FAIL + 1))
  fi
}

assert_passes "non-swe agent passes unconditionally" \
  "$(non_swe_input 'no task_id here at all')"

assert_blocks "no task_id token blocks" \
  "$(swe_input 'please do the thing')" \
  "SWE spawn requires task_id"

assert_blocks "nonexistent row blocks" \
  "$(swe_input 'task_id=9999 please do the thing')" \
  "does not exist in the tasks table"

assert_blocks "completed status blocks" \
  "$(swe_input 'task_id=4 please do the thing')" \
  "has status='completed'"

assert_blocks "in_progress status blocks" \
  "$(swe_input 'task_id=5 please do the thing')" \
  "has status='in_progress'"

assert_blocks "pending with empty spec_body_md blocks" \
  "$(swe_input 'task_id=2 please do the thing')" \
  "has empty spec_body_md"

assert_passes "pending with non-empty body passes" \
  "$(swe_input 'task_id=1 please do the thing')"

assert_passes "open with non-empty body passes" \
  "$(swe_input 'task_id=3 please do the thing')"

assert_passes "first task_id wins when prompt has multiple (first is valid)" \
  "$(swe_input 'task_id=1 and also task_id=4')"

assert_blocks_env "missing DB blocks" \
  "$(swe_input 'task_id=1')" \
  "trajectory.db not found" \
  "CLAUDE_PLUGIN_DATA" "$TMPDIR/nonexistent"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
