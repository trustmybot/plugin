#!/usr/bin/env bash
# PreToolUse hook on validation_record — records who is calling it.
#
# The server never sees hook payloads, and every hook in a session carries the
# main session's session_id; the payload's agent_id is the only per-subagent
# identifier. When the caller is a pr-reviewer subagent (agent_id present,
# agent_type normalises to pr-reviewer), this hook writes one
# reviewer_identity_observed audit row on the task's issue:
#   {task_id, attempt_n, session_id, agent_id, tool_use_id, observed_at, consumed: 0}
# tool_use_id is null when the payload carries none. validation_record stamps
# subagent_session_id and reviewer_agent_id from the newest unconsumed row for
# (task_id, attempt_n) observed within its freshness window and marks it consumed.
#
# Observe-only: always allows. Fails closed only when the trajectory DB is
# unavailable (read error or failed write) — validation_record could not
# verify the reviewer anyway.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || { echo "reviewer-identity-observe: jq not found — caller not recorded" >&2; exit 0; }

case "$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)" in
  mcp__*trajectory-server__validation_record) ;;
  *) exit 0 ;;
esac

AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null)
[ -n "$AGENT_ID" ] || exit 0
AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null)")
[ "$AGENT_TYPE" = "pr-reviewer" ] || exit 0

SAFE_TASK_ID=$(tmb_sql_int "$(printf '%s' "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)")
ATTEMPT_N=$(tmb_sql_int "$(printf '%s' "$INPUT" | jq -r '.tool_input.attempt_n // ""' 2>/dev/null)")
[ -n "$SAFE_TASK_ID" ] && [ -n "$ATTEMPT_N" ] || exit 0
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
TOOL_USE_ID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // ""' 2>/dev/null)

case "$(tmb_db_state)" in
  unresolved) exit 0 ;;
  error) tmb_deny_db_unavailable reviewer-identity-observe; exit 0 ;;
esac
DB=$(tmb_db_path)

ISSUE_ID=$(tmb_gate_read "$DB" "SELECT issue_id FROM tasks WHERE id = ${SAFE_TASK_ID};")
if [ "$ISSUE_ID" = "__ERR__" ]; then
  tmb_deny_db_unavailable reviewer-identity-observe
  exit 0
fi
[ -n "$ISSUE_ID" ] || exit 0

CONTENT=$(jq -cn --argjson t "$SAFE_TASK_ID" --argjson a "$ATTEMPT_N" --arg s "$SESSION_ID" --arg g "$AGENT_ID" \
  --arg u "$TOOL_USE_ID" --arg o "$(tmb_now_iso)" \
  '{task_id:$t, attempt_n:$a, session_id:$s, agent_id:$g, tool_use_id:(if $u == "" then null else $u end), observed_at:$o, consumed:0}')

if ! tmb_audit_append "$DB" "$ISSUE_ID" '' "hook:reviewer-identity-observe" "reviewer_identity_observed" \
  "pr-reviewer ${AGENT_ID} called validation_record for task ${SAFE_TASK_ID} attempt ${ATTEMPT_N}" "$CONTENT"; then
  tmb_deny_db_unavailable reviewer-identity-observe
fi
exit 0
