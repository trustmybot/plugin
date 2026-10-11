#!/usr/bin/env bash
# sqlite3 fallback for MCP write path (#100). Use when MCP unavailable.
# Each wrapper:
#   1. Validates the agent has the role required for the underlying MCP tool
#   2. Performs the equivalent INSERT/UPDATE through tmb_db_write (FK on, busy
#      timeout, one transaction), every value quoted via tmb_sql_quote/tmb_sql_int
#   3. Synthesizes an audit row (event_type=mcp_unavailable_fallback_invoked,
#      issue_id=-1, the system issue) in the same transaction
# All wrappers fail-loud (echo error to stderr + return non-zero) when:
#   - DB cannot be located
#   - sqlite3 unavailable
#   - role check fails
#   - SQL fails
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hooks/lib/query-task.sh
. "$SCRIPT_DIR/../hooks/lib/query-task.sh"
# shellcheck source=../hooks/lib/db-write.sh
. "$SCRIPT_DIR/../hooks/lib/db-write.sh"

# Allowed roles per MCP tool (mirrors mcp/trajectory-server/src/middleware/agent-scope.ts)
# Update if the server's requireRoles for these tools changes.
_TMB_FALLBACK_ROLES_validation_record='pr-reviewer'
_TMB_FALLBACK_ROLES_task_update_status='bro,swe'
_TMB_FALLBACK_ROLES_discussion_append='bro,architect,swe,pr-reviewer'
_TMB_FALLBACK_ROLES_audit_append='bro,architect,swe,pr-reviewer'
_TMB_FALLBACK_ROLES_issue_close='bro'

_tmb_require_db() {
  local db; db=$(tmb_db_path) || true
  if [ -z "$db" ]; then
    echo "sqlite3-fallback: no DB found" >&2; return 1
  fi
  echo "$db"
}

_tmb_fallback_check_role() {
  local tool="$1" agent="$2"
  local var="_TMB_FALLBACK_ROLES_${tool}"
  local allowed="${!var:-}"
  if [ -z "$allowed" ]; then
    echo "sqlite3-fallback: unknown tool '$tool'" >&2; return 1
  fi
  case ",$allowed," in
    *",$agent,"*) return 0;;
    *) echo "sqlite3-fallback: role '$agent' not allowed for '$tool' (allowed: $allowed)" >&2; return 1;;
  esac
}

_tmb_fallback_bad_int() {
  echo "sqlite3-fallback: $1 must be a non-negative integer (got '$2')" >&2
  return 1
}

# _tmb_fallback_audit_sql <issue_id> <branch_id> <from_node> <event_type> <summary> <content_json>
# Prints one INSERT INTO audit with every value quoted.
_tmb_fallback_audit_sql() {
  local SAFE_ISSUE SAFE_BRANCH="NULL"
  case "$1" in
    -1) SAFE_ISSUE="-1" ;;
    *) SAFE_ISSUE=$(tmb_sql_int "$1") ;;
  esac
  [ -n "$SAFE_ISSUE" ] || { _tmb_fallback_bad_int issue_id "$1"; return 1; }
  [ -n "$2" ] && SAFE_BRANCH="'$(tmb_sql_quote "$2")'"
  printf "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (%s, %s, '%s', '%s', '%s', '%s', '%s');\n" \
    "$SAFE_ISSUE" "$SAFE_BRANCH" "$(tmb_sql_quote "$3")" "$(tmb_sql_quote "$4")" \
    "$(tmb_sql_quote "$5")" "$(tmb_sql_quote "$6")" "$(tmb_sql_quote "$(tmb_now_iso)")"
}

# _tmb_fallback_marker_sql <tool> <agent> <extra_json>
# The mcp_unavailable_fallback_invoked row, filed under the system issue (-1).
_tmb_fallback_marker_sql() {
  _tmb_fallback_audit_sql -1 '' "$2" mcp_unavailable_fallback_invoked "sqlite3-fallback used for $1" "$3"
}

# tmb_fallback_validation_record <task_id> <attempt_n> <agent> <verdict> <feedback>
tmb_fallback_validation_record() {
  local task_id="$1" attempt_n="$2" agent="$3" verdict="$4" feedback="$5"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role validation_record "$agent" || return 1
  local SAFE_TID SAFE_N SAFE_AGENT SAFE_VERDICT SAFE_FEEDBACK SAFE_NOW SAFE_MARKER
  SAFE_TID=$(tmb_sql_int "$task_id"); [ -n "$SAFE_TID" ] || { _tmb_fallback_bad_int task_id "$task_id"; return 1; }
  SAFE_N=$(tmb_sql_int "$attempt_n"); [ -n "$SAFE_N" ] || { _tmb_fallback_bad_int attempt_n "$attempt_n"; return 1; }
  SAFE_AGENT=$(tmb_sql_quote "$agent")
  SAFE_VERDICT=$(tmb_sql_quote "$verdict")
  SAFE_FEEDBACK=$(tmb_sql_quote "$feedback")
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  SAFE_MARKER=$(_tmb_fallback_marker_sql validation_record "$agent" \
    "$(jq -nc --argjson t "$SAFE_TID" --argjson n "$SAFE_N" --arg v "$verdict" '{task_id: $t, attempt_n: $n, verdict: $v}')") || return 1
  tmb_db_write "$db" "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
VALUES (${SAFE_TID}, ${SAFE_N}, '${SAFE_AGENT}', '${SAFE_VERDICT}', '${SAFE_FEEDBACK}', 0, '${SAFE_NOW}');
${SAFE_MARKER}"
}

