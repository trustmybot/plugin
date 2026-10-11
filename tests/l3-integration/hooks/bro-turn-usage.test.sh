#!/usr/bin/env bash
# L3 tests: bro-turn-usage.sh Stop hook attributes the session transcript's
# usage to bro agent_runs rows by time window, recomputed absolutely on every
# Stop, only ever touches rows of its own session, audits legacy claims, and
# resolves overlapping windows by running task, then briefed task, then newest.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

HOOK="$PLUGIN_ROOT/scripts/hooks/bro-turn-usage.sh"

TMPDIR_BTU=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BTU"' EXIT
DB="$TMPDIR_BTU/trajectory.db"
TRANSCRIPT="$TMPDIR_BTU/transcript.jsonl"
SESSION="sess-main"

sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null

# at <seconds>: ms-ISO stamp <seconds> after T0 (one hour ago), so closed rows
# fall inside the hook's 24 h recompute horizon.
T0=$(sqlite3 :memory: "SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '-3600 seconds');")
at() {
  sqlite3 :memory: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '$T0', '+$1 seconds');"
}

# msg <n> <seconds> [<content-json>]: one assistant JSONL line whose usage is
# in=n, out=10n, cache_read=100n, cache_creation=1000n.
msg() {
  local n="$1" s="$2" content="${3:-[]}"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"msg_%s","usage":{"input_tokens":%d,"output_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d},"content":%s}}\n' \
    "$(at "$s")" "$n" "$n" "$((n * 10))" "$((n * 100))" "$((n * 1000))" "$content"
}

run_hook() {
  printf '{"session_id":"%s","transcript_path":"%s"}' "${2:-$SESSION}" "$1" \
    | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
}

row() {
  sqlite3 -separator '|' "$DB" "SELECT COALESCE(tokens_in,'null'), COALESCE(tokens_out,'null'), COALESCE(cache_read_tokens,'null'), COALESCE(cache_creation_tokens,'null'), tool_uses, COALESCE(session_id,'null'), COALESCE(usage_source,'null') FROM agent_runs WHERE id=$1;"
}

# Timeline (seconds after T0): first transcript message 0; A opens 10; msgs 1-3
# at 20/30/40; A closes 50; B opens 60; msgs 4-6 at 70/80/90; msgs 7-8 at
# 100/110 arrive before the second Stop.
sqlite3 "$DB" "
  INSERT INTO agent_runs (id, agent_type, started_at, completed_at) VALUES
    (1, 'bro', '$(at 10)', '$(at 50)'),
    (2, 'bro', '$(at 60)', NULL),
    (3, 'bro', '$(at 15)', NULL),
    (4, 'bro', '$(at -600)', NULL);
  UPDATE agent_runs SET session_id = 'sess-other' WHERE id = 3;
"

{
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"@bro go"}}\n' "$(at 0)"
  msg 1 20 '[{"type":"text","text":"a"}]'
  msg 1 20 '[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]'
  msg 2 30
  printf '{"type":"assistant","isSidechain":true,"timestamp":"%s","message":{"id":"msg_side","usage":{"input_tokens":999999,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[]}}\n' "$(at 35)"
  msg 3 40
  msg 4 70 '[{"type":"tool_use","id":"t4","name":"Read","input":{}}]'
  msg 5 80
  msg 6 90
} > "$TRANSCRIPT"

test_case "first Stop: A gets Σ(msgs 1-3), B gets Σ(msgs 4-6)"
run_hook "$TRANSCRIPT"
assert_eq "6|60|600|6000|1|${SESSION}|transcript" "$(row 1)" "row A = msgs 1..3 (split content-block lines counted once, sidechain ignored)"
assert_eq "15|150|1500|15000|1|${SESSION}|transcript" "$(row 2)" "row B = msgs 4..6"

test_case "another session's row is never touched"
assert_eq "null|null|null|null|0|sess-other|null" "$(row 3)" "sess-other row stays unmeasured"

test_case "the claim takes only unclaimed rows started after the session's first message"
assert_eq "null|null|null|null|0|null|null" "$(row 4)" "a row opened before the session began stays unclaimed"

test_case "duration is the window length"
dur_a=$(sqlite3 "$DB" "SELECT duration_ms FROM agent_runs WHERE id=1;")
assert_eq "40000" "$dur_a" "row A window is 40 s"

test_case "second Stop: A unchanged, B grows by msgs 7-8"
{ msg 7 100; msg 8 110; } >> "$TRANSCRIPT"
run_hook "$TRANSCRIPT"
assert_eq "6|60|600|6000|1|${SESSION}|transcript" "$(row 1)" "row A is unchanged"
assert_eq "30|300|3000|30000|1|${SESSION}|transcript" "$(row 2)" "row B = msgs 4..8"
assert_eq "null|null|null|null|0|sess-other|null" "$(row 3)" "sess-other row still untouched"

