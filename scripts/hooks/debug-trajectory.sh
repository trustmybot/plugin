#!/usr/bin/env bash
# L5 trajectory capture for non-MCP tool calls (issue #108).
#
# Active only when env TMB_DEBUG_TRAJECTORY=1 and TMB_EVAL_MODE=1 (the
# debug_trajectory table exists only in eval-mode DBs). Writes one row per tool
# call (Bash/Read/Write/Edit/Task/Skill) to the debug_trajectory table.
# MCP tool calls are captured by the server itself in src/index.ts —
# this hook covers everything else.
#
# Never blocks the tool call. A failed write is reported on stderr and the hook
# still exits 0 — capture failures must not break the user's session.
set -uo pipefail

[ "${TMB_EVAL_MODE:-0}" = "1" ] || exit 0
[ "${TMB_DEBUG_TRAJECTORY:-0}" = "1" ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || exit 0
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh" 2>/dev/null || exit 0
export TMB_DB_WRITE_TIMEOUT_MS=500
export TMB_DB_WRITE_RUN_BUDGET_MS=1200

DB_PATH=$(tmb_db_path_advisory debug-trajectory) || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .tool // empty' 2>/dev/null)
[ -n "$TOOL_NAME" ] || exit 0

# Skip MCP tool calls — the server captures those itself with full result data.
case "$TOOL_NAME" in
  mcp__*) exit 0 ;;
esac

# Truncate args to 4KB. Pass through jq for safe escaping.
ARGS_JSON=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null | head -c 4000)
[ -n "$ARGS_JSON" ] || ARGS_JSON='{}'

# Use a session id that's stable per CC session if CC provides one;
# fall back to the day so all calls in one test run share an id.
SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%Y%m%d-%H)}"

SAFE_SESSION_ID=$(tmb_sql_quote "$SESSION_ID")
SAFE_TOOL_NAME=$(tmb_sql_quote "$TOOL_NAME")
SAFE_ARGS_JSON=$(tmb_sql_quote "$ARGS_JSON")

SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")

# Compute next step_n in this session — use COALESCE so first call gets 1.
tmb_db_write "$DB_PATH" "INSERT INTO debug_trajectory (session_id, step_n, kind, tool_or_mcp_name, args_json, created_at)
VALUES (
  '$SAFE_SESSION_ID',
  COALESCE((SELECT MAX(step_n) FROM debug_trajectory WHERE session_id='$SAFE_SESSION_ID'), 0) + 1,
  'tool_use',
  '$SAFE_TOOL_NAME',
  json('$SAFE_ARGS_JSON'),
  '$SAFE_NOW'
);"

exit 0
