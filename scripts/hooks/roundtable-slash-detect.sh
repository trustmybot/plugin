#!/usr/bin/env bash
# UserPromptSubmit hook. Writes an audit row when the user types /roundtable
# so the server-side roundtable_create gate can verify the slash ceremony
# was Human-triggered rather than bro auto-firing from a phrase trigger
# (captured-bug L6 scenario 08).
#
# The audit row is the load-bearing signal — bro can't fake it from prose
# because UserPromptSubmit hooks run outside the LLM's context.
#
# Silent on failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)

# Match /roundtable at the start of the prompt or after whitespace.
# The trailing context can be anything (topic, args, etc.).
case "$PROMPT" in
  /roundtable*|*$'\n'/roundtable*|*' /roundtable'*) ;;
  *) exit 0 ;;
esac

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

SUMMARY=$(printf '%s' "$PROMPT" | head -c 200 | sed "s/'/''/g")

sqlite3 "$DB_PATH" <<SQL 2>&1 >/dev/null || true
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'system', 'roundtable_slash_invoked',
        'User typed /roundtable: $SUMMARY', '{}', datetime('now'));
SQL

exit 0