# tmb_fallback_task_update_status <task_id> <status> <agent> [commit_sha]
tmb_fallback_task_update_status() {
  local task_id="$1" status="$2" agent="$3" commit_sha="${4:-}"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role task_update_status "$agent" || return 1
  local SAFE_TID SAFE_STATUS SAFE_NOW SAFE_SHA_SET="" SAFE_MARKER
  SAFE_TID=$(tmb_sql_int "$task_id"); [ -n "$SAFE_TID" ] || { _tmb_fallback_bad_int task_id "$task_id"; return 1; }
  SAFE_STATUS=$(tmb_sql_quote "$status")
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  [ -n "$commit_sha" ] && SAFE_SHA_SET=", commit_sha = '$(tmb_sql_quote "$commit_sha")'"
  SAFE_MARKER=$(_tmb_fallback_marker_sql task_update_status "$agent" \
    "$(jq -nc --argjson t "$SAFE_TID" --arg s "$status" '{task_id: $t, status: $s}')") || return 1
  tmb_db_write "$db" "UPDATE tasks SET status = '${SAFE_STATUS}', updated_at = '${SAFE_NOW}'${SAFE_SHA_SET} WHERE id = ${SAFE_TID};
${SAFE_MARKER}"
}

# tmb_fallback_discussion_append <issue_id> <author> <kind> <body> <agent>
tmb_fallback_discussion_append() {
  local issue_id="$1" author="$2" kind="$3" body="$4" agent="$5"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role discussion_append "$agent" || return 1
  local SAFE_IID SAFE_AUTHOR SAFE_KIND SAFE_BODY SAFE_NOW SAFE_MARKER
  SAFE_IID=$(tmb_sql_int "$issue_id"); [ -n "$SAFE_IID" ] || { _tmb_fallback_bad_int issue_id "$issue_id"; return 1; }
  SAFE_AUTHOR=$(tmb_sql_quote "$author")
  SAFE_KIND=$(tmb_sql_quote "$kind")
  SAFE_BODY=$(tmb_sql_quote "$body")
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  SAFE_MARKER=$(_tmb_fallback_marker_sql discussion_append "$agent" \
    "$(jq -nc --argjson i "$SAFE_IID" --arg k "$kind" '{issue_id: $i, kind: $k}')") || return 1
  tmb_db_write "$db" "INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (${SAFE_IID}, '${SAFE_AUTHOR}', '${SAFE_KIND}', '${SAFE_BODY}', '${SAFE_NOW}');
${SAFE_MARKER}"
}

# tmb_fallback_audit_append <issue_id> <branch_id> <from_node> <event_type> <summary> <content> <agent>
tmb_fallback_audit_append() {
  local issue_id="$1" branch_id="$2" from_node="$3" event_type="$4" summary="$5" content="$6" agent="$7"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role audit_append "$agent" || return 1
  local SAFE_IID SAFE_AUDIT SAFE_MARKER
  case "$issue_id" in
    -1) SAFE_IID="-1" ;;
    *) SAFE_IID=$(tmb_sql_int "$issue_id") ;;
  esac
  [ -n "$SAFE_IID" ] || { _tmb_fallback_bad_int issue_id "$issue_id"; return 1; }
  SAFE_AUDIT=$(_tmb_fallback_audit_sql "$SAFE_IID" "$branch_id" "$from_node" "$event_type" "$summary" "$content") || return 1
  SAFE_MARKER=$(_tmb_fallback_marker_sql audit_append "$agent" \
    "$(jq -nc --argjson i "$SAFE_IID" --arg e "$event_type" '{issue_id: $i, event_type: $e}')") || return 1
  tmb_db_write "$db" "${SAFE_AUDIT}
${SAFE_MARKER}"
}

# tmb_fallback_issue_close <issue_id> <agent>
tmb_fallback_issue_close() {
  local issue_id="$1" agent="$2"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role issue_close "$agent" || return 1
  local SAFE_IID SAFE_NOW SAFE_MARKER
  SAFE_IID=$(tmb_sql_int "$issue_id"); [ -n "$SAFE_IID" ] || { _tmb_fallback_bad_int issue_id "$issue_id"; return 1; }
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  SAFE_MARKER=$(_tmb_fallback_marker_sql issue_close "$agent" "$(jq -nc --argjson i "$SAFE_IID" '{issue_id: $i}')") || return 1
  tmb_db_write "$db" "UPDATE issues
SET status = 'closed', updated_at = '${SAFE_NOW}', closed_at = COALESCE(closed_at, '${SAFE_NOW}')
WHERE id = ${SAFE_IID};
${SAFE_MARKER}"
}
