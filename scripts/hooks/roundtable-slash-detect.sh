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

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  # Walk up to find existing DB (#2872 same-pattern as activation hook).
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then DB_PATH="$candidate"; break; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$DB_PATH" ] && DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi
[ -f "$DB_PATH" ] || exit 0

SUMMARY=$(printf '%s' "$PROMPT" | head -c 200 | sed "s/'/''/g")

sqlite3 "$DB_PATH" <<SQL >/dev/null 2>&1 || true
INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
VALUES (999999, NULL, 'system', 'event', 'roundtable_slash_invoked',
        'User typed /roundtable: $SUMMARY', '{}', datetime('now'));
SQL

exit 0
