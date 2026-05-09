#!/usr/bin/env bash
# PostToolUse hook on file_registry_update_summaries. After bro advances
# the verified SHA via summary updates, check whether the architecture
# regen state is now stale by more than the configured threshold, and
# emit a soft `additionalContext` nudge when it is.
#
# Cheaper than the prior tmb_lazy-regen-check skill because it runs only
# after a deliberate file_registry advance — not at every session start.
# The session-start-regen-check.sh hook still handles the first-impression
# nudge.
#
# Always silent on failure; never blocks the upstream MCP call.

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  *file_registry_update_summaries) ;;
  *) exit 0 ;;
esac

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

LAST_SHA=$(sqlite3 "$DB_PATH" "SELECT last_seen_sha FROM regen_state WHERE target='architecture' LIMIT 1;" 2>/dev/null)
[ -n "$LAST_SHA" ] || exit 0
git rev-parse "$LAST_SHA" >/dev/null 2>&1 || exit 0

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
[ -n "$HEAD_SHA" ] || exit 0
[ "$HEAD_SHA" != "$LAST_SHA" ] || exit 0

DRIFT=$(git rev-list --count "$LAST_SHA..HEAD" 2>/dev/null)
[ -n "$DRIFT" ] || exit 0

THRESHOLD=${TMB_REGEN_DRIFT_THRESHOLD:-25}
if [ "$DRIFT" -lt "$THRESHOLD" ]; then exit 0; fi

CTX="[tmb lazy-regen post-check] file_registry advanced past ${DRIFT} commits since the last architecture regen (threshold ${THRESHOLD}). Call \`architecture_regen(agent='bro', scope='full')\` when convenient to bring docs/trustmybot/architecture/auto/ in sync."

jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
