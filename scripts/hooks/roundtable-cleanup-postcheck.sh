#!/usr/bin/env bash
# PostToolUse on roundtable_close. Advisory: emits additionalContext when
# the closed roundtable is missing any of its expected capture surfaces
# (analysis/decision discussions, votes, outcome, roundtable_summary audit).
# Never blocks; silent on any local failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  *roundtable_close) ;;
  *) exit 0 ;;
esac

RT_ID=$(echo "$INPUT" | jq -r '.tool_input.roundtable_id // ""' 2>/dev/null)
[ -n "$RT_ID" ] || exit 0
RT_ID=$(tmb_sql_int "$RT_ID")
[ -n "$RT_ID" ] || exit 0

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

# Resolve the carrier issue_id for this roundtable.
ISSUE_ID=$(sqlite3 "$DB_PATH" "SELECT issue_id FROM roundtables WHERE id=${RT_ID} LIMIT 1;" 2>/dev/null || true)
[ -n "$ISSUE_ID" ] || exit 0
ISSUE_ID=$(tmb_sql_int "$ISSUE_ID")
[ -n "$ISSUE_ID" ] || exit 0

ANALYSES=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM discussions WHERE issue_id=${ISSUE_ID} AND kind='analysis';" 2>/dev/null || echo 0)
DECISIONS=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM discussions WHERE issue_id=${ISSUE_ID} AND kind='decision';" 2>/dev/null || echo 0)
RT_STATE=$(sqlite3 "$DB_PATH" \
  "SELECT state || '|' || COALESCE(outcome,'') FROM roundtables WHERE id=${RT_ID} LIMIT 1;" 2>/dev/null || true)
VOTES=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM roundtable_votes WHERE roundtable_id=${RT_ID};" 2>/dev/null || echo 0)
SUMMARY_EVT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_summary' AND issue_id=${ISSUE_ID};" 2>/dev/null || echo 0)

RT_STATUS=$(printf '%s' "$RT_STATE" | cut -d'|' -f1)
RT_OUTCOME=$(printf '%s' "$RT_STATE" | cut -d'|' -f2-)

MISSING=""
[ "$ANALYSES"    -ge 1 ]      || MISSING="$MISSING analysis-discussions"
[ "$DECISIONS"   -ge 1 ]      || MISSING="$MISSING decision-discussions"
[ "$RT_STATUS"   = "closed" ] || MISSING="$MISSING roundtable.status=closed"
[ -n "$RT_OUTCOME" ]          || MISSING="$MISSING roundtable.outcome"
[ "$VOTES"       -ge 1 ]      || MISSING="$MISSING votes"
[ "$SUMMARY_EVT" -ge 1 ]      || MISSING="$MISSING audit(roundtable_summary)"

[ -z "$MISSING" ] && exit 0

CTX="[tmb roundtable-cleanup] roundtable_id=$RT_ID closed but the following capture surfaces are missing:$MISSING. Re-call the relevant tools (discussion_append for analysis/decision, roundtable_vote, roundtable_summarize, audit_log) so the trajectory is auditable."

jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
