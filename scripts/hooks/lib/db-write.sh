#!/usr/bin/env bash
# Library: the single write path from hooks/scripts into the trajectory DB.
# Sourced (not exec'd). Depends on query-task.sh for tmb_sql_quote / tmb_sql_int.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.
#
# Every write runs with foreign keys ON, a bounded busy timeout, inside one
# BEGIN IMMEDIATE transaction, and reports failure on stderr with a non-zero
# exit code. Callers decide what a failed write means; this lib never hides it.
#
# Busy budget: each attempt waits up to TMB_DB_WRITE_TIMEOUT_MS (default 1500)
# for a writer lock. All tmb_db_write calls in one hook process also share a
# run budget, TMB_DB_WRITE_RUN_BUDGET_MS (default 3500): the time spent inside
# tmb_db_write is summed across calls, each attempt waits at most what is left,
# and once it is spent further writes fail fast. A hook that writes many rows
# under a held lock therefore spends at most the run budget writing;
# tests/l1-lint/hook-timeout-budget.sh floors every hooks.json wrapper at
# run budget + 1 s.

if ! command -v tmb_sql_quote >/dev/null 2>&1; then
  # shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/query-task.sh"
fi

_TMB_DB_WRITE_ATTEMPTS="1 2"
_TMB_DB_WRITE_BACKOFF_S=0.2
_TMB_DB_WRITE_BACKOFF_MS=200
_TMB_DB_WRITE_SPENT_MS=0

_tmb_db_busy_ms() {
  local ms="${TMB_DB_WRITE_TIMEOUT_MS:-1500}"
  case "$ms" in ''|*[!0-9]*) ms=1500 ;; esac
  printf '%s' "$ms"
}

_tmb_db_run_budget_ms() {
  local ms="${TMB_DB_WRITE_RUN_BUDGET_MS:-3500}"
  case "$ms" in ''|*[!0-9]*) ms=3500 ;; esac
  printf '%s' "$ms"
}

# _tmb_now_ms: wall clock in milliseconds (bash 5 EPOCHREALTIME, else perl,
# else whole seconds).
_tmb_now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local s="${EPOCHREALTIME%[.,]*}" f="${EPOCHREALTIME#*[.,]}"
    printf '%s' "$(( s * 1000 + 10#${f:0:3} ))"
  elif command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf("%d", time() * 1000)'
  else
    printf '%s' "$(( $(date +%s) * 1000 ))"
  fi
}

# tmb_now_iso
# The one hook timestamp format: 24-char UTC ISO-8601 with a millisecond field,
# the shape the server's nowISO writes.
tmb_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%S.000Z
}

_tmb_db_write_caller() {
  local src="${0##*/}"
  printf '%s' "${src%.sh}"
}

# tmb_db_write <db> <sql>
# Runs <sql> as one transaction: PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;
# <sql> COMMIT;  -bail aborts on the first failing statement, which rolls the
# whole transaction back. Retries on SQLITE_BUSY / "database is locked", each
# attempt bounded by what is left of the run budget. Call it in the hook's own
# shell (not inside $(...)) so the time it spends counts against the budget.
# Returns sqlite3's exit code (5 once the run budget is spent); on failure
# prints one stderr line:
#   tmb_db_write: <hook>: <first error line>
tmb_db_write() {
  local db="${1:-}" sql="${2:-}"
  local caller
  caller=$(_tmb_db_write_caller)
  if [ -z "$db" ] || [ ! -f "$db" ]; then
    printf 'tmb_db_write: %s: database not found: %s\n' "$caller" "${db:-<empty>}" >&2
    return 1
  fi
  local wrapped
  wrapped=$(printf 'PRAGMA foreign_keys = ON;\nBEGIN IMMEDIATE;\n%s\nCOMMIT;\n' "$sql")
  local attempt rc=5 err="" busy_ms budget_ms start_ms left wait_ms
  busy_ms=$(_tmb_db_busy_ms)
  budget_ms=$(_tmb_db_run_budget_ms)
  start_ms=$(_tmb_now_ms)
  for attempt in $_TMB_DB_WRITE_ATTEMPTS; do
    left=$(( budget_ms - _TMB_DB_WRITE_SPENT_MS - ($(_tmb_now_ms) - start_ms) ))
    if [ "$left" -le 0 ]; then
      err="run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=${budget_ms})${err:+; last error: $err}"
      rc=5
      break
    fi
    wait_ms="$busy_ms"
    [ "$left" -lt "$wait_ms" ] && wait_ms="$left"
    { err=$(sqlite3 -bail -cmd ".timeout ${wait_ms}" "$db" 2>&1 1>&3 <<<"$wrapped"); rc=$?; } 3>&1
    [ "$rc" -eq 0 ] && break
    case "$err" in
      *"database is locked"*|*SQLITE_BUSY*|*"database is busy"*)
        if [ "$attempt" != "${_TMB_DB_WRITE_ATTEMPTS##* }" ]; then
          left=$(( budget_ms - _TMB_DB_WRITE_SPENT_MS - ($(_tmb_now_ms) - start_ms) ))
          [ "$left" -gt "$_TMB_DB_WRITE_BACKOFF_MS" ] && sleep "$_TMB_DB_WRITE_BACKOFF_S"
        fi
        continue
        ;;
    esac
    break
  done
  _TMB_DB_WRITE_SPENT_MS=$(( _TMB_DB_WRITE_SPENT_MS + $(_tmb_now_ms) - start_ms ))
  [ "$rc" -eq 0 ] && return 0
  [ -n "$err" ] || err="sqlite3 exited ${rc}"
  printf 'tmb_db_write: %s: %s\n' "$caller" "$(printf '%s\n' "$err" | head -1)" >&2
  return "$rc"
}

