#!/usr/bin/env bash
# Tests for scripts/hooks/roundtable-auq-shape.sh
# Hook validates AUQ shape when a roundtable is awaiting_human + no human vote.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/roundtable-auq-shape.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_auq_input() {
  local questions_json="$1"
  jq -nc --argjson q "$questions_json" '{tool_name: "AskUserQuestion", tool_input: {questions: $q}}'
}

make_question() {
  local multi="$1"
  shift
  jq -nc --argjson m "$multi" '{multiSelect: $m, options: [{label: "Opt A", description: "desc"}, {label: "Opt B", description: "desc"}]}'
}

setup_db() {
  local db="$1"
  sqlite3 "$db" "
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      pre_commit_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      labels TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS roundtables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      topic TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      closed_at TEXT,
      state TEXT NOT NULL DEFAULT 'collecting'
        CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
      expected_participants INTEGER
    );
    CREATE TABLE IF NOT EXISTS roundtable_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
      participant TEXT NOT NULL,
      vote TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    INSERT INTO issues (objective, created_at, updated_at)
      VALUES ('test issue', datetime('now'), datetime('now'));
  "
}

DB=$(mktemp /tmp/roundtable-auq-shape-test-XXXXXX.db)
trap 'rm -f "$DB"' EXIT
export TRAJECTORY_DB_PATH="$DB"
setup_db "$DB"

# ──────────────────────────────────────────────────────────────
# Case 1: non-AskUserQuestion tool passes through silently
# ──────────────────────────────────────────────────────────────
test_case "non-AskUserQuestion tool exits silently"
input=$(jq -nc '{tool_name: "Bash", tool_input: {command: "echo hi"}}')
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for non-AskUserQuestion"

# ──────────────────────────────────────────────────────────────
# Case 2: AUQ with no open awaiting_human roundtable — pass through
# ──────────────────────────────────────────────────────────────
test_case "pass-through when no open roundtable in awaiting_human"
q1=$(make_question "false")
input=$(make_auq_input "[$q1]")
out=$(run_hook "$input")
assert_eq "" "$out" "no roundtable in db passes silently"

# ──────────────────────────────────────────────────────────────
# Setup: insert a roundtable in state=collecting
# ──────────────────────────────────────────────────────────────
sqlite3 "$DB" "
  INSERT INTO roundtables (issue_id, topic, created_at, state)
    VALUES (1, 'test topic', datetime('now'), 'collecting');
"
test_case "pass-through when state=collecting (votes still coming in)"
q1=$(make_question "false")
input=$(make_auq_input "[$q1]")
out=$(run_hook "$input")
assert_eq "" "$out" "collecting state passes silently"

# ──────────────────────────────────────────────────────────────
# Setup: insert a roundtable in state=awaiting_human
# ──────────────────────────────────────────────────────────────
sqlite3 "$DB" "
  INSERT INTO roundtables (issue_id, topic, created_at, state)
    VALUES (1, 'awaiting topic', datetime('now'), 'awaiting_human');
"
RT_AWAITING=$(sqlite3 "$DB" "SELECT id FROM roundtables WHERE state='awaiting_human' ORDER BY id DESC LIMIT 1")

# ──────────────────────────────────────────────────────────────
# Case 3: awaiting_human but human vote already recorded — pass through
# ──────────────────────────────────────────────────────────────
test_case "pass-through when state=awaiting_human but human vote already recorded"
sqlite3 "$DB" "
  INSERT INTO roundtable_votes (roundtable_id, participant, vote, created_at)
    VALUES ($RT_AWAITING, 'human', 'ratified', datetime('now'));
"
q1=$(make_question "true")
input=$(make_auq_input "[$q1]")
out=$(run_hook "$input")
assert_eq "" "$out" "human vote already recorded passes silently"

# Remove the human vote for subsequent tests, add new awaiting_human roundtable
sqlite3 "$DB" "
  DELETE FROM roundtable_votes WHERE roundtable_id = $RT_AWAITING;
  INSERT INTO roundtables (issue_id, topic, created_at, state)
    VALUES (1, 'awaiting topic 2', datetime('now'), 'awaiting_human');
"
# ──────────────────────────────────────────────────────────────
# Case 4: all-radios (no multiSelect on Q1) — block
# ──────────────────────────────────────────────────────────────
test_case "block when AUQ has all-radios (Q1 not multiSelect)"
q1=$(make_question "false")
q2=$(make_question "false")
input=$(make_auq_input "[$q1, $q2]")
out=$(run_hook "$input")
assert_contains "$out" "permissionDecision" "hook blocks with permissionDecision"
assert_contains "$out" "multiSelect" "feedback mentions multiSelect"

# ──────────────────────────────────────────────────────────────
# Case 5: all-multiSelect (Q2 has multiSelect) — block
# ──────────────────────────────────────────────────────────────
test_case "block when AUQ has Q2 multiSelect (should be radio)"
q1=$(make_question "true")
q2=$(make_question "true")
input=$(make_auq_input "[$q1, $q2]")
out=$(run_hook "$input")
assert_contains "$out" "permissionDecision" "hook blocks with permissionDecision"
assert_contains "$out" "multiSelect" "feedback mentions multiSelect issue"

# ──────────────────────────────────────────────────────────────
# Case 6: 5+ questions — block
# ──────────────────────────────────────────────────────────────
test_case "block when AUQ has 5 questions"
q1=$(make_question "true")
qr=$(make_question "false")
input=$(make_auq_input "[$q1, $qr, $qr, $qr, $qr]")
out=$(run_hook "$input")
assert_contains "$out" "permissionDecision" "hook blocks 5 questions"
assert_contains "$out" "max 4" "feedback mentions max 4"

# ──────────────────────────────────────────────────────────────
# Case 7: Q1 multiSelect + Q2..Qn radios + total ≤ 4 — pass
# ──────────────────────────────────────────────────────────────
test_case "pass when Q1 multiSelect + Q2..Qn radios + total <= 4"
q1=$(make_question "true")
qr=$(make_question "false")
input=$(make_auq_input "[$q1, $qr, $qr]")
out=$(run_hook "$input")
assert_eq "" "$out" "valid shape passes silently"

summarize
