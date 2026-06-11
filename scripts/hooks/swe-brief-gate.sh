#!/usr/bin/env bash
# Hook: Deny-until-briefed gate for SWE subagents.
#
# CC's PreToolUse hook contract does NOT support updatedInput (prompt mutation).
# The deterministic fallback: block SWE from calling any trajectory-server MCP
# tool other than task_brief — AND from calling Edit/Write/NotebookEdit — until
# task_brief has been called for that task. When task_brief fires, write an
# audit sentinel 'swe_brief_fetched' so subsequent calls are allowed.
#
# Fires on: PreToolUse — matchers:
#   mcp__.*trajectory-server__.*   (original MCP gate)
#   Edit|Write|NotebookEdit        (file-mutation gate, new)
#
# Boundary choice — why Read/Bash are allowed pre-brief:
#   Read-only exploration (Read, Glob, Grep) is legitimate pre-brief work;
#   an SWE may need to orient itself before locating the spec. Bash is
#   similarly allowed because build invocations and greps are pure exploration
#   — they mutate nothing inside the worktree. Only irreversible mutations
#   (Edit, Write, NotebookEdit) are blocked, because implementing blind is
#   exactly the failure mode the gate must prevent.
#
# Decision logic (both matchers share the same sentinel check):
#   1. Non-SWE caller             → allow (pass-through)
#   2. Tool is task_brief          → write sentinel if not yet set, then allow
#   3. Sentinel exists             → allow (brief already fetched for this task)
#   4. No sentinel + blocked tool  → DENY with recovery instruction
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

# Slug fallback: when transcript and tool_input provide no task_id, derive it
# from the worktree root slug (same pattern as swe-boundary.sh).
if [ -z "$TASK_ID" ]; then
  WORKTREE_ROOT=""
  case "$PWD" in
    */.claude/worktrees/*)
      WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
      ;;
  esac
  if [ -n "$WORKTREE_ROOT" ] && [ -n "$DB" ] && tmb_have_sqlite; then
    WORKTREE_SLUG=$(echo "$WORKTREE_ROOT" | sed -E 's|.*/.claude/worktrees/([^/]+)$|\1|')
    if [ -n "$WORKTREE_SLUG" ]; then
      SAFE_SLUG=$(tmb_sql_quote "$WORKTREE_SLUG")
      TASK_ID=$(tmb_sqlite_ro "$DB" "
        SELECT id FROM tasks
         WHERE branch_id LIKE '%/${SAFE_SLUG}'
           AND status IN ('pending','running','completed')
         ORDER BY id DESC
         LIMIT 1;
      " 2>/dev/null || true)
      case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
    fi
  fi
fi

if [ -z "$TASK_ID" ]; then
  exit 0
fi

IS_TASK_BRIEF=""
IS_BLOCKED_MUTATION=""
IS_MCP_TRAJECTORY=""
case "${TOOL_NAME:-}" in
  *task_brief*)                       IS_TASK_BRIEF="yes" ;;
  Edit|Write|NotebookEdit)            IS_BLOCKED_MUTATION="yes" ;;
  mcp__*trajectory-server__*)        IS_MCP_TRAJECTORY="yes" ;;
esac

# Only gate the two matched surfaces: trajectory-server MCP tools and file mutations.
# Read, Bash, Glob, Grep etc. are exploration tools — pass through silently.
if [ -z "$IS_TASK_BRIEF" ] && [ -z "$IS_BLOCKED_MUTATION" ] && [ -z "$IS_MCP_TRAJECTORY" ]; then
  exit 0
fi

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

# Check if sentinel exists before denying.
SENTINEL=$(tmb_sqlite_ro "$DB" "
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'swe_brief_fetched'
     AND json_extract(content_json, '\$.task_id') = ${TASK_ID}
  LIMIT 1;
" 2>/dev/null || echo "0")

if [ "${SENTINEL:-0}" -gt 0 ]; then
  exit 0
fi

DENY_REASON="BLOCKED: SWE must call task_brief(agent='swe', task_id=${TASK_ID}) before ${TOOL_NAME:-this tool}. task_brief delivers the spec, worktree path, and decision thread in one deterministic call. Recovery: task_brief(agent='swe', task_id=${TASK_ID})"

jq -nc --arg reason "$DENY_REASON" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$reason}}'
exit 0
