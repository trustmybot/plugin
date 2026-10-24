#!/usr/bin/env bash
# Tests for skills/tmb_recovery/scripts/bro-sqlite-readonly.sh against the
# current schema (GH 1678). The DB is built by the trajectory-server's own
# migration path (TrajectoryDB from dist/db.js), never a hand-written schema, so
# a column the fallback queries that the schema drops fails here. Every read
# subcommand must exit 0 with non-empty JSON and leave the DB unchanged; a
# failed query must name the subcommand and the sqlite error on stderr.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/lib/tmpdir-cleanup.sh
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
READONLY="$PLUGIN_ROOT/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh"

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-bro-sqlite-readonly.XXXXXX")
trap 'tmpdir_cleanup "$TMP"' EXIT

DB="$TMP/project/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"

IDS=$(TRAJECTORY_DB_PATH="$DB" DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist" node --experimental-sqlite --no-warnings --input-type=module -e '
const dist = process.env.DIST;
const { TrajectoryDB } = await import(`${dist}/db.js`);
const { resetEmbeddingModelForTests } = await import(`${dist}/embeddings/model.js`);
resetEmbeddingModelForTests(() => new Promise(() => {}));
const db = new TrajectoryDB(process.env.TRAJECTORY_DB_PATH);
const now = new Date().toISOString();
db.run("INSERT INTO issues (objective, description, status, created_at, updated_at, remote_kind, gh_iid, gl_iid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ["fallback objective", "fallback description", "open", now, now, "github", 1678, 77]);
const issueId = db.get("SELECT MAX(id) AS id FROM issues").id;
db.run("INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  [issueId, "fix/fallback", "fallback task", "pending", now, now]);
const taskId = db.get("SELECT MAX(id) AS id FROM tasks").id;
db.run("INSERT INTO issues (objective, status, created_at, updated_at) VALUES (?, ?, ?, ?)", ["no tasks", "open", now, now]);
const idleId = db.get("SELECT MAX(id) AS id FROM issues").id;
db.run("INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES (?, ?)", ["sentinel", JSON.stringify("fallback-value")]);
db.close();
console.log(`${issueId} ${taskId} ${idleId}`);
process.exit(0);
')
read -r ISSUE_ID TASK_ID IDLE_ID <<<"$IDS"

run_ro() {
  local db="$1"; shift
  env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR TRAJECTORY_DB_PATH="$db" bash "$READONLY" "$@"
}

# json_ok <json> — exit 0 when the output parses to a non-empty, non-null value
# with no top-level "error".
json_ok() {
  python3 -c '
import json, sys
v = json.loads(sys.argv[1])
sys.exit(0 if v not in (None, {}, []) and not (isinstance(v, dict) and "error" in v) else 1)
' "$1"
}

db_sum() { cksum < "$1"; }
BEFORE=$(db_sum "$DB")

declare -a CASES=(
  "issue_resume|{\"issue_id\":$ISSUE_ID}"
  "issue_get|{\"issue_id\":$ISSUE_ID}"
  "issue_get|{\"issue_id\":$ISSUE_ID,\"include_description\":true}"
  "issue_get_phase|{\"issue_id\":$ISSUE_ID}"
  "task_get|{\"task_id\":$TASK_ID}"
  "task_first_actionable|{\"issue_id\":$ISSUE_ID}"
  "config_get|{\"key\":\"sentinel\"}"
  "config_list|{}"
)

for c in "${CASES[@]}"; do
  tool="${c%%|*}"; args="${c#*|}"
  test_case "$tool $args on a freshly migrated DB"
  rc=0
  out=$(run_ro "$DB" "$tool" "$args" 2>"$TMP/err") || rc=$?
  assert_exit_code 0 "$rc" "$tool exit (stderr: $(cat "$TMP/err"))"
  if json_ok "$out"; then _pass; else _fail "$tool output is not non-empty JSON: <$out>"; fi
done

test_case "issue reads carry gh_iid and gl_iid"
out=$(run_ro "$DB" issue_get "{\"issue_id\":$ISSUE_ID}")
assert_contains "$out" '"gh_iid": 1678' "issue_get gh_iid"
assert_contains "$out" '"gl_iid": 77' "issue_get gl_iid"
out=$(run_ro "$DB" issue_resume "{\"issue_id\":$ISSUE_ID}")
assert_contains "$out" '"gh_iid": 1678' "issue_resume gh_iid"
assert_contains "$out" '"gl_iid": 77' "issue_resume gl_iid"
assert_contains "$out" '"branch_id": "fix/fallback"' "issue_resume next_task"

test_case "config_get returns the stored value"
out=$(run_ro "$DB" config_get '{"key":"sentinel"}')
assert_eq '"fallback-value"' "$out" "config_get value"

test_case "issue_resume with no actionable task returns next_task null"
out=$(run_ro "$DB" issue_resume "{\"issue_id\":$IDLE_ID}")
assert_contains "$out" '"next_task": null' "issue_resume next_task"

test_case "issue_get on a missing issue reports Not found"
rc=0
out=$(run_ro "$DB" issue_get '{"issue_id":999999}' 2>&1) || rc=$?
assert_exit_code 1 "$rc" "issue_get exit"
assert_contains "$out" "Not found: 999999" "missing issue reported"

test_case "reads never modify the DB"
assert_eq "$BEFORE" "$(db_sum "$DB")" "DB checksum"

# A DB missing a table the subcommand reads: the failed query is reported on
# stderr with the subcommand name, never a silent empty exit.
for broken in "tasks|task_get|{\"task_id\":$TASK_ID}" "plugin_config|config_get|{\"key\":\"sentinel\"}"; do
  table="${broken%%|*}"; rest="${broken#*|}"; tool="${rest%%|*}"; args="${rest#*|}"
  test_case "$tool on a DB missing $table fails loudly"
  BROKEN_DB="$TMP/broken-$table.db"
  sqlite3 "$DB" ".backup '$BROKEN_DB'"
  sqlite3 "$BROKEN_DB" "PRAGMA foreign_keys=OFF; DROP TABLE $table;" >/dev/null
  rc=0
  out=$(run_ro "$BROKEN_DB" "$tool" "$args" 2>"$TMP/err") || rc=$?
  err=$(cat "$TMP/err")
  if [ "$rc" -ne 0 ]; then _pass; else _fail "$tool exited 0 on a DB missing $table"; fi
  assert_contains "$err" "bro-sqlite-readonly: $tool failed:" "stderr names the subcommand"
  assert_contains "$err" "no such table: $table" "stderr carries the sqlite error"
  assert_eq "" "$out" "stdout"
done

summarize
