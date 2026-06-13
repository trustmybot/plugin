#!/usr/bin/env bash
# SessionStart hook — probes required host binaries and emits a loud
# TMB-DEGRADED banner into additionalContext when any are missing.
#
# Healthy path (all 4 present): exits 0, emits nothing.
# Degraded path (any missing):  emits hookSpecificOutput.additionalContext
#   beginning "TMB DEGRADED:" naming each missing binary and consequence.
#
# Self-contained: JSON is built with printf, NOT jq — jq may itself be missing.

set -euo pipefail

MISSING_PARTS=""

_check() {
  local bin="$1"
  local consequence="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [ -n "$MISSING_PARTS" ]; then
      MISSING_PARTS="${MISSING_PARTS}; "
    fi
    MISSING_PARTS="${MISSING_PARTS}missing ${bin} — ${consequence}"
  fi
}

_check jq      "most PreToolUse gates and the bro/swe doctrine hooks are inoperative"
_check sqlite3 "task/spawn gates cannot verify state"
_check git     "branch guards and commit-message lint are inoperative"
_check node    "MCP trajectory-server and scan tooling cannot start"

[ -z "$MISSING_PARTS" ] && exit 0

CONTEXT="TMB DEGRADED: ${MISSING_PARTS}. Install the missing tools to restore enforcement."

# Escape for JSON string using bash substitutions only — no sed/awk required
# (those tools may also be absent from PATH). Backslashes first, then quotes.
ESCAPED="${CONTEXT//\\/\\\\}"
ESCAPED="${ESCAPED//\"/\\\"}"

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ESCAPED"
