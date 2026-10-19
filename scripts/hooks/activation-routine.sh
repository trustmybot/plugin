#!/usr/bin/env bash
# Activation-routine hook (#108).
#
# Pre-fetches onboarded marker + pending issue from the trajectory DB on every
# bro-triggered UserPromptSubmit, and injects them as additionalContext.
# Bro composes the welcome banner from the injected data instead of relying
# on prompt-only doctrine to call onboard_state_get + issue_resume — h4 A/B
# proved that ceiling is 0/10 in both wording arms.
#
# Bro mode active when:
#   - the current prompt, typed by the Human (not a harness turn), contains
#     the word "bro" (case-insensitive), OR
#   - the transcript shows a prior "Entering bro mode." line AND no later
#     "exit bro mode" / "stop being bro".
#
# MCP HALT: in bro mode the hook also checks that this plugin's
# trajectory-server process is running. By UserPromptSubmit the session is up,
# so an absent server is evidence (unlike a SessionStart sample): the context
# then carries the HALT + recovery pointer (tmb_recovery §C).
#
# Session id: the context ends with session_id=<id> (the payload's session_id,
# when it is 8–64 chars of [A-Za-z0-9_-]) so bro can pass it to task_provision /
# task_create_batch / task_reopen / task_retry, which validate it; bro usage is
# metered per session by the bro-turn-usage Stop hook.
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
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)

contains_bro_word() {
  echo "$1" | grep -iE '\bbro\b' >/dev/null
}

is_sticky_bro() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || return 1
  if grep -qiE 'exit bro mode|stop being bro' "$TRANSCRIPT" 2>/dev/null; then
    return 1
  fi
  # Sticky if either the assistant announced explicitly OR the user
  # addressed `@bro` (the explicit sigil) in a prior turn. The sigil is
  # required, not a bare `bro` word: a bare-keyword scan over the whole
  # transcript matches the hooks' own emitted context and every assistant
  # mention of bro, flipping plain sessions into bro-mode forever (#276).
  grep -q 'Entering bro mode.' "$TRANSCRIPT" 2>/dev/null && return 0
  grep -qiE '@bro\b' "$TRANSCRIPT" 2>/dev/null && return 0
  return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

# A harness turn (notification, subagent hand-back, agent message) that merely
# mentions bro does not activate bro mode; only the Human's own prompt or the
# sticky transcript signal does.
PROMPT_SAYS_BRO=0
if ! tmb_is_harness_turn "$PROMPT" && contains_bro_word "$PROMPT"; then
  PROMPT_SAYS_BRO=1
fi
if [ "$PROMPT_SAYS_BRO" = 0 ] && ! is_sticky_bro; then
  exit 0
fi

# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

command -v jq >/dev/null 2>&1 || exit 0

HALT_TEXT=""
if command -v pgrep >/dev/null 2>&1; then
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    _pattern="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js"
  else
    _pattern="trajectory-server/dist/index.js"
  fi
  if [ "$({ pgrep -f "$_pattern" 2>/dev/null || true; } | wc -l | tr -d ' ')" = "0" ]; then
    HALT_TEXT="⛔ MCP trajectory-server is not running at this prompt — trajectory tools (state reads and writes) are unreachable. Bro: HALT. Do not dispatch work; load tmb_recovery §C and follow it. The read-only sqlite3 fallback (bro-sqlite-readonly.sh) stays available for emergency reads."
  fi
fi

emit() {
  jq -nc --arg ctx "$1" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
}

halt_only() {
  [ -n "$HALT_TEXT" ] && emit "$HALT_TEXT"
  exit 0
}

DB_PATH=$(tmb_db_path_advisory activation-routine) || halt_only
tmb_have_sqlite || halt_only

ONBOARDED_ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM plugin_config WHERE key='onboarded' AND value_json='true';" 2>/dev/null)
PENDING=$(sqlite3 -separator $'\x1f' "$DB_PATH" \
  "SELECT id, objective FROM issues WHERE status='open' AND id > 0 ORDER BY id DESC LIMIT 1;" \
  2>/dev/null)

# Two states the hook must distinguish:
#   - row absent  → first contact; bro must auto-fire /onboard
#   - row present → onboarded (pure marker — no name or other fields are stored)
FIRST_RUN=0
if [ "$ONBOARDED_ROW_COUNT" = "0" ]; then
  FIRST_RUN=1
  ONBOARDED_LINE="onboarded=<no — FIRST CONTACT, auto-fire /onboard before any reply>"
else
  ONBOARDED_LINE="onboarded=yes"
fi

if [ -n "$PENDING" ]; then
  PENDING_ID="${PENDING%%$'\x1f'*}"
  PENDING_OBJ="${PENDING#*$'\x1f'}"
  PENDING_LINE="pending=#${PENDING_ID}: ${PENDING_OBJ}"
else
  PENDING_LINE="pending=<none>"
fi

if [ "$FIRST_RUN" = "1" ]; then
  # STABLE preamble first, VOLATILE pending line last — cache-friendly ordering.
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${ONBOARDED_LINE}. ACTION: this is the user's first contact in this project — call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call issue_resume separately — onboard_state_get returns everything you need. ${PENDING_LINE}"
else
  # STABLE preamble first, VOLATILE pending line last — cache-friendly ordering.
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${ONBOARDED_LINE}. Use this to compose the welcome banner; do NOT also call issue_resume — they would be redundant duplicate reads. ${PENDING_LINE}"
fi

if [ -n "$HALT_TEXT" ]; then
  CONTEXT="${HALT_TEXT} ${CONTEXT}"
fi
if printf '%s' "$SESSION_ID" | grep -E '^[A-Za-z0-9_-]{8,64}$' >/dev/null; then
  CONTEXT="${CONTEXT} session_id=${SESSION_ID}"
fi
emit "$CONTEXT"
