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

# tmb_audit_sql <issue_id> <branch_id|''> <from_node> <event_type> <summary> <content_json> [<guard_sql>]
# Prints one validated INSERT INTO audit statement for composing with other
# statements in a single tmb_db_write transaction. Every argument is quoted;
# repo is taken from the parent issue; created_at is tmb_now_iso. An empty
# branch_id is stored as NULL. The optional <guard_sql> is a constant SQL
# condition (never user data) the row is conditional on, e.g.
# "(SELECT changes()) > 0" after an UPDATE in the same transaction.
# Exit 2 + stderr on an invalid from_node or a non-integer issue_id.
tmb_audit_sql() {
  local issue_id="${1:-}" branch_id="${2:-}" from_node="${3:-}" event_type="${4:-}" summary="${5:-}" content_json="${6:-}" guard_sql="${7:-}"
  local caller
  caller=$(_tmb_db_write_caller)
  if ! _tmb_from_node_valid "$from_node"; then
    printf 'tmb_audit_append: %s: invalid from_node %s (want hook:<name> or system)\n' "$caller" "'$from_node'" >&2
    return 2
  fi
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

# tmb_audit_append <db> <issue_id> <branch_id|''> <from_node> <event_type> <summary> <content_json>
# The only way a hook inserts an audit row. Hooks pass from_node
# hook:<their-basename-without-.sh>. Returns 2 on invalid input, else
# tmb_db_write's exit code.
tmb_audit_append() {
  local db="${1:-}"
  shift
  local sql
  sql=$(tmb_audit_sql "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}") || return 2
  tmb_db_write "$db" "$sql"
}
