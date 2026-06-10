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

summarize
