#!/usr/bin/env bash
# Hook: Deny-until-briefed gate for SWE subagents.
#
# CC's PreToolUse hook contract does NOT support updatedInput (prompt mutation).
# The deterministic fallback: block SWE from calling any trajectory-server MCP
# tool other than task_brief — AND from calling Edit/Write/NotebookEdit — until
# task_brief has been called for that task. The task_brief handler writes the
# audit sentinel 'swe_brief_fetched'; this hook only reads it.
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
#   2. Tool is task_brief          → bind the run row, then allow (the handler
#                                    writes the sentinel)
#   3. Sentinel exists             → allow (brief already fetched for this task)
#   4. No sentinel + blocked tool  → DENY with recovery instruction
#
# Run binding (task_brief only, fail-open, never denies): the payload's
# agent_id keys the spawn's swe agent_runs row. With no row of the task keyed by
# that agent_id, the task's newest open swe row whose spawn_id is NULL or
# tool_use:* (opened by record-swe-spawn.sh) is rebound to spawn_id = agent_id,
# and task_brief's openSweRun finds it open and inserts none. With every keyed
# row closed (a swe resumed through SendMessage, GH 1742), nothing is reopened:
# a swe_resume_observed audit row names the agent_id, and openSweRun opens a
# new row for it with resumed_from = its previous row.
#
# Skips:
#   - Non-SWE callers (bro, code-reviewer, etc.)
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
# shellcheck source=scripts/hooks/lib/agent-context.sh
. "$SCRIPT_DIR/lib/agent-context.sh"

INPUT=$(cat)

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")

[ "$AGENT_TYPE" = "swe" ] || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

# The task_id comes from the swe's own spawn transcript (first human turn
# contains 'task_id=N'; agent_transcript_path, else the subagents file beside
# the session transcript) or from tool_input fields (task_update_status,
# task_get, etc. pass task_id directly). Never from the cwd (GH 1550).
TASK_ID=$(tmb_task_id_from_transcript "$(tmb_agent_transcript "$INPUT")")

if [ -z "$TASK_ID" ]; then
  TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // empty' 2>/dev/null || true)
  case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
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
  AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
  if [ -n "$AGENT_ID" ]; then
    SAFE_AGENT_ID=$(tmb_sql_quote "$AGENT_ID")
    KEYED=$(tmb_sqlite_ro "$DB" "
SELECT COALESCE(MAX(completed_at IS NULL), -1) || '|' || (SELECT issue_id FROM tasks WHERE id = ${TASK_ID})
  FROM agent_runs
 WHERE task_id = ${TASK_ID} AND agent_type = 'swe' AND spawn_id = '${SAFE_AGENT_ID}';" 2>/dev/null || true)
    case "$KEYED" in
      -1\|*)
        tmb_db_write "$DB" "
UPDATE agent_runs SET spawn_id = '${SAFE_AGENT_ID}'
 WHERE id = (SELECT id FROM agent_runs
              WHERE task_id = ${TASK_ID} AND agent_type = 'swe' AND completed_at IS NULL
                AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
              ORDER BY id DESC LIMIT 1);" >/dev/null 2>&1 || true
        ;;
      0\|*)
        RESUME_JSON=$(jq -cn --argjson t "$TASK_ID" --arg g "$AGENT_ID" --arg o "$(tmb_now_iso)" \
          '{task_id:$t, agent_id:$g, observed_at:$o, consumed:0}')
        tmb_audit_append "$DB" "${KEYED#*|}" '' "hook:swe-brief-gate" "swe_resume_observed" \
          "swe ${AGENT_ID} resumed task ${TASK_ID} and called task_brief" "$RESUME_JSON" >/dev/null 2>&1 || true
        ;;
    esac
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
