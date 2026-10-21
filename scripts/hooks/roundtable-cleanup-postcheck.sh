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
  *roundtable_close|*roundtable_close_with_decisions) ;;
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

# One read: the carrier issue_id, its capture counts, and the roundtable's
# state and outcome (last, so a '|' inside the outcome stays in it).
ROW=$(tmb_sqlite_ro "$DB_PATH" "SELECT r.issue_id,
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'analysis'),
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'decision'),
    (SELECT COUNT(*) FROM roundtable_votes v WHERE v.roundtable_id = r.id),
    (SELECT COUNT(*) FROM audit a WHERE a.event_type = 'roundtable_summary' AND a.issue_id = r.issue_id),
    r.state, COALESCE(r.outcome, '')
  FROM roundtables r WHERE r.id = ${RT_ID} LIMIT 1;")
IFS='|' read -r ISSUE_ID ANALYSES DECISIONS VOTES SUMMARY_EVT RT_STATUS RT_OUTCOME <<<"$ROW"
[ -n "$(tmb_sql_int "${ISSUE_ID:-}")" ] || exit 0

MISSING=""
[ "$ANALYSES"    -ge 1 ]      || MISSING="$MISSING analysis-discussions"
[ "$DECISIONS"   -ge 1 ]      || MISSING="$MISSING decision-discussions"
[ "$RT_STATUS"   = "closed" ] || MISSING="$MISSING roundtable.status=closed"
[ -n "$RT_OUTCOME" ]          || MISSING="$MISSING roundtable.outcome"
[ "$VOTES"       -ge 1 ]      || MISSING="$MISSING votes"
[ "$SUMMARY_EVT" -ge 1 ]      || MISSING="$MISSING audit(roundtable_summary)"

[ -z "$MISSING" ] && exit 0

CTX="[tmb roundtable-cleanup] roundtable_id=$RT_ID closed but the following capture surfaces are missing:$MISSING. Re-call the relevant tools (discussion_append for analysis/decision, roundtable_vote, roundtable_summarize, audit_append) so the trajectory is auditable."

jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
