#!/usr/bin/env bash
# UserPromptSubmit hook. Writes an audit row when the user types /roundtable
# so the server-side roundtable_create gate can verify the slash ceremony
# was Human-triggered rather than bro auto-firing from a phrase trigger
# (captured-bug L6 scenario 08).
#
# The audit row is the load-bearing signal — bro can't fake it from prose
# because UserPromptSubmit hooks run outside the LLM's context.
#
# The INSERT goes through tmb_audit_append, which retries through writer locks
# (2 attempts, 5 s busy timeout each here); on final failure it warns loudly on
# stderr but always exits 0 — the hook is fail-open and must never block the prompt.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"
export TMB_DB_WRITE_TIMEOUT_MS=5000
export TMB_DB_WRITE_RUN_BUDGET_MS=10200

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

SUMMARY=$(printf '%s' "$PROMPT" | head -c 200)

if ! tmb_audit_append "$DB_PATH" -1 '' "hook:roundtable-slash-detect" "roundtable_slash_invoked" \
    "User typed /roundtable: $SUMMARY" '{}' >/dev/null; then
  echo "tmb slash-detect: FAILED to record roundtable_slash_invoked after retrying ($DB_PATH) — roundtable_create's gate will refuse" >&2
fi

exit 0