test_case "re-running the same Stop is idempotent"
run_hook "$TRANSCRIPT"
assert_eq "30|300|3000|30000|1|${SESSION}|transcript" "$(row 2)" "row B unchanged by a re-run"

test_case "a parallel session's Stop meters only its own rows"
OTHER_T="$TMPDIR_BTU/other.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$(at 5)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"o1","usage":{"input_tokens":7,"output_tokens":7,"cache_read_input_tokens":7,"cache_creation_input_tokens":7},"content":[]}}\n' "$(at 20)"
} > "$OTHER_T"
run_hook "$OTHER_T" "sess-other"
assert_eq "7|7|7|7|0|sess-other|transcript" "$(row 3)" "sess-other row metered from its own transcript"
assert_eq "6|60|600|6000|1|${SESSION}|transcript" "$(row 1)" "main-session row A untouched by the other session"
assert_eq "30|300|3000|30000|1|${SESSION}|transcript" "$(row 2)" "main-session row B untouched by the other session"

test_case "missing transcript_path or session_id exits silently"
printf '{"session_id":"%s"}' "$SESSION" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
printf '{"transcript_path":"%s"}' "$TRANSCRIPT" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
assert_eq "30|300|3000|30000|1|${SESSION}|transcript" "$(row 2)" "row B unchanged"

test_case "TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 skips all processing"
sqlite3 "$DB" "UPDATE agent_runs SET tokens_in = 0 WHERE id=2;"
printf '{"session_id":"%s","transcript_path":"%s"}' "$SESSION" "$TRANSCRIPT" \
  | TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 bash "$HOOK" 2>&1 || true
assert_eq "0" "$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE id=2;")" "bypass env must skip the update"

test_case "hostile transcript values cannot reach the SQL"
EVIL_T="$TMPDIR_BTU/evil.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"content":"x"}}\n' "$(at 0)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"e1","usage":{"input_tokens":"1; DROP TABLE agent_runs;--","output_tokens":-5},"content":[]}}\n' "$(at 70)"
  printf '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z'"'"'); DROP TABLE agent_runs;--","message":{"id":"e2","usage":{"input_tokens":3},"content":[]}}\n'
} > "$EVIL_T"
EVIL_OUT=$(run_hook "$EVIL_T")
assert_eq "" "$EVIL_OUT" "no SQL error on hostile input"
assert_eq "1" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs';")" "agent_runs table survives"
assert_eq "0|0|0|0|0|${SESSION}|transcript" "$(row 2)" "non-numeric / negative usage counts as 0; a malformed timestamp is dropped"

test_case "model is the dominant message.model in the row's window; host is stamped"
MODEL_DB_ROW=$(sqlite3 "$DB" "INSERT INTO agent_runs (agent_type, started_at, session_id) VALUES ('bro', '$(at 200)', '${SESSION}'); SELECT last_insert_rowid();")
MODEL_T="$TMPDIR_BTU/model.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"content":"x"}}\n' "$(at 0)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm1","model":"claude-small-1","usage":{"input_tokens":5,"output_tokens":5},"content":[]}}\n' "$(at 210)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm2","model":"claude-small-1","usage":{"input_tokens":5,"output_tokens":5},"content":[]}}\n' "$(at 211)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm3","model":"claude-big-9","usage":{"input_tokens":500,"output_tokens":5},"content":[]}}\n' "$(at 212)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm4","model":"<synthetic>","usage":{"input_tokens":9000,"output_tokens":0},"content":[]}}\n' "$(at 213)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm5","model":"x'"'"');DROP TABLE agent_runs;--","usage":{"input_tokens":1,"output_tokens":0},"content":[]}}\n' "$(at 214)"
} > "$MODEL_T"
assert_eq "" "$(run_hook "$MODEL_T")" "no SQL error"
assert_eq "claude-big-9|claude" \
  "$(sqlite3 "$DB" "SELECT model, host FROM agent_runs WHERE id=${MODEL_DB_ROW};")" \
  "the model with the most tokens wins; <synthetic> carries no model"
assert_eq "1" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs';")" "a hostile model id cannot reach the SQL"

test_case "the legacy claim leaves one agent_runs_claimed audit row per claim"
assert_eq "1" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='agent_runs_claimed';")" "later Stops claim nothing new"
assert_eq "-1|hook:bro-turn-usage|[1,2]|${SESSION}" \
  "$(sqlite3 -separator '|' "$DB" "SELECT issue_id, from_node, json_extract(content_json,'\$.run_ids'), json_extract(content_json,'\$.session_id') FROM audit WHERE event_type='agent_runs_claimed';")" \
  "run_ids + session_id recorded; rows without an issue file under the system issue"

