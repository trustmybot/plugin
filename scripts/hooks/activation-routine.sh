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
  # Sticky if either the assistant announced explicitly OR the user
  # addressed `@bro` (the explicit sigil) in a prior turn. The sigil is
  # required, not a bare `bro` word: a bare-keyword scan over the whole
  # transcript matches the hooks' own emitted context and every assistant
  # mention of bro, flipping plain sessions into bro-mode forever (#276).
  grep -q 'Entering bro mode.' "$TRANSCRIPT" 2>/dev/null && return 0
  grep -qiE '@bro\b' "$TRANSCRIPT" 2>/dev/null && return 0
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
  # #2872: walk up from PWD to find the live DB. Workspace-pattern projects
  # keep .claude/<plugin>/trajectory.db at the workspace root above the
  # inner repos; without walk-up the hook (PWD = inner repo) reads a stale
  # empty seed and the MCP server reads the workspace one — false 'first
  # contact' on every turn.
  #
  # P0 guard: never traverse INTO the user's HOME from a descendant cwd.
  # A stale ~/.claude/<plugin>/trajectory.db (from a prior buggy session or
  # a test artifact) used to be silently adopted as the live DB on every
  # launch from any project below HOME — project state escaped into the
  # profile. Mirrors the corresponding fix in db.ts's findExistingDbUp.
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    if [ "$dir" = "$HOME" ] && [ "$PWD" != "$HOME" ]; then
      break
    fi
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then
      DB_PATH="$candidate"
      break
    fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$DB_PATH" ] && DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

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
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${ONBOARDED_LINE}; ${PENDING_LINE}. ACTION: this is the user's first contact in this project — call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call issue_resume separately — onboard_state_get returns everything you need."
else
  CONTEXT="[tmb activation routine — pre-fetched by hook] ${ONBOARDED_LINE}; ${PENDING_LINE}. Use this to compose the welcome banner; do NOT also call issue_resume — they would be redundant duplicate reads."
fi

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
