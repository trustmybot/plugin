#!/usr/bin/env bash
# Hook: Deny-until-briefed gate for SWE subagents.
#
# CC's PreToolUse hook contract does NOT support updatedInput (prompt mutation).
# The deterministic fallback: block SWE from calling any trajectory-server MCP
# tool other than task_brief until task_brief has been called for that task.
# When task_brief fires, write an audit sentinel 'swe_brief_fetched' so
# subsequent MCP calls are allowed.
#
# Fires on: PreToolUse — matcher: mcp__.*trajectory-server__.*
#
# Decision logic:
#   1. Non-SWE caller        → allow (pass-through)
#   2. Tool is task_brief     → write sentinel if not yet set, then allow
#   3. Sentinel exists        → allow (brief already fetched for this task)
#   4. No sentinel + non-task_brief → DENY with instruction to call task_brief
#
# Skips:
#   - Non-SWE callers (bro, pr-reviewer, etc.)
#   - When no DB or no sqlite3 (can't enforce without state)
#   - When task_id cannot be determined from transcript/tool_input
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat)

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")

[ "$AGENT_TYPE" = "swe" ] || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

# Extract task_id from transcript (first human turn contains 'task_id=N') or
# from tool_input fields (task_update_status, task_get, etc. pass task_id directly).
TASK_ID=""

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  TASK_ID=$(jq -r '
    .message.content // [] |
    .[] | select(.type == "text") | .text // ""
  ' "$TRANSCRIPT_PATH" 2>/dev/null \
    | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)
  case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
fi

if [ -z "$TASK_ID" ]; then
  TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // empty' 2>/dev/null || true)
  case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
fi

if [ -z "$TASK_ID" ]; then
  exit 0
fi

IS_TASK_BRIEF=""
case "${TOOL_NAME:-}" in
  *task_brief*) IS_TASK_BRIEF="yes" ;;
esac

if [ "$IS_TASK_BRIEF" = "yes" ]; then
  # Write sentinel on first task_brief call for this task.
  ALREADY=$(tmb_sqlite_ro "$DB" "
    SELECT COUNT(*) FROM audit
     WHERE event_type = 'swe_brief_fetched'
       AND json_extract(content_json, '\$.task_id') = ${TASK_ID}
    LIMIT 1;
  " 2>/dev/null || echo "0")
  if [ "${ALREADY:-0}" -eq 0 ]; then
    CONTENT_JSON="{\"task_id\":${TASK_ID},\"agent_type\":\"swe\"}"
    CONTENT_JSON_SQL=${CONTENT_JSON//\'/\'\'}
    sqlite3 "$DB" "
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      SELECT COALESCE(t.issue_id, -1), t.branch_id, 'swe', 'swe_brief_fetched',
             'SWE fetched task_brief for task_id=${TASK_ID}',
             '${CONTENT_JSON_SQL}', datetime('now')
        FROM tasks t WHERE t.id = ${TASK_ID}
       LIMIT 1;
    " 2>/dev/null || true
  fi
  exit 0
fi

# Not task_brief — check if sentinel exists.
SENTINEL=$(tmb_sqlite_ro "$DB" "
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'swe_brief_fetched'
     AND json_extract(content_json, '\$.task_id') = ${TASK_ID}
  LIMIT 1;
" 2>/dev/null || echo "0")

if [ "${SENTINEL:-0}" -gt 0 ]; then
  exit 0
fi

DENY_REASON="BLOCKED: SWE must call task_brief(agent='swe', task_id=${TASK_ID}) before any other trajectory-server tool call. task_brief delivers the spec, worktree path, and decision thread in one deterministic call."

jq -nc --arg reason "$DENY_REASON" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$reason}}'
exit 0
