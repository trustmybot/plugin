#!/usr/bin/env bash
# L6 trajectory capture for non-MCP tool calls (issue #108).
#
# Active only when env TMB_DEBUG_TRAJECTORY=1. Writes one row per tool
# call (Bash/Read/Write/Edit/Task/Skill) to the debug_trajectory table.
# MCP tool calls are captured by the server itself in src/index.ts —
# this hook covers everything else.
#
# Never blocks the tool call. On any error, exits 0 silently — capture
# failures must not break the user's session.
set -uo pipefail

[ "${TMB_DEBUG_TRAJECTORY:-0}" = "1" ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true

# Resolve the trajectory DB path the same way the MCP server does.
# Prefer env override, else <cwd>/.claude/<plugin-name>/trajectory.db.
DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0

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

# Compute next step_n in this session — use COALESCE so first call gets 1.
sqlite3 "$DB_PATH" <<SQL 2>/dev/null || true
INSERT INTO debug_trajectory (session_id, step_n, kind, tool_or_mcp_name, args_json, created_at)
VALUES (
  '$SESSION_ID',
  COALESCE((SELECT MAX(step_n) FROM debug_trajectory WHERE session_id='$SESSION_ID'), 0) + 1,
  'tool_use',
  '$TOOL_NAME',
  json('$ARGS_JSON'),
  datetime('now')
);
SQL

exit 0
