#!/usr/bin/env bash
# UserPromptSubmit hook. Writes an audit row when the user types /roundtable
# so the server-side roundtable_create gate can verify the slash ceremony
# was Human-triggered rather than bro auto-firing from a phrase trigger
# (captured-bug L6 scenario 08).
#
# The audit row is the load-bearing signal — bro can't fake it from prose
# because UserPromptSubmit hooks run outside the LLM's context.
#
# The INSERT retries through writer locks; on final failure it warns loudly on
# stderr but always exits 0 — the hook is fail-open and must never block the prompt.

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

# Bounded retry: the audit row is load-bearing, but a long writer lock can
# outlast a single busy timeout. Retry a few times before giving up loudly.
inserted=0
for attempt in 1 2 3; do
  if sqlite3 -cmd '.timeout 5000' "$DB_PATH" <<SQL >/dev/null 2>&1
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'system', 'roundtable_slash_invoked',
        'User typed /roundtable: $SUMMARY', '{}', datetime('now'));
SQL
  then
    inserted=1
    break
  fi
  [ "$attempt" -lt 3 ] && sleep 0.5
done

if [ "$inserted" -ne 1 ]; then
  echo "tmb slash-detect: FAILED to record roundtable_slash_invoked after 3 attempts ($DB_PATH) — roundtable_create's gate will refuse" >&2
fi

exit 0
