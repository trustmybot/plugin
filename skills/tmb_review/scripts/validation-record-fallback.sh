#!/usr/bin/env bash
# validation-record-fallback.sh — honor-system validation_record INSERT for MCP-unavailable pr-reviewer
#
# Usage:
#   validation-record-fallback.sh <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id>
#
# verdict: 'pass' or 'fail'
# feedback: plain text — free prose.
#
# This is the honor-system path (MCP unavailable), so the row is written with
# mcp_available = 0 — the typed signal bro reads from the validation row.
#
# The DB is the one the hooks resolve (tmb_db_path in
# scripts/hooks/lib/query-task.sh): TRAJECTORY_DB_PATH, else
# <CLAUDE_PROJECT_DIR>/.claude/<plugin-name>/trajectory.db. Never the cwd's.
# The row is written through tmb_db_write (scripts/hooks/lib/db-write.sh):
# busy timeout, foreign keys on, one BEGIN IMMEDIATE transaction.

set -euo pipefail

# ---------------------------------------------------------------------------
# DB path resolution (scripts/hooks/lib/query-task.sh)
# ---------------------------------------------------------------------------
TMB_LIB="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}/scripts/hooks/lib"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$TMB_LIB/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$TMB_LIB/db-write.sh"

# Prints the resolved DB, else where it was expected (empty when nothing names it).
resolve_db_path() {
  tmb_db_path 2>/dev/null && return 0
  if [[ -n "${TRAJECTORY_DB_PATH:-}" ]]; then
    echo "$TRAJECTORY_DB_PATH"
  elif [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    tmb_db_location "$CLAUDE_PROJECT_DIR"
  fi
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

SAFE_FEEDBACK=$(tmb_sql_quote "$FEEDBACK")
SAFE_SESSION=$(tmb_sql_quote "$SESSION_ID")

# ---------------------------------------------------------------------------
# Resolve DB and insert
# ---------------------------------------------------------------------------
DB_PATH=$(resolve_db_path)

if [[ ! -f "$DB_PATH" ]]; then
  printf '{"error":"db-not-found","path":"%s","hint":"Set CLAUDE_PROJECT_DIR to the project root (or TRAJECTORY_DB_PATH to the DB)."}\n' "${DB_PATH:-unresolved}"
  exit 1
fi

CREATED_AT=$(tmb_now_iso)

if ! tmb_db_write "$DB_PATH" "INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at)
VALUES
  ($TASK_ID, $ATTEMPT_N, 'pr-reviewer', '$VERDICT', '$SAFE_FEEDBACK', 0, '$SAFE_SESSION', '$CREATED_AT');"; then
  printf '{"error":"db-write-failed","path":"%s","hint":"tmb_db_write reported the cause on stderr."}\n' "$DB_PATH"
  exit 1
fi

printf '{"ok":true,"task_id":%s,"attempt_n":%s,"verdict":"%s"}\n' "$TASK_ID" "$ATTEMPT_N" "$VERDICT"
