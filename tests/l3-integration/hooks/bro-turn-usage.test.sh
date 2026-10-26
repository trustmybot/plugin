#!/usr/bin/env bash
# L3 tests: bro-turn-usage.sh Stop hook keeps exactly one bro agent_runs row
# per session (task_id NULL) holding the session transcript's main-loop usage,
# rewritten absolutely on every Stop, and never touches another session's row
# or a legacy per-task bro row.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

HOOK="$PLUGIN_ROOT/scripts/hooks/bro-turn-usage.sh"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
PLUGIN_VERSION=$(jq -r .version "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json")

TMPDIR_BTU=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-bro-turn-usage.XXXXXX")
trap 'rm -rf "$TMPDIR_BTU"' EXIT
DB="$TMPDIR_BTU/trajectory.db"
TRANSCRIPT="$TMPDIR_BTU/transcript.jsonl"
SESSION="sess-main"

sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null

T0=$(sqlite3 :memory: "SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '-3600 seconds');")
at() {
  sqlite3 :memory: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '$T0', '+$1 seconds');"
}

# msg <n> <seconds> [<content-json>] [<model>]: one assistant JSONL line whose
# usage is in=n, out=10n, cache_read=100n, cache_creation=1000n.
msg() {
  local n="$1" s="$2" content="${3:-[]}" model="${4:-claude-opus-test}"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"msg_%s","model":"%s","usage":{"input_tokens":%d,"output_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d},"content":%s}}\n' \
    "$(at "$s")" "$n" "$model" "$n" "$((n * 10))" "$((n * 100))" "$((n * 1000))" "$content"
}

# touch_task <id>: a tool_use block calling task_brief on task <id>.
touch_task() {
  printf '[{"type":"tool_use","id":"tu_%s","name":"mcp__plugin_tmb_trajectory-server__task_brief","input":{"agent":"bro","task_id":%s}}]' "$1" "$1"
}

run_hook() {
  printf '{"session_id":"%s","transcript_path":"%s"}' "${2:-$SESSION}" "$1" \
    | TRAJECTORY_DB_PATH="${3:-$DB}" bash "$HOOK" 2>&1 || true
}

session_count() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND session_id='${1:-$SESSION}';"
}

session_row() {
  sqlite3 -separator '|' "$DB" "SELECT COALESCE(task_id,'null'), COALESCE(issue_id,'null'), tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, COALESCE(model,'null'), usage_source, host, exit_reason, COALESCE(root_dir,'null') FROM agent_runs WHERE agent_type='bro' AND session_id='${1:-$SESSION}';"
}

# Two provisioned tasks; the session's turns touch both.
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'o', '$(at 0)', '$(at 0)');
  INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES
    (11, 1, 'fix/a', 'd', 'running', '$(at 0)', '$(at 0)'),
    (12, 1, 'fix/b', 'd', 'running', '$(at 0)', '$(at 0)');
"

{
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"@bro go"}}\n' "$(at 0)"
  msg 1 20 '[{"type":"text","text":"a"}]'
  msg 1 20 "$(touch_task 11)"
  msg 2 30 "$(touch_task 12)"
  printf '{"type":"assistant","isSidechain":true,"timestamp":"%s","message":{"id":"msg_side","model":"claude-side","usage":{"input_tokens":999999,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[]}}\n' "$(at 35)"
  msg 3 40 "$(touch_task 11)"
  msg 4 70 "$(touch_task 12)"
} > "$TRANSCRIPT"

test_case "first Stop: one session row with the main-loop sums"
assert_eq "" "$(run_hook "$TRANSCRIPT")" "no stderr"
assert_eq "1" "$(session_count)" "exactly one bro row for the session"
assert_eq "null|null|10|100|1000|10000|4|claude-opus-test|transcript|claude|completed|null" "$(session_row)" \
  "task_id/issue_id NULL; tokens_out = Σ main-loop out (split content-block lines counted once, sidechain ignored)"
assert_eq "$(at 0)|$(at 70)|70000" \
  "$(sqlite3 -separator '|' "$DB" "SELECT started_at, completed_at, duration_ms FROM agent_runs WHERE agent_type='bro' AND session_id='${SESSION}';")" \
  "started_at / completed_at = first / last main-loop message"

