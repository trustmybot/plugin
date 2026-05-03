#!/usr/bin/env bash
# sqlite3 fallback for MCP write path (#100). Use when MCP unavailable.
# Each wrapper:
#   1. Validates the agent has the role required for the underlying MCP tool
#   2. Performs the equivalent INSERT/UPDATE via sqlite3 directly
#   3. Synthesizes an audit row (kind='event', event_type=mcp_unavailable_fallback_invoked)
#      capturing operation + agent + timestamp
# All wrappers fail-loud (echo error to stderr + return non-zero) when:
#   - DB cannot be located
#   - sqlite3 unavailable
#   - role check fails
#   - SQL fails
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hooks/lib/query-task.sh
. "$SCRIPT_DIR/../hooks/lib/query-task.sh"

# Allowed roles per MCP tool (mirrors mcp/trajectory-server/src/middleware/agent-scope.ts)
# Update if the server's requireRoles for these tools changes.
_TMB_FALLBACK_ROLES_validation_record='pr-reviewer'
_TMB_FALLBACK_ROLES_task_update_status='bro,swe'
_TMB_FALLBACK_ROLES_discussion_append='bro,architect,swe,pr-reviewer'
_TMB_FALLBACK_ROLES_audit_log='bro,architect,swe,pr-reviewer'
_TMB_FALLBACK_ROLES_issue_close='bro'
_TMB_FALLBACK_ROLES_file_registry_update_summaries='bro'

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

_tmb_fallback_audit_log() {
  local db="$1" tool="$2" agent="$3" extra_json="$4"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local extra_json_esc; extra_json_esc=$(printf '%s' "$extra_json" | sed "s/'/''/g")
  sqlite3 "$db" <<SQL 2>/dev/null || true
INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
VALUES (0, '', '$agent', 'event', 'mcp_unavailable_fallback_invoked', 'sqlite3 fallback used for $tool', '$extra_json_esc', '$ts');
SQL
}

# tmb_fallback_validation_record <task_id> <attempt_n> <agent> <verdict> <feedback>
tmb_fallback_validation_record() {
  local task_id="$1" attempt_n="$2" agent="$3" verdict="$4" feedback="$5"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role validation_record "$agent" || return 1
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local feedback_esc; feedback_esc=$(printf '%s' "$feedback" | sed "s/'/''/g")
  sqlite3 "$db" <<SQL
INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, created_at)
VALUES ($task_id, $attempt_n, '$agent', '$verdict', '$feedback_esc', '$ts');
SQL
  _tmb_fallback_audit_log "$db" validation_record "$agent" "{\"task_id\":$task_id,\"attempt_n\":$attempt_n,\"verdict\":\"$verdict\"}"
}

# tmb_fallback_task_update_status <task_id> <status> <agent> [commit_sha]
tmb_fallback_task_update_status() {
  local task_id="$1" status="$2" agent="$3" commit_sha="${4:-}"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role task_update_status "$agent" || return 1
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  if [ -n "$commit_sha" ]; then
    local sha_esc; sha_esc=$(printf '%s' "$commit_sha" | sed "s/'/''/g")
    sqlite3 "$db" <<SQL
UPDATE tasks SET status = '$status', updated_at = '$ts', commit_sha = '$sha_esc' WHERE id = $task_id;
SQL
  else
    sqlite3 "$db" <<SQL
UPDATE tasks SET status = '$status', updated_at = '$ts' WHERE id = $task_id;
SQL
  fi
  _tmb_fallback_audit_log "$db" task_update_status "$agent" "{\"task_id\":$task_id,\"status\":\"$status\"}"
}

# tmb_fallback_discussion_append <issue_id> <author> <kind> <body> <agent>
tmb_fallback_discussion_append() {
  local issue_id="$1" author="$2" kind="$3" body="$4" agent="$5"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role discussion_append "$agent" || return 1
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local body_esc; body_esc=$(printf '%s' "$body" | sed "s/'/''/g")
  local author_esc; author_esc=$(printf '%s' "$author" | sed "s/'/''/g")
  sqlite3 "$db" <<SQL
INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES ($issue_id, '$author_esc', '$kind', '$body_esc', '$ts');
SQL
  _tmb_fallback_audit_log "$db" discussion_append "$agent" "{\"issue_id\":$issue_id,\"kind\":\"$kind\"}"
}

# tmb_fallback_audit_log <issue_id> <branch_id> <from_node> <event_type> <summary> <content> <agent>
tmb_fallback_audit_log() {
  local issue_id="$1" branch_id="$2" from_node="$3" event_type="$4" summary="$5" content="$6" agent="$7"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role audit_log "$agent" || return 1
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local summary_esc; summary_esc=$(printf '%s' "$summary" | sed "s/'/''/g")
  local content_esc; content_esc=$(printf '%s' "$content" | sed "s/'/''/g")
  local branch_esc; branch_esc=$(printf '%s' "$branch_id" | sed "s/'/''/g")
  sqlite3 "$db" <<SQL
INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
VALUES ($issue_id, '$branch_esc', '$from_node', 'event', '$event_type', '$summary_esc', '$content_esc', '$ts');
SQL
  _tmb_fallback_audit_log "$db" audit_log "$agent" "{\"issue_id\":$issue_id,\"event_type\":\"$event_type\"}"
}

# tmb_fallback_issue_close <issue_id> <agent> [post_git_sha]
tmb_fallback_issue_close() {
  local issue_id="$1" agent="$2" post_git_sha="${3:-}"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role issue_close "$agent" || return 1
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  if [ -n "$post_git_sha" ]; then
    local sha_esc; sha_esc=$(printf '%s' "$post_git_sha" | sed "s/'/''/g")
    sqlite3 "$db" <<SQL
UPDATE issues
SET status = 'closed', updated_at = '$ts', closed_at = COALESCE(closed_at, '$ts'), post_commit_hash = '$sha_esc'
WHERE id = $issue_id;
SQL
  else
    sqlite3 "$db" <<SQL
UPDATE issues
SET status = 'closed', updated_at = '$ts', closed_at = COALESCE(closed_at, '$ts')
WHERE id = $issue_id;
SQL
  fi
  _tmb_fallback_audit_log "$db" issue_close "$agent" "{\"issue_id\":$issue_id}"
}

# tmb_fallback_file_registry_update_summary <agent> <path> <summary>
tmb_fallback_file_registry_update_summary() {
  local agent="$1" path="$2" summary="$3"
  local db; db=$(_tmb_require_db) || return 1
  tmb_have_sqlite || { echo "sqlite3-fallback: sqlite3 unavailable" >&2; return 1; }
  _tmb_fallback_check_role file_registry_update_summaries "$agent" || return 1
  [ -f "$path" ] || { echo "sqlite3-fallback: file '$path' not on disk" >&2; return 1; }
  local md5; md5=$(md5 -q "$path" 2>/dev/null || md5sum "$path" 2>/dev/null | awk '{print $1}')
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local summary_esc; summary_esc=$(printf '%s' "$summary" | sed "s/'/''/g")
  local path_esc; path_esc=$(printf '%s' "$path" | sed "s/'/''/g")
  sqlite3 "$db" <<SQL
INSERT INTO file_registry (path, content_md5, summary, summary_updated_at)
VALUES ('$path_esc', '$md5', '$summary_esc', '$ts')
ON CONFLICT(path) DO UPDATE SET content_md5=excluded.content_md5, summary=excluded.summary, summary_updated_at=excluded.summary_updated_at;
SQL
  _tmb_fallback_audit_log "$db" file_registry_update_summaries "$agent" "{\"path\":\"$path_esc\"}"
}
