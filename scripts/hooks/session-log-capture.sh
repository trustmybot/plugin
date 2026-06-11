#!/usr/bin/env bash
# UserPromptSubmit hook: auto-saves per-session user prompts to
# <workspace>/.claude/<plugin-name>/logs/<YYYY-MM-DD>-<session-id>.jsonl.
# Silent no-op when workspace not detected. Never blocks the session.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/resolve-plugin-name.sh
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"
PLUGIN_NAME=$(tmb_resolve_plugin_name)
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)

DB_PATH=$(tmb_db_path 2>/dev/null) || true
[ -z "$DB_PATH" ] && exit 0

WORKSPACE=$(dirname "$(dirname "$(dirname "$DB_PATH")")")
LOG_DIR="$WORKSPACE/.claude/${PLUGIN_NAME}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

SENTINEL="$WORKSPACE/.claude/${PLUGIN_NAME}/.current-session-id"

# Prefer the session_id CC provides on stdin; fall back to sentinel file (#389).
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || true)
if [ -z "$SESSION_ID" ] && [ -f "$SENTINEL" ]; then
  SESSION_ID=$(cat "$SENTINEL" 2>/dev/null || true)
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(date -u +%Y%m%d-%H%M%S)-$$"
fi
[ -z "$SESSION_ID" ] && exit 0

LOG_FILE="$LOG_DIR/$(date -u +%Y-%m-%d)-${SESSION_ID}.jsonl"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "$INPUT" | jq -c \
  --arg ts "$TS" \
  --arg event "user_prompt" \
  '{ts: $ts, event: $event, prompt: (.prompt // ""), additional_context: (.additionalContext // "")}' \
  >> "$LOG_FILE" 2>/dev/null || true

echo '{"continue": true}'
exit 0
