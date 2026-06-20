#!/usr/bin/env bash
# bro-sqlite-readonly.sh — direct sqlite3 read fallback for MCP-dead degraded mode
#
# Usage:
#   bro-sqlite-readonly.sh <tool_name> [json_args]
#   bro-sqlite-readonly.sh --dry-run
#   bro-sqlite-readonly.sh --list
#
# Returns JSON matching the MCP tool response shape for the 7 supported read tools.
# Write tools and unknown tools return an error JSON and exit 1.
#
# DB path resolution mirrors mcp/trajectory-server/src/db.ts exactly:
#   1. TRAJECTORY_DB_PATH env override wins
#   2. Default: <cwd>/.claude/<plugin-name>/trajectory.db
#      where plugin-name comes from CLAUDE_PLUGIN_ROOT's plugin.json, fallback "tmb"

set -euo pipefail

# ---------------------------------------------------------------------------
# Supported read tools
# ---------------------------------------------------------------------------
SUPPORTED_READ_TOOLS=(
  issue_resume
  issue_get
  issue_get_phase
  task_get
  task_first_actionable
  config_get
  config_list
)

# Known write tools — refuse these explicitly with a helpful message
KNOWN_WRITE_TOOLS=(
  issue_create
  issue_close
  issue_list
  task_create_batch
  task_update_status
  config_set
  discussion_append
  audit_append
  validation_record
)

# ---------------------------------------------------------------------------
# DB path resolution (mirrors db.ts resolveDbPath / resolvePluginName)
# ---------------------------------------------------------------------------
resolve_plugin_name() {
  local root="${CLAUDE_PLUGIN_ROOT:-}"
  if [[ -z "$root" ]]; then
    echo "tmb"
    return
  fi
  local manifest="$root/.claude-plugin/plugin.json"
  if [[ -f "$manifest" ]]; then
    local name
    name=$(python3 -c "import json,sys; d=json.load(open('$manifest')); print(d.get('name',''))" 2>/dev/null || true)
    if [[ -n "$name" ]]; then
      echo "$name"
      return
    fi
  fi
  echo "tmb"
}