# _tmb_from_node_valid <from_node>
# A hook writes as itself: hook:<hook-name>, or the system actor. Agent roles
# (bro, swe, pr-reviewer, human) are rejected — a hook never impersonates one.
_tmb_from_node_valid() {
  case "${1:-}" in
    system) return 0 ;;
    hook:) return 1 ;;
    hook:*[!a-z0-9-]*) return 1 ;;
    hook:*) return 0 ;;
  esac
  return 1
}

_TMB_AUDIT_EVENTS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/audit-events.txt"

# _tmb_audit_writer <from_node>
# The audit-events.ts writer a from_node writes as: hook:<name> → hook,
# system → server.
_tmb_audit_writer() {
  case "${1:-}" in
    hook:*) printf 'hook' ;;
    system) printf 'server' ;;
  esac
}

# _tmb_audit_event_writers <event_type>
# Prints the comma-joined writers of <event_type> from audit-events.txt
# (`event<TAB>writers` lines that `npm run build` generates from
# mcp/trajectory-server/src/audit-events.ts); prints nothing and returns 1
# when the event is not listed.
_tmb_audit_event_writers() {
  [ -n "${1:-}" ] || return 1
  local ev writers
  while IFS=$'\t' read -r ev writers || [ -n "$ev" ]; do
    if [ "$ev" = "$1" ]; then
      printf '%s' "$writers"
      return 0
    fi
  done < "$_TMB_AUDIT_EVENTS_FILE"
  return 1
}

# tmb_audit_writer_check <label> <event_type> <writer>
# Exit 2 + stderr (prefixed with <label>) when audit-events.txt is missing or
# unreadable, <event_type> is not in it, or <writer> is not among its writers.
tmb_audit_writer_check() {
  local label="${1:-}" event_type="${2:-}" writer="${3:-}" writers
  if [ ! -r "$_TMB_AUDIT_EVENTS_FILE" ]; then
    printf '%s: audit event list missing or unreadable: %s (run npm run build in mcp/trajectory-server)\n' "$label" "$_TMB_AUDIT_EVENTS_FILE" >&2
    return 2
  fi
  if ! writers=$(_tmb_audit_event_writers "$event_type"); then
    printf '%s: unknown event_type %s (not in %s; add it to mcp/trajectory-server/src/audit-events.ts and rebuild)\n' "$label" "'$event_type'" "$_TMB_AUDIT_EVENTS_FILE" >&2
    return 2
  fi
  case ",$writers," in
    *",$writer,"*) return 0 ;;
  esac
  printf '%s: audit_event_not_writable_by_role: %s may not write %s (writers: %s)\n' "$label" "'$writer'" "'$event_type'" "$writers" >&2
  return 2
}

# tmb_audit_dedupe_guard <event_type> <content_json> <json_path>...
# Prints a guard condition for tmb_audit_sql: true when no audit row of
# <event_type> already carries the same value as <content_json> at every
# <json_path> (e.g. $.task_id $.commit_sha). Inside the tmb_db_write
# transaction the check and the insert are atomic, so a hook that fires more
# than once per event writes one row. Exit 2 + stderr on a malformed path or
# no path.
tmb_audit_dedupe_guard() {
  if [ "$#" -lt 3 ]; then
    printf 'tmb_audit_append: %s: dedupe guard needs at least one json path\n' "$(_tmb_db_write_caller)" >&2
    return 2
  fi
  local event_type="$1" content_json="$2"
  shift 2
  [ -n "$content_json" ] || content_json='{}'
  local safe_content safe_event cond="" path
  safe_content=$(tmb_sql_quote "$content_json")
  safe_event=$(tmb_sql_quote "$event_type")
  for path in "$@"; do
    if ! [[ "$path" =~ ^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$ ]]; then
      printf 'tmb_audit_append: %s: invalid dedupe json path %s\n' "$(_tmb_db_write_caller)" "'$path'" >&2
      return 2
    fi
    cond="${cond} AND json_extract(d.content_json, '${path}') IS json_extract('${safe_content}', '${path}')"
  done
  printf "NOT EXISTS (SELECT 1 FROM audit d WHERE d.event_type = '%s' AND json_valid(d.content_json)%s)" "$safe_event" "$cond"
}

