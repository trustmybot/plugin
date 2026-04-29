#!/usr/bin/env bash
# UserPromptSubmit hook: auto-saves per-session user prompts to
# <workspace>/.claude/tmb/logs/<YYYY-MM-DD>-<session-id>.jsonl.
# Silent no-op when workspace not detected. Never blocks the session.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

DB_PATH=$(tmb_db_path 2>/dev/null) || true
[ -z "$DB_PATH" ] && exit 0

WORKSPACE=$(dirname "$(dirname "$(dirname "$DB_PATH")")")
LOG_DIR="$WORKSPACE/.claude/tmb/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

SENTINEL="$WORKSPACE/.claude/tmb/.current-session-id"
if [ ! -f "$SENTINEL" ]; then
  printf '%s' "$(date -u +%Y%m%d-%H%M%S)-$$" > "$SENTINEL" 2>/dev/null || true
fi
SESSION_ID=$(cat "$SENTINEL" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

LOG_FILE="$LOG_DIR/$(date -u +%Y-%m-%d)-${SESSION_ID}.jsonl"

INPUT=$(cat)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "$INPUT" | jq -c \
  --arg ts "$TS" \
  --arg event "user_prompt" \
  '{ts: $ts, event: $event, prompt: (.prompt // ""), additional_context: (.additionalContext // "")}' \
  >> "$LOG_FILE" 2>/dev/null || true

echo '{"continue": true}'
exit 0
