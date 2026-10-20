#!/usr/bin/env bash
# Tests for scripts/hooks/lib/db-write.sh — the shared hook write library.
# Covers: transaction rollback, FK enforcement, busy-retry through a held write
# lock, the per-run write budget, from_node validation in tmb_audit_append,
# tmb_gate_read's __ERR__ sentinel, the tmb_now_iso shape, the sqlite3
# fallback's system-issue audit, the verification-gate waiver on a DB error, and
# the verification-run helpers (lib/verification-runs.sh).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/hooks/lib/db-write.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

TMPDIR_FIXTURE=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-db-write-lib.XXXXXX")
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT
DB="$TMPDIR_FIXTURE/trajectory.db"
sqlite3 "$DB" < "$SCHEMA" >/dev/null

# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$LIB"

count() { sqlite3 "$DB" "$1"; }

# wait_for_lock <db> [<ceiling_s>]: 0 once a holder has the lock, 1 at the ceiling. A readonly read fails under BEGIN EXCLUSIVE on a rollback-journal DB; a WAL DB under BEGIN IMMEDIATE still reads, so a zero-timeout BEGIN IMMEDIATE probe covers that holder.
wait_for_lock() {
  local db="$1" ceiling_s="${2:-10}" tries i
  tries=$((ceiling_s * 10))
  for ((i = 0; i < tries; i++)); do
    sqlite3 -readonly "$db" "SELECT 1;" >/dev/null 2>&1 || return 0
    sqlite3 "$db" ".timeout 0" "BEGIN IMMEDIATE; ROLLBACK;" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  return 1
}

test_case "tmb_now_iso prints a 24-char UTC ms-ISO timestamp"
NOW=$(tmb_now_iso)
assert_eq "24" "${#NOW}" "tmb_now_iso length"
case "$NOW" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].000Z) _pass ;;
  *) _fail "tmb_now_iso shape: got <$NOW>" ;;
esac

test_case "tmb_db_write commits a valid transaction"
tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_ok', '1');" 2>/dev/null && RC=0 || RC=$?
assert_eq "0" "$RC" "exit code on success"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_ok';")" "row committed"