test_case "no per-task bro row, no zero-token closed row"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND task_id IS NOT NULL;")" "no bro row carries a task"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND completed_at IS NOT NULL AND tokens_out=0 AND model IS NULL;")" \
  "no closed bro row with 0 tokens and a NULL model"

test_case "second Stop: still one row, rewritten with the new totals"
{ msg 5 100; msg 6 110 "$(touch_task 11)"; } >> "$TRANSCRIPT"
run_hook "$TRANSCRIPT" >/dev/null
assert_eq "1" "$(session_count)" "count stays at 1"
assert_eq "null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null" "$(session_row)" "absolute sums over msgs 1..6"

test_case "re-running the same Stop is idempotent"
run_hook "$TRANSCRIPT" >/dev/null
assert_eq "1" "$(session_count)" "count stays at 1"
assert_eq "null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null" "$(session_row)" "unchanged by a re-run"

test_case "a parallel session writes its own row and leaves this one alone"
OTHER_T="$TMPDIR_BTU/other.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$(at 5)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"o1","model":"claude-other","usage":{"input_tokens":7,"output_tokens":7,"cache_read_input_tokens":7,"cache_creation_input_tokens":7},"content":[]}}\n' "$(at 20)"
} > "$OTHER_T"
run_hook "$OTHER_T" "sess-other" >/dev/null
assert_eq "null|null|7|7|7|7|0|claude-other|transcript|claude|completed|null" "$(session_row sess-other)" "sess-other metered from its own transcript"
assert_eq "null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null" "$(session_row)" "main session untouched"

test_case "legacy per-task bro rows are never touched"
sqlite3 "$DB" "
  INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, session_id) VALUES
    (901, 11, 1, 'bro', '$(at 10)', '${SESSION}'),
    (902, 12, 1, 'bro', '$(at 10)', NULL);
"
run_hook "$TRANSCRIPT" >/dev/null
assert_eq "901|${SESSION}|null|null|null|0 902|null|null|null|null|0 " \
  "$(sqlite3 -separator '|' "$DB" "SELECT id, COALESCE(session_id,'null'), COALESCE(tokens_in,'null'), COALESCE(usage_source,'null'), COALESCE(completed_at,'null'), tool_uses FROM agent_runs WHERE id IN (901, 902) ORDER BY id;" | tr '\n' ' ')" \
  "legacy rows keep their values; none is claimed"
sqlite3 "$DB" "DELETE FROM agent_runs WHERE id IN (901, 902);"

test_case "missing transcript_path or session_id exits silently"
printf '{"session_id":"%s"}' "$SESSION" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
printf '{"transcript_path":"%s"}' "$TRANSCRIPT" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
assert_eq "1" "$(session_count)" "count unchanged"

test_case "TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 skips all processing"
sqlite3 "$DB" "UPDATE agent_runs SET tokens_in = 0 WHERE agent_type='bro' AND session_id='${SESSION}';"
printf '{"session_id":"%s","transcript_path":"%s"}' "$SESSION" "$TRANSCRIPT" \
  | TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 bash "$HOOK" 2>&1 || true
assert_eq "0" "$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE agent_type='bro' AND session_id='${SESSION}';")" "bypass env must skip the update"

test_case "a session with no metered message writes no row"
EMPTY_T="$TMPDIR_BTU/empty.jsonl"
printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$(at 0)" > "$EMPTY_T"
assert_eq "" "$(run_hook "$EMPTY_T" sess-empty)" "no stderr"
assert_eq "0" "$(session_count sess-empty)" "no row for a session without usage"

test_case "a lone zero-usage <synthetic> message writes no row; a later real turn does"
SYNTH_T="$TMPDIR_BTU/synthetic.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$(at 0)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"syn1","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"API Error"}]}}\n' "$(at 10)"
} > "$SYNTH_T"
assert_eq "" "$(run_hook "$SYNTH_T" sess-synth)" "no stderr"
assert_eq "0" "$(session_count sess-synth)" "no bro row for a synthetic-only session"
msg 8 20 >> "$SYNTH_T"
run_hook "$SYNTH_T" sess-synth >/dev/null
assert_eq "1" "$(session_count sess-synth)" "the next real turn writes the row"
assert_eq "null|null|8|80|800|8000|0|claude-opus-test|transcript|claude|completed|null" "$(session_row sess-synth)" \
  "row holds the real turn's usage and model"
