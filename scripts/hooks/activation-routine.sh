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

IDENTITY_ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM identity WHERE id = 1;" 2>/dev/null)
IDENTITY_NAME=$(sqlite3 "$DB_PATH" "SELECT human_name FROM identity WHERE id = 1;" 2>/dev/null)
PENDING=$(sqlite3 -separator $'\x1f' "$DB_PATH" \
  "SELECT id, objective FROM issues WHERE status='open' AND id < 999999 ORDER BY id DESC LIMIT 1;" \
  2>/dev/null)

# Three states the hook must distinguish:
#   - row absent     → first contact; bro must auto-fire /onboard
#   - row + name     → onboarded, named
#   - row + no name  → onboarded, anonymous (still onboarded — #95)
FIRST_RUN=0
if [ "$IDENTITY_ROW_COUNT" = "0" ]; then
  FIRST_RUN=1
  IDENTITY_LINE="identity=<no row — FIRST CONTACT, auto-fire /onboard before any reply>"
elif [ -n "$IDENTITY_NAME" ]; then
  IDENTITY_LINE="identity=${IDENTITY_NAME}"
else
  IDENTITY_LINE="identity=<anonymous> (row exists, no name set — use anonymous greeting)"
fi

if [ -n "$PENDING" ]; then
  PENDING_ID="${PENDING%%$'\x1f'*}"
  PENDING_OBJ="${PENDING#*$'\x1f'}"
  PENDING_LINE="pending=#${PENDING_ID}: ${PENDING_OBJ}"
else
  PENDING_LINE="pending=<none>"
fi

if [ "$FIRST_RUN" = "1" ]; then
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${IDENTITY_LINE}; ${PENDING_LINE}. ACTION: this is the user's first contact in this project — call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call identity_get / issue_resume separately — onboard_state_get returns everything you need."
else
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${IDENTITY_LINE}; ${PENDING_LINE}. Use this to compose the welcome banner; do NOT also call identity_get / issue_resume — they would be redundant duplicate reads."
fi

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