test_case "tmb_db_write rolls back when a later statement violates a CHECK"
ERR=$(tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_rollback', '1');
INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
VALUES (1, 1, 'pr-reviewer', 'not-a-verdict', '', 0, '$(tmb_now_iso)');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "CHECK violation should return non-zero"
assert_eq "0" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_rollback';")" "first statement rolled back"
assert_contains "$ERR" "tmb_db_write: " "one stderr line names the library"
assert_eq "1" "$(printf '%s\n' "$ERR" | grep -c .)" "exactly one stderr line"

test_case "tmb_db_write enforces foreign keys (audit row for a missing issue)"
ERR=$(tmb_db_write "$DB" "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
VALUES (424242, 'hook:x', 'fk_probe', 'x', '{}', '$(tmb_now_iso)');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "FK violation should return non-zero"
assert_contains "$ERR" "FOREIGN KEY" "stderr names the FK failure"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type='fk_probe';")" "no orphan audit row"

test_case "tmb_db_write on a missing DB file fails visibly without creating it"
ERR=$(tmb_db_write "$TMPDIR_FIXTURE/missing.db" "INSERT INTO plugin_config (key, value_json) VALUES ('x', '1');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "missing DB should return non-zero"
assert_contains "$ERR" "database not found" "stderr names the missing DB"
[ ! -e "$TMPDIR_FIXTURE/missing.db" ] && _pass || _fail "missing DB must not be created"

test_case "tmb_db_write retries through a held write lock (default 1500 ms x 2 attempts)"
( printf 'BEGIN IMMEDIATE;\nINSERT INTO plugin_config (key, value_json) VALUES (%s, %s);\n' "'dbw_holder'" "'1'"
  sleep 2
  printf 'COMMIT;\n' ) | sqlite3 "$DB" &
HOLDER=$!
sleep 0.2
tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_busy', '1');" 2>/dev/null && RC=0 || RC=$?
wait "$HOLDER"
assert_eq "0" "$RC" "write lands once the lock is released"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_busy';")" "busy-retried row present"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_holder';")" "lock holder's row present"

test_case "tmb_db_write gives up within its bounded budget when the lock outlasts every attempt"
( printf 'BEGIN IMMEDIATE;\n'; sleep 6; printf 'COMMIT;\n' ) | sqlite3 "$DB" &
HOLDER=$!
sleep 0.2
START=$(date +%s)
ERR=$(TMB_DB_WRITE_TIMEOUT_MS=500 tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_gaveup', '1');" 2>&1 >/dev/null) && RC=0 || RC=$?
ELAPSED=$(( $(date +%s) - START ))
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
[ "$RC" -ne 0 ] && _pass || _fail "write under a permanent lock should fail"
[ "$ELAPSED" -le 3 ] && _pass || _fail "TMB_DB_WRITE_TIMEOUT_MS=500 should bound the wait (took ${ELAPSED}s)"
assert_contains "$ERR" "locked" "stderr names the lock"
assert_eq "0" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_gaveup';")" "no row written"

test_case "tmb_audit_append rejects an agent-impersonating from_node"
ERR=$(tmb_audit_append "$DB" -1 '' bro probe_event "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "from_node outside the allowed set exits 2"
assert_contains "$ERR" "invalid from_node" "stderr names the invalid from_node"
ERR=$(tmb_audit_append "$DB" -1 '' "hook:Bad_Name" probe_event "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "malformed hook:<name> exits 2"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type='probe_event';")" "rejected rows not written"

test_case "tmb_audit_append accepts hook:<name> and quotes every value"
tmb_audit_append "$DB" -1 '' "hook:x" containment_denied "it's quoted" '{"note":"it'"'"'s"}' 2>/dev/null && RC=0 || RC=$?
assert_eq "0" "$RC" "hook:x accepted"
ROW=$(count "SELECT from_node || '|' || summary || '|' || json_extract(content_json, '\$.note') || '|' || COALESCE(branch_id, 'NULL') || '|' || length(created_at) FROM audit WHERE event_type='containment_denied';")
assert_eq "hook:x|it's quoted|it's|NULL|24" "$ROW" "row values round-trip"

test_case "tmb_audit_append writes repo from the parent issue"
sqlite3 "$DB" "INSERT INTO repos (name, path) VALUES ('dbw-repo', '/tmp/dbw-repo');
INSERT INTO issues (id, objective, description, status, repo, created_at, updated_at)
VALUES (77, 'o', 'd', 'open', 'dbw-repo', '$(tmb_now_iso)', '$(tmb_now_iso)');" >/dev/null
tmb_audit_append "$DB" 77 'feat/x' "hook:x" readme_staleness_surfaced "s" '{}' 2>/dev/null
assert_eq "dbw-repo|feat/x" "$(count "SELECT repo || '|' || branch_id FROM audit WHERE event_type='readme_staleness_surfaced';")" "repo + branch_id"

test_case "tmb_audit_sql guard: audit row only when the preceding UPDATE changed a row"
SQL_HIT=$(tmb_audit_sql 77 '' "hook:x" issue_auto_closed_on_merge "hit" '{}' "(SELECT changes()) > 0")
SQL_MISS=$(tmb_audit_sql 77 '' "hook:x" issue_auto_closed_on_merge "miss" '{}' "(SELECT changes()) > 0")
tmb_db_write "$DB" "UPDATE issues SET status = 'closed' WHERE id = 77 AND status != 'closed';
$SQL_HIT" 2>/dev/null
tmb_db_write "$DB" "UPDATE issues SET status = 'closed' WHERE id = 77 AND status != 'closed';
$SQL_MISS" 2>/dev/null
assert_eq "hit" "$(count "SELECT group_concat(summary) FROM audit WHERE event_type='issue_auto_closed_on_merge';")" "guarded row written once"

test_case "tmb_audit_append rejects an event_type outside audit-events.txt"
ERR=$(tmb_audit_append "$DB" -1 '' "hook:x" not_an_event "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "unknown event_type rejected"
assert_contains "$ERR" "unknown event_type 'not_an_event'" "stderr names the unknown event"
ERR=$(tmb_audit_sql -1 '' "hook:x" "" "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "empty event_type rejected by tmb_audit_sql"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type IN ('not_an_event', '');")" "rejected rows not written"

test_case "audit-events.txt lists every type in audit-events.ts"
TS_TYPES=$(grep -oE "\{ type: '[a-z_]+'" "$PLUGIN_ROOT/mcp/trajectory-server/src/audit-events.ts" | sed -E "s/.*'([a-z_]+)'/\1/")
assert_eq "$TS_TYPES" "$(cut -f1 "$PLUGIN_ROOT/scripts/hooks/lib/audit-events.txt")" "generated txt equals the TS list"

test_case "tmb_audit_append rejects a hook write of an event hooks may not write"
ERR=$(tmb_audit_append "$DB" -1 '' "hook:x" scope_gate_waived "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "bro-only event rejected for a hook"
assert_contains "$ERR" "audit_event_not_writable_by_role" "stderr names the writer refusal"
assert_contains "$ERR" "writers: bro" "stderr lists the allowed writers"
ERR=$(tmb_audit_append "$DB" -1 '' system verification_gate_waived "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "hook-only event rejected for system"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type IN ('scope_gate_waived') OR (event_type = 'verification_gate_waived' AND from_node = 'system');")" "refused rows not written"

test_case "tmb_audit_append names a missing audit-events.txt"
ERR=$(_TMB_AUDIT_EVENTS_FILE="$TMPDIR_FIXTURE/missing/audit-events.txt" tmb_audit_append "$DB" -1 '' "hook:x" containment_denied "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "missing list fails closed"
assert_contains "$ERR" "audit event list missing or unreadable: $TMPDIR_FIXTURE/missing/audit-events.txt" "stderr names the condition and the path"

test_case "tmb_audit_append dedupe paths: one row per (event_type, task_id, commit_sha)"
DEDUPE_A='{"task_id":9,"commit_sha":"abc1234","waiver_reason":"first"}'
DEDUPE_B='{"task_id":9,"commit_sha":"abc1234","waiver_reason":"second"}'
DEDUPE_C='{"task_id":9,"commit_sha":"def5678","waiver_reason":"new commit"}'
for c in "$DEDUPE_A" "$DEDUPE_B" "$DEDUPE_C"; do
  tmb_audit_append "$DB" -1 '' "hook:x" verification_gate_waived "dedupe" "$c" '$.task_id' '$.commit_sha' 2>/dev/null || _fail "dedupe write returned non-zero"
done
assert_eq "first,new commit" "$(count "SELECT group_concat(json_extract(content_json, '\$.waiver_reason')) FROM (SELECT content_json FROM audit WHERE event_type='verification_gate_waived' ORDER BY id);")" "repeat skipped, new commit written"
ERR=$(tmb_audit_append "$DB" -1 '' "hook:x" verification_gate_waived "x" '{}' "\$.a'); DROP TABLE audit;--" 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "malformed dedupe path rejected"
assert_contains "$ERR" "invalid dedupe json path" "stderr names the bad path"

test_case "tmb_gate_read prints __ERR__ on a missing DB file"
assert_eq "__ERR__" "$(tmb_gate_read "$TMPDIR_FIXTURE/nope.db" "SELECT 1;")" "missing DB"
assert_eq "absent" "$([ -e "$TMPDIR_FIXTURE/nope.db" ] && echo created || echo absent)" "the read never creates the DB"

test_case "tmb_gate_read prints __ERR__ on a sqlite3 error"
assert_eq "__ERR__" "$(tmb_gate_read "$DB" "SELECT * FROM no_such_table;")" "query error"

test_case "tmb_gate_read distinguishes no rows from an error"
assert_eq "" "$(tmb_gate_read "$DB" "SELECT key FROM plugin_config WHERE key='absent';")" "empty result"
assert_eq "1" "$(tmb_gate_read "$DB" "SELECT value_json FROM plugin_config WHERE key='dbw_ok';")" "row result"

# shellcheck source=tests/l3-integration/hooks/fixtures/wal-no-holder.sh disable=SC1091
. "$HERE/fixtures/wal-no-holder.sh"
RO_BIN="$TMPDIR_FIXTURE/ro-bin"
RO_LOG="$TMPDIR_FIXTURE/ro-sqlite3.log"
wal_wrapper "$RO_BIN" "$RO_LOG"

test_case "tmb_gate_read, tmb_sqlite_ro and tmb_db_read_budget read a WAL DB with no holder"
COLD_DB="$TMPDIR_FIXTURE/cold/trajectory.db"
mkdir -p "$(dirname "$COLD_DB")"
sqlite3 "$DB" ".backup '$COLD_DB'"
wal_detach "$COLD_DB"
assert_eq "1" "$(tmb_gate_read "$COLD_DB" "SELECT value_json FROM plugin_config WHERE key='dbw_ok';")" "tmb_gate_read"
wal_detach "$COLD_DB"
assert_eq "1" "$(tmb_sqlite_ro "$COLD_DB" "SELECT value_json FROM plugin_config WHERE key='dbw_ok';")" "tmb_sqlite_ro"
wal_detach "$COLD_DB"
assert_eq "1" "$(printf "SELECT value_json FROM plugin_config WHERE key='dbw_ok';\n" | tmb_db_read_budget "$COLD_DB" 1500)" "tmb_db_read_budget"

test_case "tmb_gate_read retries nothing but an unopenable DB: a SQL error runs sqlite3 once"
: > "$RO_LOG"
assert_eq "__ERR__" "$(PATH="$RO_BIN:$PATH" tmb_gate_read "$DB" "SELECT * FROM no_such_table;")" "query error"
assert_eq "1" "$(grep -c . "$RO_LOG")" "one sqlite3 run"

test_case "tmb_gate_read retries nothing but an unopenable DB: a locked DB runs sqlite3 once"
LOCKED_DB="$TMPDIR_FIXTURE/locked.db"
sqlite3 "$LOCKED_DB" "CREATE TABLE x (a);"
mkfifo "$TMPDIR_FIXTURE/lock.fifo"
sqlite3 "$LOCKED_DB" < "$TMPDIR_FIXTURE/lock.fifo" >/dev/null 2>&1 &
LOCK_PID=$!
exec 8>"$TMPDIR_FIXTURE/lock.fifo"
printf '.timeout 2000\nBEGIN EXCLUSIVE;\nINSERT INTO x VALUES (1);\n' >&8
if wait_for_lock "$LOCKED_DB"; then
  : > "$RO_LOG"
  assert_eq "__ERR__" "$(PATH="$RO_BIN:$PATH" TMB_DB_WRITE_TIMEOUT_MS=100 tmb_gate_read "$LOCKED_DB" "SELECT count(*) FROM x;")" "locked DB"
  assert_eq "1" "$(grep -c . "$RO_LOG")" "one sqlite3 run"
else
  _fail "fixture: lock holder never acquired the lock (locked.db)"
fi
exec 8>&-
wait "$LOCK_PID" 2>/dev/null

test_case "run budget: three writes under a held lock stop waiting once the budget is spent"
( printf '.timeout 2000\nBEGIN IMMEDIATE;\n'; sleep 6; printf 'COMMIT;\n' ) | sqlite3 "$DB" &
HOLDER=$!
if wait_for_lock "$DB"; then
  BUDGET_OUT=$(bash -c '
    . "$1"
    now() { perl -MTime::HiRes=time -e "printf(\"%d\", time() * 1000)"; }
    start=$(now)
    for i in 1 2 3; do
      tmb_db_write "$2" "INSERT INTO plugin_config (key, value_json) VALUES (\"dbw_budget_$i\", \"1\");" 2>>"$3" || printf "fail%s " "$i"
    done
    printf "%s" "$(( $(now) - start ))"
  ' _ "$LIB" "$DB" "$TMPDIR_FIXTURE/budget.err")
  assert_contains "$BUDGET_OUT" "fail1 fail2 fail3 " "all three writes fail under the held lock"
  BUDGET_MS="${BUDGET_OUT##* }"
  HOOK_FLOOR_MS=4500
  [ "$BUDGET_MS" -lt "$HOOK_FLOOR_MS" ] && _pass || _fail "three writes took ${BUDGET_MS} ms, want < ${HOOK_FLOOR_MS} ms (run budget 3500 + 1 s)"
  [ "$BUDGET_MS" -ge 3000 ] && _pass || _fail "the first write should still use most of the budget (took ${BUDGET_MS} ms)"
  assert_contains "$(cat "$TMPDIR_FIXTURE/budget.err")" "run budget spent" "later writes fail fast naming the spent budget"
  assert_eq "0" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key LIKE 'dbw_budget_%';")" "no row written"
else
  _fail "fixture: lock holder never acquired the lock ($DB)"
fi
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true

test_case "sqlite3 fallback audits against the system issue (issue_id = -1)"
ERR=$(TRAJECTORY_DB_PATH="$DB" bash -c '
  . "$1"
  tmb_fallback_audit_append -1 "" "bro" "planning_complete" "system audit" "{}" bro
' _ "$PLUGIN_ROOT/scripts/lib/sqlite3-fallback.sh" 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "0" "$RC" "fallback accepts issue_id -1"
assert_eq "" "$ERR" "no stderr"
assert_eq "1" "$(count "SELECT COUNT(*) FROM audit WHERE issue_id = -1 AND event_type='planning_complete';")" "audit row filed under issue -1"
ERR=$(TRAJECTORY_DB_PATH="$DB" bash -c '
  . "$1"
  tmb_fallback_audit_append -2 "" "bro" "planning_complete" "x" "{}" bro
' _ "$PLUGIN_ROOT/scripts/lib/sqlite3-fallback.sh" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "issue_id -2 must still be rejected"

test_case "swe-verification-gate denies the waiver when the task-row read errors"
printf 'this is not a sqlite database, only text' > "$TMPDIR_FIXTURE/corrupt.db"
WAIVE='{"tool_name":"mcp__plugin_tmb_trajectory-server__task_update_status","tool_input":{"agent":"swe","task_id":"5","status":"completed","waive_verification_gate_reason":"verification impossible offline"}}'
OUT=$(printf '%s' "$WAIVE" | TRAJECTORY_DB_PATH="$TMPDIR_FIXTURE/corrupt.db" bash "$PLUGIN_ROOT/scripts/hooks/swe-verification-gate.sh" 2>/dev/null || true)
assert_contains "$OUT" '"permissionDecision":"deny"' "waiver denied"
assert_contains "$OUT" "trajectory DB unavailable" "unavailable reason"

test_case "verification runs: start prints the id, command and finish rows land, reusable finds the pass"
. "$PLUGIN_ROOT/scripts/hooks/lib/verification-runs.sh"
sqlite3 "$DB" "INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (4242, 'vr', 'open', '$(tmb_now_iso)', '$(tmb_now_iso)');
  INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (4242, 4242, 'feat/vr', 'd', 'running', '$(tmb_now_iso)', '$(tmb_now_iso)');"
SHA=0123456789abcdef0123456789abcdef01234567
RUN=$(tmb_verification_run_start "$DB" 4242 "$SHA" gate 900 2>&1) && RC=0 || RC=$?
assert_eq "0" "$RC" "start succeeds"
case "$RUN" in ''|*[!0-9]*) _fail "start prints a numeric run id, got <$RUN>" ;; *) _pass ;; esac
assert_eq "|" "$(count "SELECT COALESCE(finished_at, '') || '|' || COALESCE(exit_code, '') FROM verification_runs WHERE id = $RUN;")" "finished_at and exit_code NULL while in progress"
assert_eq "" "$(tmb_verification_run_reusable "$DB" 4242 "$SHA")" "an unfinished run is not reusable"
tmb_verification_run_command "$DB" "$RUN" 1 "echo it's ok" 0 1.25 "line one
line two" && _pass || _fail "command row write"
tmb_verification_run_command "$DB" "$RUN" 2 "true" "" "" "" && _pass || _fail "command row with NULL exit/elapsed"
assert_eq "echo it's ok|0|1.25|line one
line two" "$(count "SELECT command || '|' || exit_code || '|' || elapsed_s || '|' || output_tail FROM verification_run_commands WHERE run_id = $RUN AND ordinal = 1;")" "command row round-trips quotes and newlines"
assert_eq "1" "$(count "SELECT exit_code IS NULL AND elapsed_s IS NULL FROM verification_run_commands WHERE run_id = $RUN AND ordinal = 2;")" "empty exit/elapsed stored as NULL"
tmb_verification_run_finish "$DB" "$RUN" 0 0 && _pass || _fail "finish write"
assert_eq "0|0|1" "$(count "SELECT exit_code || '|' || timed_out || '|' || (finished_at IS NOT NULL) FROM verification_runs WHERE id = $RUN;")" "finish stamps the row"
assert_eq "$RUN|" "$(tmb_verification_run_reusable "$DB" 4242 "$SHA" | cut -d'|' -f1)|" "a finished pass is reusable"
assert_eq "" "$(tmb_verification_run_reusable "$DB" 4242 "ffff")" "another sha is not"

test_case "verification runs: the output tail is capped; a timed-out or failed run is not reusable"
RUN2=$(tmb_verification_run_start "$DB" 4242 "$SHA" gate 5)
TMB_VERIFICATION_TAIL_CHARS=10 tmb_verification_run_command "$DB" "$RUN2" 1 "sleep 9" 124 5.0 "0123456789abcdefghij"
assert_eq "abcdefghij" "$(count "SELECT output_tail FROM verification_run_commands WHERE run_id = $RUN2;")" "last 10 characters kept"
tmb_verification_run_finish "$DB" "$RUN2" 124 1
tmb_db_write "$DB" "DELETE FROM verification_runs WHERE id = $RUN;"
assert_eq "" "$(tmb_verification_run_reusable "$DB" 4242 "$SHA")" "a timed-out run is not reusable"
assert_eq "0" "$(count "SELECT COUNT(*) FROM verification_run_commands WHERE run_id = $RUN;")" "deleting a run cascades to its commands"

test_case "verification runs: invalid input is refused with exit 2 and nothing written"
BEFORE=$(count "SELECT COUNT(*) FROM verification_runs;")
for args in "4242|$SHA|bot|900" "x|$SHA|gate|900" "4242||gate|900" "4242|$SHA|gate|abc"; do
  IFS='|' read -r a1 a2 a3 a4 <<< "$args"
  ERR=$(tmb_verification_run_start "$DB" "$a1" "$a2" "$a3" "$a4" 2>&1 >/dev/null) && RC=0 || RC=$?
  assert_eq "2" "$RC" "start refuses <$args>"
  assert_contains "$ERR" "tmb_verification_run" "stderr names the helper"
done
assert_eq "$BEFORE" "$(count "SELECT COUNT(*) FROM verification_runs;")" "no run row written"
tmb_verification_run_command "$DB" "$RUN2" 2 "x" "1; DROP TABLE tasks" "" "" 2>/dev/null && RC=0 || RC=$?
assert_eq "2" "$RC" "a non-integer exit_code is refused"
tmb_verification_run_command "$DB" "$RUN2" 2 "x" 0 "1.5; --" "" 2>/dev/null && RC=0 || RC=$?
assert_eq "2" "$RC" "a non-numeric elapsed_s is refused"
tmb_verification_run_finish "$DB" "$RUN2" 0 2 2>/dev/null && RC=0 || RC=$?
assert_eq "2" "$RC" "timed_out outside 0|1 is refused"
tmb_verification_run_finish "$DB" "$RUN2" "" 0 2>/dev/null && RC=0 || RC=$?
assert_eq "2" "$RC" "finish without an exit_code is refused"
ERR=$(tmb_verification_run_start "$DB" 999 "$SHA" gate 900 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "a run for a missing task fails the FK"
assert_contains "$ERR" "FOREIGN KEY" "stderr names the FK failure"

summarize
