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
# for a writer lock; worst case = attempts x timeout + backoff (~3.2 s at the
# default, inside a 5 s hook wrapper). Hooks with a larger hooks.json timeout
# export a larger TMB_DB_WRITE_TIMEOUT_MS before writing;
# tests/l1-lint/hook-timeout-budget.sh checks every wrapper covers its budget.

if ! command -v tmb_sql_quote >/dev/null 2>&1; then
  # shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/query-task.sh"
fi

_TMB_DB_WRITE_ATTEMPTS="1 2"
_TMB_DB_WRITE_BACKOFF_S=0.2

_tmb_db_busy_ms() {
  local ms="${TMB_DB_WRITE_TIMEOUT_MS:-1500}"
  case "$ms" in ''|*[!0-9]*) ms=1500 ;; esac
  printf '%s' "$ms"
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
# whole transaction back. Retries on SQLITE_BUSY / "database is locked".
# Returns sqlite3's exit code; on failure prints one stderr line:
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
  local attempt rc err busy_ms
  busy_ms=$(_tmb_db_busy_ms)
  for attempt in $_TMB_DB_WRITE_ATTEMPTS; do
    { err=$(sqlite3 -bail -cmd ".timeout ${busy_ms}" "$db" 2>&1 1>&3 <<<"$wrapped"); rc=$?; } 3>&1
    [ "$rc" -eq 0 ] && return 0
    case "$err" in
      *"database is locked"*|*SQLITE_BUSY*|*"database is busy"*)
        [ "$attempt" != "${_TMB_DB_WRITE_ATTEMPTS##* }" ] && sleep "$_TMB_DB_WRITE_BACKOFF_S"
        continue
        ;;
    esac
    break
  done
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

# tmb_gate_read <db> <sql>
# Read helper for deny-capable gates. Prints the query output, or the literal
# __ERR__ when sqlite3 fails (missing/corrupt/locked DB) so the caller can tell
# "no rows" from "DB unavailable" and fail closed. Always returns 0.
tmb_gate_read() {
  local db="${1:-}" sql="${2:-}" out
  if [ -z "$db" ] || [ ! -f "$db" ]; then
    printf '__ERR__\n'
    return 0
  fi
  if out=$(sqlite3 -readonly -cmd ".timeout $(_tmb_db_busy_ms)" "$db" "$sql" 2>/dev/null); then
    [ -n "$out" ] && printf '%s\n' "$out"
  else
    printf '__ERR__\n'
  fi
  return 0
}
