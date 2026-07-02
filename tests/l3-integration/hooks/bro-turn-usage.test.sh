#!/usr/bin/env bash
# L3 tests: bro-turn-usage.sh Stop hook updates the open bro agent_run row
# with cumulative token usage from the session transcript, including
# cache_read_tokens and cache_creation_tokens (#333).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

HOOK="$PLUGIN_ROOT/scripts/hooks/bro-turn-usage.sh"

TMPDIR_BTU=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BTU"' EXIT
DB="$TMPDIR_BTU/trajectory.db"
TRANSCRIPT="$TMPDIR_BTU/transcript.jsonl"

sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

# Seed an open bro agent_run row (completed_at IS NULL).
sqlite3 "$DB" "
  INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total,
    cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at)
  VALUES (NULL, NULL, 'bro', 0, 0, 0, 0, 0, 0, 0, datetime('now'));
"
RUN_ID=$(sqlite3 "$DB" "SELECT MAX(id) FROM agent_runs;")

# Build a minimal JSONL transcript with 2 messages that have usage + tool_use.
cat > "$TRANSCRIPT" << 'EOF'
{"timestamp":"2026-06-09T10:00:00.000Z","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}
{"timestamp":"2026-06-09T10:00:05.000Z","message":{"usage":{"input_tokens":80,"output_tokens":40,"cache_read_input_tokens":3000,"cache_creation_input_tokens":100},"content":[]}}
EOF

# ---- hook updates open bro run with transcript stats ----
test_case "bro-turn-usage.sh updates open bro agent_run row"
echo "{\"transcript_path\":\"${TRANSCRIPT}\"}" \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true

tokens_in=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "180" "$tokens_in" "tokens_in should be 100+80"

tokens_out=$(sqlite3 "$DB" "SELECT tokens_out FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "90" "$tokens_out" "tokens_out should be 50+40"

cache_read=$(sqlite3 "$DB" "SELECT cache_read_tokens FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "8000" "$cache_read" "cache_read_tokens should be 5000+3000"

cache_creation=$(sqlite3 "$DB" "SELECT cache_creation_tokens FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "300" "$cache_creation" "cache_creation_tokens should be 200+100"

tool_uses=$(sqlite3 "$DB" "SELECT tool_uses FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "1" "$tool_uses" "tool_uses should be 1 (one tool_use block)"

# ---- no transcript path skips silently ----
test_case "missing transcript_path exits silently"
echo '{}' \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
tokens_in_unchanged=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "180" "$tokens_in_unchanged" "run must be unchanged when no transcript"

# ---- no open bro run skips silently ----
test_case "no open bro agent_run exits silently"
sqlite3 "$DB" "UPDATE agent_runs SET completed_at = datetime('now') WHERE id=${RUN_ID};"
echo "{\"transcript_path\":\"${TRANSCRIPT}\"}" \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
tokens_after=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "180" "$tokens_after" "closed run must not be mutated"
sqlite3 "$DB" "UPDATE agent_runs SET completed_at = NULL WHERE id=${RUN_ID};"

# ---- bypass env var ----
test_case "TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 skips all processing"
sqlite3 "$DB" "UPDATE agent_runs SET tokens_in = 0 WHERE id=${RUN_ID};"
echo "{\"transcript_path\":\"${TRANSCRIPT}\"}" \
  | TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 bash "$HOOK" 2>&1 || true
tokens_bypass=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=${RUN_ID};")
assert_eq "0" "$tokens_bypass" "bypass env must skip the update"

# ── injection regression ──────────────────────────────────────────────────────
# bro-turn-usage.sh: only updates agent_runs WHERE id = ${RUN_ID}.
# RUN_ID comes from SELECT id FROM agent_runs — a DB-sourced integer, safe.
# The numeric token/duration fields go through printf '%d' sanitization.
# We test that a corrupted transcript (non-numeric usage fields) doesn't
# cause SQL errors or table corruption.

test_case "corrupt transcript with non-numeric tokens: no SQL error, row unchanged"
sqlite3 "$DB" "UPDATE agent_runs SET completed_at = NULL WHERE id=${RUN_ID};"
sqlite3 "$DB" "UPDATE agent_runs SET tokens_in = 0 WHERE id=${RUN_ID};"
CORRUPT_TRANSCRIPT="$TMPDIR_BTU/corrupt.jsonl"
cat > "$CORRUPT_TRANSCRIPT" <<'EOF'
{"timestamp":"2026-06-09T10:00:00.000Z","message":{"usage":{"input_tokens":"1; DROP TABLE agent_runs;--","output_tokens":0},"content":[]}}
EOF
echo "{\"transcript_path\":\"${CORRUPT_TRANSCRIPT}\"}" \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
TABLE_OK=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs';" 2>/dev/null || echo 0)
assert_eq "1" "$TABLE_OK" "agent_runs table must survive corrupt transcript"
# printf '%d' coerces non-numeric to 0; row must have tokens_in=0 (not the injection string)
tokens_safe=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=${RUN_ID};" 2>/dev/null || echo "-1")
assert_eq "0" "$tokens_safe" "corrupt input must be coerced to 0 by printf '%d'"

# ── multi-task-per-turn scenario ─────────────────────────────────────────────
# Two bro rows open (task A then task B). A growing transcript is replayed
# across two Stop invocations. Assert:
#   - task A gets its window delta (not 0)
#   - task B gets only the tokens after its baseline
#   - no double-counting (A + B == total)

TMPDIR_MT=$(mktemp -d)
# Combined trap: a second `trap ... EXIT` replaces the first, so clean both
# tmpdirs here (otherwise TMPDIR_BTU would leak).
trap 'rm -rf "$TMPDIR_BTU" "$TMPDIR_MT"' EXIT
MT_DB="$TMPDIR_MT/trajectory.db"
MT_T1="$TMPDIR_MT/transcript1.jsonl"
MT_T2="$TMPDIR_MT/transcript2.jsonl"

sqlite3 "$MT_DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

# Insert task A's bro row (open, no baseline yet).
sqlite3 "$MT_DB" "
  INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total,
    cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at)
  VALUES (NULL, NULL, 'bro', 0, 0, 0, 0, 0, 0, 0, datetime('now'));
"
MT_ID_A=$(sqlite3 "$MT_DB" "SELECT MAX(id) FROM agent_runs;")

# Transcript after task A's turn: 200 input, 80 output, 1 tool.
cat > "$MT_T1" << 'EOF'
{"timestamp":"2026-06-09T10:00:00.000Z","message":{"usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}
EOF

test_case "multi-task: task A Stop — baseline=0, delta=cumulative"
echo "{\"transcript_path\":\"${MT_T1}\"}" \
  | TRAJECTORY_DB_PATH="$MT_DB" bash "$HOOK" 2>&1 || true

mt_a_ti=$(sqlite3 "$MT_DB" "SELECT tokens_in FROM agent_runs WHERE id=${MT_ID_A};")
assert_eq "200" "$mt_a_ti" "task A tokens_in should equal full transcript (baseline=0)"
mt_a_baseline=$(sqlite3 "$MT_DB" "SELECT usage_baseline_json FROM agent_runs WHERE id=${MT_ID_A};")
assert_not_contains "$mt_a_baseline" "null" "task A baseline must be written (not null)"

# Now open task B's bro row while A is still open.
sqlite3 "$MT_DB" "
  INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total,
    cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at)
  VALUES (NULL, NULL, 'bro', 0, 0, 0, 0, 0, 0, 0, datetime('now'));
"
MT_ID_B=$(sqlite3 "$MT_DB" "SELECT MAX(id) FROM agent_runs;")

# Transcript after task B's turn: cumulative grows by 150 input, 60 output, 1 tool.
cat > "$MT_T2" << 'EOF'
{"timestamp":"2026-06-09T10:00:00.000Z","message":{"usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}
{"timestamp":"2026-06-09T10:00:05.000Z","message":{"usage":{"input_tokens":150,"output_tokens":60,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"t2","name":"Read","input":{}}]}}
EOF

test_case "multi-task: task B Stop — baseline=task A watermark, delta=incremental"
echo "{\"transcript_path\":\"${MT_T2}\"}" \
  | TRAJECTORY_DB_PATH="$MT_DB" bash "$HOOK" 2>&1 || true

mt_b_ti=$(sqlite3 "$MT_DB" "SELECT tokens_in FROM agent_runs WHERE id=${MT_ID_B};")
assert_eq "150" "$mt_b_ti" "task B tokens_in should be only the delta (350-200=150)"

mt_b_baseline=$(sqlite3 "$MT_DB" "SELECT usage_baseline_json FROM agent_runs WHERE id=${MT_ID_B};")
assert_not_contains "$mt_b_baseline" "null" "task B baseline must be written"

test_case "multi-task: task A row is unchanged after task B Stop"
mt_a_ti_after=$(sqlite3 "$MT_DB" "SELECT tokens_in FROM agent_runs WHERE id=${MT_ID_A};")
assert_eq "200" "$mt_a_ti_after" "task A tokens_in must be unchanged after task B Stop"

test_case "multi-task: no double-counting (A + B == total)"
mt_total=$((mt_a_ti_after + mt_b_ti))
assert_eq "350" "$mt_total" "A+B must equal total transcript tokens_in (no double-count)"

test_case "multi-task: idempotent — re-running task B Stop produces same delta"
echo "{\"transcript_path\":\"${MT_T2}\"}" \
  | TRAJECTORY_DB_PATH="$MT_DB" bash "$HOOK" 2>&1 || true
mt_b_ti_again=$(sqlite3 "$MT_DB" "SELECT tokens_in FROM agent_runs WHERE id=${MT_ID_B};")
assert_eq "150" "$mt_b_ti_again" "task B delta must be the same on re-run (baseline write-once)"

summarize
