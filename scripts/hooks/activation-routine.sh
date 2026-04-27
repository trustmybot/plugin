#!/usr/bin/env bash
# Activation-routine hook (#108).
#
# Pre-fetches identity + pending issue from the trajectory DB on every
# bro-triggered UserPromptSubmit, and injects them as additionalContext.
# Bro composes the welcome banner from the injected data instead of relying
# on prompt-only doctrine to call identity_get + issue_resume — h4 A/B
# proved that ceiling is 0/10 in both wording arms.
#
# Bro mode active when:
#   - current prompt contains the word "bro" (case-insensitive), OR
#   - the transcript shows a prior "Entering bro mode." line AND no later
#     "exit bro mode" / "stop being bro".
#
# Silent no-op when:
#   - not in bro mode
#   - DB doesn't exist yet (first activation in a fresh project)
#   - sqlite3 / jq missing
# Capture failures must never break the user's session.

set -uo pipefail

INPUT=$(cat)

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)

contains_bro_word() {
  echo "$1" | grep -qiE '\bbro\b'
}

is_sticky_bro() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || return 1
  if grep -qiE 'exit bro mode|stop being bro' "$TRANSCRIPT" 2>/dev/null; then
    return 1
  fi
  # Sticky if either the assistant announced explicitly OR any user
  # message in the transcript contains the `bro` trigger keyword. Catches
  # the case where bro skipped the announcement (h3/h4 prompt-discipline
  # ceiling) but the user clearly addressed @bro in a prior turn.
  grep -q 'Entering bro mode.' "$TRANSCRIPT" 2>/dev/null && return 0
  grep -qiE '\bbro\b' "$TRANSCRIPT" 2>/dev/null && return 0
  return 1
}

if ! contains_bro_word "$PROMPT" && ! is_sticky_bro; then
  exit 0
fi

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
command -v jq >/dev/null 2>&1 || exit 0

IDENTITY=$(sqlite3 "$DB_PATH" "SELECT human_name FROM identity LIMIT 1;" 2>/dev/null)
PENDING=$(sqlite3 -separator $'\x1f' "$DB_PATH" "SELECT id, objective FROM issues WHERE status='open' ORDER BY id DESC LIMIT 1;" 2>/dev/null)

if [ -n "$IDENTITY" ]; then
  IDENTITY_LINE="identity=${IDENTITY}"
else
  IDENTITY_LINE="identity=<unset> (use anonymous greeting)"
fi

if [ -n "$PENDING" ]; then
  PENDING_ID="${PENDING%%$'\x1f'*}"
  PENDING_OBJ="${PENDING#*$'\x1f'}"
  PENDING_LINE="pending=#${PENDING_ID}: ${PENDING_OBJ}"
else
  PENDING_LINE="pending=<none>"
fi

CONTEXT="[tmb activation routine — pre-fetched by hook] ${IDENTITY_LINE}; ${PENDING_LINE}. Use this to compose the welcome banner; do NOT also call identity_get / issue_resume — they would be redundant duplicate reads."

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
