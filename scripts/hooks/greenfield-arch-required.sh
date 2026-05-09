#!/usr/bin/env bash
# PreToolUse hook on the trajectory-server task_create_batch tool. Blocks
# the call when:
#
#   1. The repo has no `docs/trustmybot/` AND no `docs/architecture/` dir
#      (greenfield project), AND
#   2. The audit log has no prior `architecture_regen` event.
#
# Greenfield projects need an initial architecture pass before tasks land
# — otherwise SWE has no architectural ground truth to verify against.
#
# Bypass: TMB_ALLOW_GREENFIELD_TASK=1 (used by L5 dogfood scenarios that
# intentionally exercise the bootstrap path).

set -uo pipefail

INPUT=$(cat)

if [ "${TMB_ALLOW_GREENFIELD_TASK:-0}" = "1" ]; then exit 0; fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  *task_create_batch) ;;
  *) exit 0 ;;
esac

# Locate the trajectory DB. If it doesn't exist, the call would fail
# anyway — let the server return its own error.
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

# Greenfield = neither architecture dir exists.
if [ -d docs/trustmybot ] || [ -d docs/architecture ]; then
  exit 0
fi

# Check audit log for any prior architecture_regen event.
PRIOR=$(sqlite3 "$DB_PATH" \
  "SELECT id FROM audit WHERE event_type='architecture_regen' LIMIT 1;" \
  2>/dev/null || true)
[ -n "$PRIOR" ] && exit 0

REASON="BLOCKED: greenfield project (no docs/trustmybot/ or docs/architecture/) needs an architecture bootstrap before task_create_batch. Run \`architecture_regen(scope='full', agent='bro')\` first to populate docs/trustmybot/architecture/auto/ — that gives SWE the design ground truth to verify against. Bypass with TMB_ALLOW_GREENFIELD_TASK=1 if you intend to land tasks pre-bootstrap."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