# tmb_audit_sql <issue_id> <branch_id|''> <from_node> <event_type> <summary> <content_json> [<guard_sql>]
# Prints one validated INSERT INTO audit statement for composing with other
# statements in a single tmb_db_write transaction. Every argument is quoted;
# repo is taken from the parent issue; created_at is tmb_now_iso. An empty
# branch_id is stored as NULL. The optional <guard_sql> is a SQL condition the
# row is conditional on: a constant (never user data) such as
# "(SELECT changes()) > 0" after an UPDATE in the same transaction, or the
# output of tmb_audit_dedupe_guard.
# Exit 2 + stderr on an invalid from_node, a missing audit-events.txt, an
# event_type outside it, an event whose writers exclude the from_node's writer
# (hook:<name> writes as hook, system as server), or a non-integer issue_id.
tmb_audit_sql() {
  local issue_id="${1:-}" branch_id="${2:-}" from_node="${3:-}" event_type="${4:-}" summary="${5:-}" content_json="${6:-}" guard_sql="${7:-}"
  local caller
  caller=$(_tmb_db_write_caller)
  if ! _tmb_from_node_valid "$from_node"; then
    printf 'tmb_audit_append: %s: invalid from_node %s (want hook:<name> or system)\n' "$caller" "'$from_node'" >&2
    return 2
  fi
  tmb_audit_writer_check "tmb_audit_append: $caller" "$event_type" "$(_tmb_audit_writer "$from_node")" || return 2
  local safe_issue
  case "$issue_id" in
    -1) safe_issue="-1" ;;
    *) safe_issue=$(tmb_sql_int "$issue_id") ;;
  esac
  if [ -z "$safe_issue" ]; then
    printf 'tmb_audit_append: %s: invalid issue_id %s\n' "$caller" "'$issue_id'" >&2
    return 2
  fi
  local branch_sql="NULL"
  [ -n "$branch_id" ] && branch_sql="'$(tmb_sql_quote "$branch_id")'"
  [ -n "$content_json" ] || content_json='{}'
  local where_sql=""
  [ -n "$guard_sql" ] && where_sql=" WHERE ${guard_sql}"
  printf "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at) SELECT %s, %s, '%s', '%s', '%s', '%s', (SELECT repo FROM issues WHERE id = %s), '%s'%s;\n" \
    "$safe_issue" "$branch_sql" \
    "$(tmb_sql_quote "$from_node")" "$(tmb_sql_quote "$event_type")" \
    "$(tmb_sql_quote "$summary")" "$(tmb_sql_quote "$content_json")" \
    "$safe_issue" "$(tmb_now_iso)" "$where_sql"
}

# tmb_audit_append <db> <issue_id> <branch_id|''> <from_node> <event_type> <summary> <content_json> [<dedupe_json_path>...]
# The only way a hook inserts an audit row. Hooks pass from_node
# hook:<their-basename-without-.sh>. Optional dedupe json paths (e.g.
# '$.task_id' '$.commit_sha') make the write idempotent: no row is written when
# one of <event_type> already matches <content_json> at every path (see
# tmb_audit_dedupe_guard). Returns 2 on invalid input, else tmb_db_write's
# exit code.
tmb_audit_append() {
  local db="${1:-}"
  shift
  local guard="" sql
  if [ "$#" -gt 6 ]; then
    guard=$(tmb_audit_dedupe_guard "${4:-}" "${6:-}" "${@:7}") || return 2
  fi
  sql=$(tmb_audit_sql "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" "$guard") || return 2
  tmb_db_write "$db" "$sql"
}

# The usage rule of a closing agent_runs row, as the server's finalize helper
# (mcp/trajectory-server/src/tools/agent-runs.ts) applies it: a row with no
# token usage and no usage_source becomes 'unmeasured' (the marker the
# swe_runs_metered doctor contract accepts); tokens or a source already written
# are kept. TMB_RUN_UNMEASURED_SQL is a SET-clause item.
TMB_RUN_NO_USAGE_SQL="COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0"
# shellcheck disable=SC2034
TMB_RUN_UNMEASURED_SQL="usage_source = COALESCE(usage_source, CASE WHEN ${TMB_RUN_NO_USAGE_SQL} THEN 'unmeasured' END)"