resolve_db_path() {
  local override="${TRAJECTORY_DB_PATH:-}"
  if [[ -n "${override// }" ]]; then
    echo "$override"
    return
  fi
  local plugin_name
  plugin_name=$(resolve_plugin_name)
  echo "$(pwd)/.claude/$plugin_name/trajectory.db"
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_DIR="$HOME/.claude/tmb/logs"
LOG_FILE="$LOG_DIR/mcp-health.log"

append_log() {
  local tool="$1"
  if [[ -d "$LOG_DIR" ]]; then
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '{"ts":"%s","kind":"fallback","tool":"%s","agent":"bro"}\n' "$ts" "$tool" >> "$LOG_FILE" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# JSON output helpers
# ---------------------------------------------------------------------------
error_json() {
  local msg="$1"
  printf '{"error":%s}\n' "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
}

readonly_refusal_json() {
  local tool="$1"
  printf '{"error":"degraded-mode-readonly","requested":"%s","recovery":"MCP is dead. Kill zombie: pkill -f '"'"'trajectory-server/dist/index.js'"'"' then restart Claude Code."}\n' "$tool"
}

# ---------------------------------------------------------------------------
# sqlite3 query helpers
# ---------------------------------------------------------------------------
DB_PATH=""

run_query() {
  sqlite3 -readonly -json "$DB_PATH" "$1" 2>/dev/null
}

run_query_param() {
  # sqlite3 doesn't support parameterized queries from CLI, so we escape manually.
  # Values are always integer IDs or short strings; we single-quote and escape
  # any single quotes inside the value (SQL escaping: '' for ').
  local query="$1"
  sqlite3 -readonly -json "$DB_PATH" "$query" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Parse a JSON arg field (integer or string) — minimal, no jq dependency
# ---------------------------------------------------------------------------
parse_json_field() {
  local json="$1"
  local field="$2"
  # Use python3 which is available on macOS and most Linux installs
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
    v = d.get(sys.argv[2])
    if v is None:
        sys.exit(1)
    print(v)
except Exception as e:
    sys.exit(1)
" "$json" "$field" 2>/dev/null
}

# ---------------------------------------------------------------------------
# SQL-escape a string value for direct interpolation (single-quote escape)
# ---------------------------------------------------------------------------
sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

# ---------------------------------------------------------------------------
# Tool implementations — each prints JSON matching the MCP response shape
# ---------------------------------------------------------------------------

tool_issue_resume() {
  local args="$1"
  local issue_id
  issue_id=$(parse_json_field "$args" "issue_id") || {
    error_json "Missing required arg: issue_id"
    return 1
  }
  local safe_id
  safe_id=$(sql_escape "$issue_id")

  # Fetch issue (redacted for bro: no description field omitted since bro is full-trust)
  local issue_json
  issue_json=$(run_query "SELECT id, objective, description, status, created_at, updated_at, closed_at, remote_iid, remote_kind FROM issues WHERE id = $safe_id;")

  if [[ -z "$issue_json" || "$issue_json" == "[]" ]]; then
    error_json "Not found: $issue_id"
    return 1
  fi

  # Extract issue object from array
  local issue_obj
  issue_obj=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(json.dumps(rows[0]) if rows else 'null')" "$issue_json")

  # Fetch first actionable task
  local task_json
  task_json=$(run_query "SELECT * FROM tasks WHERE issue_id = $safe_id AND status IN ('pending','failed') ORDER BY branch_id ASC LIMIT 1;")

  local task_obj
  task_obj=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(json.dumps(rows[0]) if rows else 'null')" "$task_json")

  python3 -c "
import json, sys
issue = json.loads(sys.argv[1])
task = json.loads(sys.argv[2])
print(json.dumps({'issue': issue, 'next_task': task}))
" "$issue_obj" "$task_obj"
}

tool_issue_get() {
  local args="$1"
  local issue_id
  issue_id=$(parse_json_field "$args" "issue_id") || {
    error_json "Missing required arg: issue_id"
    return 1
  }
  local safe_id
  safe_id=$(sql_escape "$issue_id")

  local include_description
  include_description=$(parse_json_field "$args" "include_description" 2>/dev/null || echo "false")

  local cols
  if [[ "$include_description" == "True" || "$include_description" == "true" || "$include_description" == "1" ]]; then
    cols="*"
  else
    cols="id, objective, description, status, created_at, updated_at, closed_at, remote_iid, remote_kind"
  fi

  local rows
  rows=$(run_query "SELECT $cols FROM issues WHERE id = $safe_id;")

  if [[ -z "$rows" || "$rows" == "[]" ]]; then
    error_json "Not found: $issue_id"
    return 1
  fi

  python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(json.dumps(rows[0]) if rows else 'null')" "$rows"
}

tool_issue_get_phase() {
  local args="$1"
  local issue_id
  issue_id=$(parse_json_field "$args" "issue_id") || {
    error_json "Missing required arg: issue_id"
    return 1
  }
  local safe_id
  safe_id=$(sql_escape "$issue_id")

  local issue_rows
  issue_rows=$(run_query "SELECT id, status FROM issues WHERE id = $safe_id;")

  if [[ -z "$issue_rows" || "$issue_rows" == "[]" ]]; then
    error_json "Not found: $issue_id"
    return 1
  fi

  local counts_rows
  counts_rows=$(run_query "SELECT COUNT(*) as tasks_total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as tasks_completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as tasks_failed FROM tasks WHERE issue_id = $safe_id;")

  python3 -c "
import json, sys
issue_rows = json.loads(sys.argv[1])
counts_rows = json.loads(sys.argv[2])

issue = issue_rows[0] if issue_rows else {}
counts = counts_rows[0] if counts_rows else {}

tasks_total = counts.get('tasks_total') or 0
tasks_completed = counts.get('tasks_completed') or 0
tasks_failed = counts.get('tasks_failed') or 0

status = issue.get('status', '')
if status == 'closed':
    phase = 'done'
elif tasks_total == 0:
    phase = 'discussion'
elif tasks_completed < tasks_total:
    phase = 'tasks'
else:
    phase = 'blueprint'

result = {
    'phase': phase,
    'counts': {
        'tasks_total': tasks_total,
        'tasks_completed': tasks_completed,
        'tasks_failed': tasks_failed,
    }
}
print(json.dumps(result))
" "$issue_rows" "$counts_rows"
}

tool_task_get() {
  local args="$1"
  local task_id
  task_id=$(parse_json_field "$args" "task_id") || {
    error_json "Missing required arg: task_id"
    return 1
  }
  local safe_id
  safe_id=$(sql_escape "$task_id")

  local rows
  rows=$(run_query "SELECT * FROM tasks WHERE id = $safe_id;")

  if [[ -z "$rows" || "$rows" == "[]" ]]; then
    error_json "Not found: $task_id"
    return 1
  fi

  python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(json.dumps(rows[0]) if rows else 'null')" "$rows"
}

tool_task_first_actionable() {
  local args="$1"
  local issue_id
  issue_id=$(parse_json_field "$args" "issue_id") || {
    error_json "Missing required arg: issue_id"
    return 1
  }
  local safe_id
  safe_id=$(sql_escape "$issue_id")

  local rows
  rows=$(run_query "SELECT * FROM tasks WHERE issue_id = $safe_id AND status IN ('pending','failed') ORDER BY branch_id ASC LIMIT 1;")

  if [[ -z "$rows" || "$rows" == "[]" ]]; then
    echo "null"
  else
    python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(json.dumps(rows[0]) if rows else 'null')" "$rows"
  fi
}

tool_config_get() {
  local args="$1"
  local key
  key=$(parse_json_field "$args" "key") || {
    error_json "Missing required arg: key"
    return 1
  }
  local safe_key
  safe_key=$(sql_escape "$key")

  local rows
  rows=$(run_query "SELECT key, value_json, updated_at FROM plugin_config WHERE key = '$safe_key';")

  if [[ -z "$rows" || "$rows" == "[]" ]]; then
    echo "null"
    return
  fi

  # Deserialize the stored JSON value (matching MCP config_get behaviour)
  python3 -c "
import json, sys
rows = json.loads(sys.argv[1])
if not rows:
    print('null')
    sys.exit(0)
row = rows[0]
try:
    parsed = json.loads(row['value_json'])
    print(json.dumps(parsed))
except Exception as e:
    print(json.dumps({'error': 'stored value is not valid JSON', 'raw': row['value_json'][:200]}))
" "$rows"
}

tool_config_list() {
  local rows
  rows=$(run_query "SELECT key, value_json FROM plugin_config ORDER BY key;")

  python3 -c "
import json, sys
rows = json.loads(sys.argv[1])
result = {}
for row in rows:
    try:
        result[row['key']] = json.loads(row['value_json'])
    except Exception:
        result[row['key']] = {'error': 'not valid JSON', 'raw': row['value_json'][:200]}
print(json.dumps(result))
" "$rows"
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
main() {
  # --dry-run: verify DB is readable, print DB path
  if [[ "${1:-}" == "--dry-run" ]]; then
    DB_PATH=$(resolve_db_path)
    if [[ ! -f "$DB_PATH" ]]; then
      printf '{"error":"db-not-found","path":"%s"}\n' "$DB_PATH"
      exit 1
    fi
    local count
    count=$(sqlite3 -readonly "$DB_PATH" "SELECT COUNT(*) FROM issues;" 2>/dev/null || echo "-1")
    printf '{"ok":true,"db_path":"%s","issues_count":%s}\n' "$DB_PATH" "$count"
    exit 0
  fi

  # --list: enumerate supported tools
  if [[ "${1:-}" == "--list" ]]; then
    python3 -c "
import json
print(json.dumps({'supported_read_tools': $(printf '%s\n' "${SUPPORTED_READ_TOOLS[@]}" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().split()))")}))"
    exit 0
  fi

  local tool="${1:-}"
  local args="${2:-}"
  if [[ -z "$args" ]]; then args='{}'; fi

  if [[ -z "$tool" ]]; then
    printf '{"error":"usage","message":"bro-sqlite-readonly.sh <tool_name> [json_args] | --dry-run | --list"}\n'
    exit 1
  fi

  # Check known write tools first — refuse before touching DB
  for wt in "${KNOWN_WRITE_TOOLS[@]}"; do
    if [[ "$tool" == "$wt" ]]; then
      readonly_refusal_json "$tool"
      exit 1
    fi
  done

  # Check if tool is in supported read list
  local supported=false
  for rt in "${SUPPORTED_READ_TOOLS[@]}"; do
    if [[ "$tool" == "$rt" ]]; then
      supported=true
      break
    fi
  done

  if [[ "$supported" == "false" ]]; then
    readonly_refusal_json "$tool"
    exit 1
  fi

  # Resolve DB path
  DB_PATH=$(resolve_db_path)

  if [[ ! -f "$DB_PATH" ]]; then
    printf '{"error":"db-not-found","path":"%s","hint":"Set TRAJECTORY_DB_PATH env var to override."}\n' "$DB_PATH"
    exit 1
  fi

  # Append fallback log entry (best-effort, never fail on logging errors)
  append_log "$tool"

  # Dispatch to tool implementation
  case "$tool" in
    issue_resume)         tool_issue_resume "$args" ;;
    issue_get)            tool_issue_get "$args" ;;
    issue_get_phase)      tool_issue_get_phase "$args" ;;
    task_get)             tool_task_get "$args" ;;
    task_first_actionable) tool_task_first_actionable "$args" ;;
    config_get)           tool_config_get "$args" ;;
    config_list)          tool_config_list "$args" ;;
    *)
      # Should not reach here given the checks above
      readonly_refusal_json "$tool"
      exit 1
      ;;
  esac
}

main "$@"
