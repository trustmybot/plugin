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
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

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
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
TASK_ID=$(tmb_task_id_from_transcript "$TRANSCRIPT_PATH")

if [ -z "$TASK_ID" ]; then
  TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // empty' 2>/dev/null || true)
  case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
fi

# Worktree fallback: when transcript and tool_input provide no task_id, the
# worktree's checked-out branch matches branch_id exactly; a detached worktree
# falls back to its slug (tmb_task_by_slug).
if [ -z "$TASK_ID" ]; then
  WORKTREE_ROOT=$(tmb_worktree_root_for_target "")
  if [ -n "$WORKTREE_ROOT" ]; then
    WORKTREE_BRANCH=$(git -C "$WORKTREE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ -n "$WORKTREE_BRANCH" ] && [ "$WORKTREE_BRANCH" != "HEAD" ]; then
      SAFE_BRANCH=$(tmb_sql_quote "$WORKTREE_BRANCH")
      TASK_ID=$(tmb_sqlite_ro "$DB" "
        SELECT id FROM tasks
         WHERE branch_id = '${SAFE_BRANCH}'
           AND status IN ('pending','running','completed')
         ORDER BY id DESC
         LIMIT 1;
      ")
    fi
    if [ -z "$TASK_ID" ]; then
      TASK_ID=$(tmb_task_by_slug "$DB" "$(basename "$WORKTREE_ROOT")" id "'pending','running','completed'")
    fi
    TASK_ID=$(tmb_sql_int "$TASK_ID")
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
    TASK_ROW=$(tmb_sqlite_ro "$DB" "SELECT COALESCE(issue_id, -1) || '|' || COALESCE(branch_id, '') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;")
    if [ -n "$TASK_ROW" ] && ! tmb_audit_append "$DB" "${TASK_ROW%%|*}" "${TASK_ROW#*|}" "hook:swe-brief-gate" "swe_brief_fetched" \
        "SWE fetched task_brief for task_id=${TASK_ID}" \
        "{\"task_id\":${TASK_ID},\"agent_type\":\"swe\"}"; then
      jq -nc --arg ctx "TMB: the swe_brief_fetched sentinel for task_id=${TASK_ID} could not be recorded (trajectory DB write failed). If the next Edit/Write or trajectory-server call is denied, call task_brief(agent='swe', task_id=${TASK_ID}) again." \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$ctx}}'
    fi
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
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
exit 0
