#!/usr/bin/env bash
# PreToolUse hook on trajectory-server tools — the `agent` argument must name
# the real caller.
#
# The server derives the caller's role (requireRoles, audit writers) from the
# `agent` argument the caller supplies; it never sees the hook payload. This
# hook does: a subagent call carries the payload's agent_type, a main-session
# call carries none.
#
#   tool_input.agent absent            → allow.
#   payload agent_type (subagent_type) → agent must name the same role.
#   no agent_type (main session, harness turns included) → agent must be bro.
#
# Both sides go through tmb_normalize_role (a plugin prefix such as `tmb:` is
# dropped) and compare case-insensitively, as the server's normalizeAgent does.
# A mismatch denies with a reason naming the tool and both values and writes
# one agent_arg_mismatch audit row (from_node hook:agent-arg-matches-caller,
# content {tool, given, actual, task_id}) on the task's issue when tool_input
# carries a task_id, else on the system issue -1. The decision never depends
# on the trajectory DB: when it is missing, unreadable or the write fails, a
# mismatch still denies and a match still allows.
set -uo pipefail

export TMB_DB_WRITE_RUN_BUDGET_MS=2500

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || { echo "agent-arg-matches-caller: jq not found" >&2; exit 1; }

FIELDS=$(printf '%s' "$INPUT" | jq -r '
  [(.tool_name // ""),
   (.tool_input.agent // "" | tostring),
   (.agent_type // .subagent_type // ""),
   (.tool_input.task_id // "" | tostring)]
  | map(gsub("[\\n\\r\u001f]"; " ")) | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r TOOL_NAME GIVEN_RAW ACTUAL_RAW TASK_RAW <<< "$FIELDS"

[ -n "${GIVEN_RAW:-}" ] || exit 0
case "${TOOL_NAME:-}" in
  mcp__*trajectory-server__*) ;;
  *) exit 0 ;;
esac

GIVEN=$(tmb_normalize_role "$GIVEN_RAW" | tr '[:upper:]' '[:lower:]')
ACTUAL=$(tmb_normalize_role "${ACTUAL_RAW:-}" | tr '[:upper:]' '[:lower:]')
[ -n "$ACTUAL" ] || ACTUAL="bro"

[ "$GIVEN" = "$ACTUAL" ] && exit 0

TOOL_SHORT="${TOOL_NAME##*trajectory-server__}"
if [ -z "${ACTUAL_RAW:-}" ]; then
  CALLER="the main session (bro)"
else
  CALLER="a ${ACTUAL} subagent"
fi
REASON="BLOCKED: ${TOOL_SHORT} called with agent='${GIVEN_RAW}' but the caller is ${CALLER}; pass agent='${ACTUAL}'."

# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh" 2>/dev/null || true

if command -v tmb_db_state >/dev/null 2>&1 && [ "$(tmb_db_state)" = "ok" ]; then
  DB=$(tmb_db_path)
  TASK_ID=$(tmb_sql_int "${TASK_RAW:-}")
  ISSUE=-1
  if [ -n "$TASK_ID" ]; then
    FOUND=$(tmb_sql_int "$(tmb_sqlite_ro "$DB" "SELECT issue_id FROM tasks WHERE id = ${TASK_ID};")")
    [ -n "$FOUND" ] && ISSUE="$FOUND"
  fi
  CONTENT=$(jq -cn --arg tool "$TOOL_SHORT" --arg given "$GIVEN_RAW" --arg actual "$ACTUAL" --arg tid "$TASK_ID" \
    '{tool:$tool, given:$given, actual:$actual, task_id:(if $tid == "" then null else ($tid | tonumber) end)}')
  tmb_audit_append "$DB" "$ISSUE" '' "hook:agent-arg-matches-caller" "agent_arg_mismatch" \
    "${TOOL_SHORT}: agent='${GIVEN_RAW}' but the caller is ${CALLER}" "$CONTENT" >/dev/null 2>&1 || true
fi

jq -nc --arg r "$REASON" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