head -n 2 "$SYNTH_T" > "$TMPDIR_BTU/synthetic-only.jsonl"
run_hook "$TMPDIR_BTU/synthetic-only.jsonl" sess-synth >/dev/null
assert_eq "null|null|8|80|800|8000|0|claude-opus-test|transcript|claude|completed|null" "$(session_row sess-synth)" \
  "a synthetic-only Stop leaves the earlier row as it is"

test_case "hostile transcript values cannot reach the SQL"
EVIL_T="$TMPDIR_BTU/evil.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"content":"x"}}\n' "$(at 0)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"e1","model":"x'"'"');DROP TABLE agent_runs;--","usage":{"input_tokens":"1; DROP TABLE agent_runs;--","output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":-5},"content":[]}}\n' "$(at 70)"
  printf '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z'"'"'); DROP TABLE agent_runs;--","message":{"id":"e2","usage":{"input_tokens":3},"content":[]}}\n'
  printf '"a bare string line"\n'
} > "$EVIL_T"
assert_eq "" "$(run_hook "$EVIL_T" sess-evil)" "no SQL error on hostile input"
assert_eq "1" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs';")" "agent_runs table survives"
assert_eq "null|null|0|4|2|0|0|xDROPTABLEagent_runs--|transcript|claude|completed|null" "$(session_row sess-evil)" \
  "non-numeric / negative usage counts as 0; a malformed timestamp is dropped; the model id is stripped"

test_case "model is the one with the most tokens; <synthetic> carries no model"
MODEL_T="$TMPDIR_BTU/model.jsonl"
{
  printf '{"type":"user","timestamp":"%s","message":{"content":"x"}}\n' "$(at 0)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm1","model":"claude-small-1","usage":{"input_tokens":5,"output_tokens":5},"content":[]}}\n' "$(at 210)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm2","model":"claude-small-1","usage":{"input_tokens":5,"output_tokens":5},"content":[]}}\n' "$(at 211)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm3","model":"claude-big-9","usage":{"input_tokens":500,"output_tokens":5},"content":[]}}\n' "$(at 212)"
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"mm4","model":"<synthetic>","usage":{"input_tokens":9000,"output_tokens":0},"content":[]}}\n' "$(at 213)"
} > "$MODEL_T"
run_hook "$MODEL_T" sess-model >/dev/null
assert_eq "claude-big-9" "$(sqlite3 "$DB" "SELECT model FROM agent_runs WHERE session_id='sess-model';")" "the model with the most tokens wins"

test_case "root_dir is the project holding the trajectory DB"
PROJ="$TMPDIR_BTU/proj"
PROJ_DB="$PROJ/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$PROJ_DB")"
sqlite3 "$PROJ_DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
run_hook "$TRANSCRIPT" "$SESSION" "$PROJ_DB" >/dev/null
assert_eq "$PROJ" "$(sqlite3 "$PROJ_DB" "SELECT root_dir FROM agent_runs WHERE agent_type='bro' AND session_id='${SESSION}';")" "root_dir = project root"

test_case "the inserted bro row carries the manifest plugin_version; the next turn's UPDATE leaves it (GH 1884)"
assert_eq "$PLUGIN_VERSION" "$(sqlite3 "$DB" "SELECT plugin_version FROM agent_runs WHERE agent_type='bro' AND session_id='${SESSION}';")" "bro insert"
OTHER_ROOT="$TMPDIR_BTU/other-plugin"
mkdir -p "$OTHER_ROOT/.claude-plugin"
echo '{"name":"tmb","version":"0.0.1-other"}' > "$OTHER_ROOT/.claude-plugin/plugin.json"
msg 9 120 >> "$TRANSCRIPT"
CLAUDE_PLUGIN_ROOT="$OTHER_ROOT" run_hook "$TRANSCRIPT" >/dev/null
assert_eq "1|30|$PLUGIN_VERSION" \
  "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(tokens_in), MAX(plugin_version) FROM agent_runs WHERE agent_type='bro' AND session_id='${SESSION}';")" \
  "the next turn rewrites the totals and keeps plugin_version"

summarize