# A fresh DB per scenario: one issue, tasks 11-13, session-stamped rows.
fresh_db() {
  DB="$TMPDIR_BTU/$1.db"
  sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  sqlite3 "$DB" "
    INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'o', '$(at 0)', '$(at 0)');
    INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES
      (11, 1, 'fix/a', 'd', 'pending', '$(at 0)', '$(at 0)'),
      (12, 1, 'fix/b', 'd', 'pending', '$(at 0)', '$(at 0)'),
      (13, 1, 'fix/c', 'd', 'pending', '$(at 0)', '$(at 0)');
  "
}

# usage_t <file> <session-tag> <seconds>...: a transcript whose first message is
# at 0 and with one in=1 assistant message per <seconds>.
usage_t() {
  local f="$1" tag="$2" s
  shift 2
  printf '{"type":"user","timestamp":"%s","message":{"content":"x"}}\n' "$(at 0)" > "$f"
  for s in "$@"; do
    printf '{"type":"assistant","timestamp":"%s","message":{"id":"%s-%s","usage":{"input_tokens":1,"output_tokens":0},"content":[]}}\n' "$(at "$s")" "$tag" "$s" >> "$f"
  done
}

tokens_by_task() {
  sqlite3 -separator ':' "$DB" "SELECT task_id, COALESCE(tokens_in,'null') FROM agent_runs WHERE agent_type='bro' ORDER BY task_id;" | tr '\n' ' '
}

test_case "rows stamped at open with their session are never cross-claimed"
fresh_db stamped
sqlite3 "$DB" "
  INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, session_id) VALUES
    (21, 11, 1, 'bro', '$(at 10)', 'sess-x1'),
    (22, 12, 1, 'bro', '$(at 10)', 'sess-x2');
"
usage_t "$TMPDIR_BTU/x1.jsonl" x1 20 30
usage_t "$TMPDIR_BTU/x2.jsonl" x2 20 30 40
run_hook "$TMPDIR_BTU/x1.jsonl" sess-x1 >/dev/null
assert_eq "11:2 12:null " "$(tokens_by_task)" "sess-x1 meters only its own row"
run_hook "$TMPDIR_BTU/x2.jsonl" sess-x2 >/dev/null
assert_eq "11:2 12:3 " "$(tokens_by_task)" "sess-x2 meters only its own row"
assert_eq "sess-x1 sess-x2 " "$(sqlite3 "$DB" "SELECT session_id FROM agent_runs ORDER BY id;" | tr '\n' ' ')" "session stamps unchanged"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='agent_runs_claimed';")" "no claim, no claim audit"

test_case "batch siblings: the running task's row takes the tokens from the instant it runs"
fresh_db batch
sqlite3 "$DB" "
  INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, session_id) VALUES
    (31, 11, 1, 'bro', '$(at 10)', 'sess-b'),
    (32, 12, 1, 'bro', '$(at 10)', 'sess-b'),
    (33, 13, 1, 'bro', '$(at 10)', 'sess-b');
  UPDATE tasks SET status = 'running', updated_at = '$(at 25)' WHERE id = 12;
"
usage_t "$TMPDIR_BTU/batch.jsonl" b 20 30 40 50
run_hook "$TMPDIR_BTU/batch.jsonl" sess-b >/dev/null
assert_eq "11:0 12:3 13:1 " "$(tokens_by_task)" "middle (running since 25) takes msgs 30-50; msg 20 predates it and goes to the newest"

test_case "batch siblings: with none running, the most recently briefed task's row takes the tokens"
sqlite3 "$DB" "
  UPDATE tasks SET status = 'pending' WHERE id = 12;
  INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES
    (1, 'hook:swe-brief-gate', 'swe_brief_fetched', 's', '{\"task_id\":11,\"agent_type\":\"swe\"}', '$(at 15)'),
    (1, 'hook:swe-brief-gate', 'swe_brief_fetched', 's', '{\"task_id\":12,\"agent_type\":\"swe\"}', '$(at 35)');
"
run_hook "$TMPDIR_BTU/batch.jsonl" sess-b >/dev/null
assert_eq "11:2 12:2 13:0 " "$(tokens_by_task)" "task 11 (briefed at 15) takes msgs 20-30; task 12 (briefed at 35) takes msgs 40-50"

test_case "batch siblings: a task with an open swe row counts as running"
sqlite3 "$DB" "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES (13, 1, 'swe', '$(at 28)', '$(at 45)');"
run_hook "$TMPDIR_BTU/batch.jsonl" sess-b >/dev/null
assert_eq "11:1 12:1 13:2 " "$(tokens_by_task)" "task 13 takes msgs 30-40 inside its swe window; briefs decide the rest"

test_case "batch siblings: with neither running nor briefed, the newest row takes the tokens"
sqlite3 "$DB" "DELETE FROM audit WHERE event_type = 'swe_brief_fetched'; DELETE FROM agent_runs WHERE agent_type = 'swe';"
run_hook "$TMPDIR_BTU/batch.jsonl" sess-b >/dev/null
assert_eq "11:0 12:0 13:4 " "$(tokens_by_task)" "same started_at: the highest id wins"

summarize
