#!/usr/bin/env bash
# Library: record and reuse verification runs (verification_runs +
# verification_run_commands, schema v36). Sourced (not exec'd); writes go
# through db-write.sh, one tmb_db_write transaction per call, so a run killed
# mid-way still leaves its row and the command rows written so far. Also
# reads the review findings the gate probes and marks them fixed (v47).
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.
#
# The output tail stored per command is capped at TMB_VERIFICATION_TAIL_CHARS
# (default 4000) characters.

if ! command -v tmb_db_write >/dev/null 2>&1; then
  # shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/db-write.sh"
fi

_tmb_vr_int_or_null() {
  case "${1:-}" in
    '') printf 'NULL' ;;
    -[0-9]*|[0-9]*)
      case "${1#-}" in *[!0-9]*) return 1 ;; esac
      printf '%s' "$1"
      ;;
    *) return 1 ;;
  esac
}

_tmb_vr_fail() {
  printf 'tmb_verification_run: %s: %s\n' "$(_tmb_db_write_caller)" "$1" >&2
  return 2
}

# tmb_verification_run_start <db> <task_id> <commit_sha> <source> <budget_s>
# Inserts a verification_runs row (started_at = now, finished_at/exit_code
# NULL) and prints its id. <source> is gate or manual. In the same transaction
# it first finishes every unfinished row, of any task or source, started more
# than its own budget_s + 60 s ago, as exit_code 137, timed_out 0: a run whose
# writer was killed (SIGKILL cannot be trapped) is never left open, and a run
# still inside its budget is never touched. Exit 2 on invalid input, else
# tmb_db_write's exit code.
tmb_verification_run_start() {
  local db="${1:-}" task_id="${2:-}" sha="${3:-}" source="${4:-}" budget="${5:-}"
  local SAFE_TASK
  SAFE_TASK=$(tmb_sql_int "$task_id")
  [ -n "$SAFE_TASK" ] || { _tmb_vr_fail "invalid task_id '$task_id'"; return 2; }
  [ -n "$sha" ] || { _tmb_vr_fail "empty commit_sha"; return 2; }
  case "$source" in gate|manual) ;; *) _tmb_vr_fail "invalid source '$source' (want gate or manual)"; return 2 ;; esac
  case "$budget" in ''|*[!0-9]*) _tmb_vr_fail "invalid budget_s '$budget'"; return 2 ;; esac
  local SAFE_SHA SAFE_SOURCE SAFE_BUDGET SAFE_NOW
  SAFE_SHA=$(tmb_sql_quote "$sha")
  SAFE_SOURCE="$source"
  SAFE_BUDGET=$(tmb_sql_int "$budget")
  SAFE_NOW=$(tmb_now_iso)
  tmb_db_write "$db" "UPDATE verification_runs SET finished_at = '${SAFE_NOW}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_NOW}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${SAFE_TASK}, '${SAFE_SHA}', '${SAFE_SOURCE}', '${SAFE_NOW}', ${SAFE_BUDGET});
SELECT last_insert_rowid();"
}

# tmb_verification_run_command <db> <run_id> <ordinal> <command> <exit_code|''> <elapsed_s|''> <output>
# Records one command of a run. The last TMB_VERIFICATION_TAIL_CHARS characters
# of <output> are stored as output_tail. Exit 2 on invalid input, else
# tmb_db_write's exit code.
tmb_verification_run_command() {
  local db="${1:-}" run_id="${2:-}" ordinal="${3:-}" command="${4:-}" exit_code="${5:-}" elapsed="${6:-}" output="${7:-}"
  local SAFE_RUN SAFE_ORD SAFE_EXIT SAFE_ELAPSED cap
  SAFE_RUN=$(tmb_sql_int "$run_id")
  [ -n "$SAFE_RUN" ] || { _tmb_vr_fail "invalid run_id '$run_id'"; return 2; }
  SAFE_ORD=$(tmb_sql_int "$ordinal")
  [ -n "$SAFE_ORD" ] || { _tmb_vr_fail "invalid ordinal '$ordinal'"; return 2; }
  SAFE_EXIT=$(_tmb_vr_int_or_null "$exit_code") || { _tmb_vr_fail "invalid exit_code '$exit_code'"; return 2; }
  if [ -z "$elapsed" ]; then
    SAFE_ELAPSED=NULL
  elif [[ "$elapsed" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    SAFE_ELAPSED="$elapsed"
  else
    _tmb_vr_fail "invalid elapsed_s '$elapsed'"
    return 2
  fi
  cap="${TMB_VERIFICATION_TAIL_CHARS:-4000}"
  case "$cap" in ''|*[!0-9]*) cap=4000 ;; esac
  [ "${#output}" -gt "$cap" ] && output="${output: -$cap}"
  local SAFE_CMD SAFE_OUT
  SAFE_CMD=$(tmb_sql_quote "$command")
  SAFE_OUT=$(tmb_sql_quote "$output")
  tmb_db_write "$db" "INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${SAFE_RUN}, ${SAFE_ORD}, '${SAFE_CMD}', ${SAFE_EXIT}, ${SAFE_ELAPSED}, '${SAFE_OUT}');"
}

# tmb_verification_run_finish <db> <run_id> <exit_code> <timed_out 0|1>
# Stamps finished_at = now, exit_code and timed_out on the run row. Exit 2 on
# invalid input, else tmb_db_write's exit code.
tmb_verification_run_finish() {
  local db="${1:-}" run_id="${2:-}" exit_code="${3:-}" timed_out="${4:-0}"
  local SAFE_RUN SAFE_EXIT
  SAFE_RUN=$(tmb_sql_int "$run_id")
  [ -n "$SAFE_RUN" ] || { _tmb_vr_fail "invalid run_id '$run_id'"; return 2; }
  SAFE_EXIT=$(_tmb_vr_int_or_null "$exit_code") || { _tmb_vr_fail "invalid exit_code '$exit_code'"; return 2; }
  [ "$SAFE_EXIT" != NULL ] || { _tmb_vr_fail "finish needs an exit_code"; return 2; }
  case "$timed_out" in 0|1) ;; *) _tmb_vr_fail "invalid timed_out '$timed_out'"; return 2 ;; esac
  local SAFE_TIMED_OUT="$timed_out" SAFE_NOW
  SAFE_NOW=$(tmb_now_iso)
  tmb_db_write "$db" "UPDATE verification_runs SET finished_at = '${SAFE_NOW}', exit_code = ${SAFE_EXIT}, timed_out = ${SAFE_TIMED_OUT} WHERE id = ${SAFE_RUN};"
}

