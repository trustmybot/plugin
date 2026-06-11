#!/usr/bin/env bash
# SubagentStop hook — consultant persistence gate (#468).
#
# When a TMB consultant subagent stops, this hook checks the trajectory DB for
# at least one discussion row authored by that agent on the most recent open
# issue. Zero rows → block the stop with a recovery message teaching the agent
# to call discussion_append before returning.
#
# Fires on: SubagentStop
# Target: <1s wall time.
#
# Pass-through when:
#   - DB absent or sqlite3 absent
#   - Agent not resolvable from input
#   - Agent is bro, swe, or pr-reviewer (backbone roles)
#   - Agent is not in the agents table (non-TMB project)
#   - Agent has at least one discussion row on the most recent open issue
#   - stop_hook_active is set in input (CC re-entrancy guard)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh" 2>/dev/null || true

INPUT=$(cat)

# Honor CC's stop_hook_active re-entrancy flag.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || true)
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Resolve and normalize the stopping agent's role.
RAW_AGENT=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
AGENT_NAME=$(tmb_normalize_role "$RAW_AGENT")

# Pass through if agent is not resolvable.
[ -n "$AGENT_NAME" ] || exit 0

# Pass through for backbone roles — only consultants need the persistence gate.
case "$AGENT_NAME" in
  bro|swe|pr-reviewer)
    exit 0
    ;;
esac

# Resolve DB and sqlite3.
DB=""
if command -v tmb_db_path >/dev/null 2>&1; then
  DB=$(tmb_db_path 2>/dev/null || true)
fi
if [ -z "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Confirm agent is a known TMB consultant in the agents table.
# Non-TMB projects won't have the agents table at all — treat as pass-through.
SAFE_AGENT=$(tmb_sql_quote "$AGENT_NAME")
IS_CONSULTANT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM agents WHERE name='${SAFE_AGENT}' AND kind='consultant';" \
  2>/dev/null || true)

# Pass through when agents table is missing or agent is not a TMB consultant.
[ "${IS_CONSULTANT:-0}" = "1" ] || exit 0

# Find the most recent open issue.
OPEN_ISSUE_ID=$(sqlite3 "$DB" \
  "SELECT id FROM issues WHERE status='open' ORDER BY updated_at DESC, id DESC LIMIT 1;" \
  2>/dev/null || true)

[ -n "$OPEN_ISSUE_ID" ] || exit 0
SAFE_ISSUE_ID=$(tmb_sql_int "$OPEN_ISSUE_ID")
[ -n "$SAFE_ISSUE_ID" ] || exit 0

# Check for at least one discussion row by this agent on the open issue.
DISC_COUNT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM discussions WHERE author='${SAFE_AGENT}' AND issue_id=${SAFE_ISSUE_ID};" \
  2>/dev/null || true)

if [ "${DISC_COUNT:-0}" -ge 1 ]; then
  exit 0
fi

# Zero rows — block the stop with a recovery message.
RECOVERY_MSG="Consultant persistence gate: you must persist your analysis before returning. Append your analysis via discussion_append(agent='${AGENT_NAME}', issue_id=${SAFE_ISSUE_ID}, author='${AGENT_NAME}', kind='analysis', body=<your analysis>) then return."
jq -nc --arg reason "$RECOVERY_MSG" '{"decision":"block","reason":$reason}'

exit 0
