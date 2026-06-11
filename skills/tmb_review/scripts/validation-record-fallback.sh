#!/usr/bin/env bash
# validation-record-fallback.sh — honor-system validation_record INSERT for MCP-unavailable pr-reviewer
#
# Usage:
#   validation-record-fallback.sh <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id>
#
# verdict: 'pass' or 'fail'
# feedback: plain text — the literal prefix 'MCP available: no — honor-system fallback\n' is prepended automatically.
#
# DB path resolution mirrors bro-sqlite-readonly.sh:
#   1. TRAJECTORY_DB_PATH env override wins
#   2. Default: <cwd>/.claude/<plugin-name>/trajectory.db

set -euo pipefail

# ---------------------------------------------------------------------------
# DB path resolution (mirrors bro-sqlite-readonly.sh)
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
# Input validation
# ---------------------------------------------------------------------------
if [[ $# -lt 5 ]]; then
  printf '{"error":"usage","message":"validation-record-fallback.sh <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id>"}\n'
  exit 1
fi

TASK_ID="$1"
ATTEMPT_N="$2"
VERDICT="$3"
FEEDBACK="$4"
SESSION_ID="$5"

# Validate numeric IDs
if ! [[ "$TASK_ID" =~ ^[0-9]+$ ]]; then
  printf '{"error":"invalid_task_id","value":"%s"}\n' "$TASK_ID"
  exit 1
fi

if ! [[ "$ATTEMPT_N" =~ ^[0-9]+$ ]]; then
  printf '{"error":"invalid_attempt_n","value":"%s"}\n' "$ATTEMPT_N"
  exit 1
fi

# Validate verdict
if [[ "$VERDICT" != "pass" && "$VERDICT" != "fail" ]]; then
  printf '{"error":"invalid_verdict","value":"%s","allowed":["pass","fail"]}\n' "$VERDICT"
  exit 1
fi

# ---------------------------------------------------------------------------
# SQL string escaping (single-quote escape)
# ---------------------------------------------------------------------------
sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

SAFE_FEEDBACK=$(sql_escape "MCP available: no — honor-system fallback
$FEEDBACK")
SAFE_SESSION=$(sql_escape "$SESSION_ID")

# ---------------------------------------------------------------------------
# Resolve DB and insert
# ---------------------------------------------------------------------------
DB_PATH=$(resolve_db_path)

if [[ ! -f "$DB_PATH" ]]; then
  printf '{"error":"db-not-found","path":"%s"}\n' "$DB_PATH"
  exit 1
fi

CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

sqlite3 "$DB_PATH" "
INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at)
VALUES
  ($TASK_ID, $ATTEMPT_N, 'pr-reviewer', '$VERDICT', '$SAFE_FEEDBACK', '$SAFE_SESSION', '$CREATED_AT');
"

printf '{"ok":true,"task_id":%s,"attempt_n":%s,"verdict":"%s"}\n' "$TASK_ID" "$ATTEMPT_N" "$VERDICT"