# tmb_review_findings_active <db> <task_id>
# Prints the task's review findings the gate probes (schema v47, GH 1737) as
# one JSON array line of {id, status, probe_cmd}: every status but wontfix, in
# the <n> order of their F<task_id>-<n> ids. Prints [] when the DB has no
# review_findings table, __ERR__ when the read fails.
tmb_review_findings_active() {
  local db="${1:-}" task_id="${2:-}" SAFE_TASK has out
  SAFE_TASK=$(tmb_sql_int "$task_id")
  [ -n "$SAFE_TASK" ] || { printf '[]\n'; return 0; }
  has=$(tmb_gate_read "$db" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_findings';")
  case "$has" in
    __ERR__) printf '__ERR__\n'; return 0 ;;
    1) ;;
    *) printf '[]\n'; return 0 ;;
  esac
  out=$(tmb_gate_read "$db" "SELECT COALESCE(json_group_array(json_object('id', id, 'status', status, 'probe_cmd', probe_cmd)), '[]')
     FROM (SELECT id, status, probe_cmd FROM review_findings
            WHERE task_id = ${SAFE_TASK} AND status <> 'wontfix'
            ORDER BY CAST(substr(id, instr(id, '-') + 1) AS INTEGER));")
  printf '%s\n' "${out:-[]}"
}

# tmb_review_finding_fixed <db> <finding_id>
# Sets status 'fixed' and resolved_at = now on an open review finding; a
# finding in any other status is left as it is. Exit 2 on an invalid id, else
# tmb_db_write's exit code.
tmb_review_finding_fixed() {
  local db="${1:-}" id="${2:-}"
  [[ "$id" =~ ^F[0-9]+-[0-9]+$ ]] || { _tmb_vr_fail "invalid finding id '$id'"; return 2; }
  local SAFE_ID SAFE_NOW
  SAFE_ID=$(tmb_sql_quote "$id")
  SAFE_NOW=$(tmb_now_iso)
  tmb_db_write "$db" "UPDATE review_findings SET status = 'fixed', resolved_at = '${SAFE_NOW}' WHERE id = '${SAFE_ID}' AND status = 'open';"
}

# tmb_verification_run_reusable <db> <task_id> <commit_sha> [<max_age_s>] [<commands_json>]
# Prints `<run_id>|<finished_at>` of the newest passing run (exit_code 0, not
# timed out) for (task_id, commit_sha) that finished within <max_age_s>
# (default 3600, also when empty); prints nothing when there is none or the
# read fails. With <commands_json> (a JSON array of strings) the run's command
# rows must equal it in order, so a run of an amended verification[] is not
# reused (GH 1672).
tmb_verification_run_reusable() {
  local db="${1:-}" task_id="${2:-}" sha="${3:-}" max_age="${4:-3600}" commands_json="${5:-}"
  local SAFE_TASK
  SAFE_TASK=$(tmb_sql_int "$task_id")
  [ -n "$SAFE_TASK" ] && [ -n "$sha" ] || return 0
  case "$max_age" in ''|*[!0-9]*) max_age=3600 ;; esac
  local SAFE_SHA SAFE_MAX_AGE SAFE_CMDS COMMANDS_SQL=""
  SAFE_SHA=$(tmb_sql_quote "$sha")
  SAFE_MAX_AGE="$max_age"
  if [ -n "$commands_json" ]; then
    SAFE_CMDS=$(tmb_sql_quote "$commands_json")
    COMMANDS_SQL="AND json_valid('${SAFE_CMDS}')
       AND (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) = json_array_length('${SAFE_CMDS}')
       AND NOT EXISTS (SELECT 1 FROM json_each('${SAFE_CMDS}') e
             LEFT JOIN verification_run_commands c ON c.run_id = r.id AND c.ordinal = e.key + 1
            WHERE c.command IS NOT e.value)"
  fi
  tmb_sqlite_ro "$db" "SELECT r.id || '|' || r.finished_at FROM verification_runs r
     WHERE r.task_id = ${SAFE_TASK} AND r.commit_sha = '${SAFE_SHA}'
       AND r.exit_code = 0 AND r.timed_out = 0 AND r.finished_at IS NOT NULL
       AND r.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${SAFE_MAX_AGE} seconds')
       ${COMMANDS_SQL}
     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1;"
}
