#!/usr/bin/env bash
# Session-start lazy-regen check (#108).
#
# On session start, computes git drift between regen_state.last_seen_sha
# and current HEAD. If drift exceeds the threshold (25 commits, matching
# tmb_lazy-regen-check), emits additionalContext suggesting bro run
# tmb_refresh-architecture. Pre-empts the manual check that bro is
# supposed to do at the start of every code-touching ask — but doesn't
# always remember to do.
#
# Silent no-op when:
#   - DB doesn't exist (first activation in a fresh project)
#   - regen_state has no row for 'architecture' target (never regen'd)
#   - HEAD is missing or matches last_seen_sha (no drift)
#   - drift is below threshold
#   - sqlite3 / git missing
# Capture failures must never break the user's session.

set -uo pipefail

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
command -v jq >/dev/null 2>&1 || exit 0

LAST_SHA=$(sqlite3 "$DB_PATH" "SELECT last_seen_sha FROM regen_state WHERE target='architecture' LIMIT 1;" 2>/dev/null)
[ -n "$LAST_SHA" ] || exit 0

git rev-parse "$LAST_SHA" >/dev/null 2>&1 || exit 0

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
[ -n "$HEAD_SHA" ] || exit 0
[ "$HEAD_SHA" != "$LAST_SHA" ] || exit 0

DRIFT=$(git rev-list --count "$LAST_SHA..HEAD" 2>/dev/null)
[ -n "$DRIFT" ] || exit 0

THRESHOLD=${TMB_REGEN_DRIFT_THRESHOLD:-25}
if [ "$DRIFT" -lt "$THRESHOLD" ]; then
  exit 0
fi

CONTEXT="[tmb session-start regen check] Architecture docs are stale: ${DRIFT} commits since last regen (threshold: ${THRESHOLD}). When convenient, call \`architecture_regen(agent='bro', scope='full')\` to bring docs/trustmybot/architecture/auto/ back in sync."

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
