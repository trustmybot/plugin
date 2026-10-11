#!/usr/bin/env bash
# SessionStart: record that the plugin's own hooks are loaded in this session.
#
# This hook is registered in hooks/hooks.json, so it runs only when the plugin
# hooks are active. It leaves a 0-byte marker
#   <project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks
# that the headless shim resolver (scripts/lib/resolve-hook.sh --shim) reads:
# with the marker the plugin's gates already run, so the shim yields; a
# headless `claude -p` run loads no plugin hooks, leaves no marker, and the
# shim enforces. Markers older than 24 h are pruned. Writes only inside the
# project; an un-onboarded project (no state dir) is left untouched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
case "$SESSION_ID" in
  ''|*/*|.*) exit 0 ;;
esac

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  STATE_DIR="$CLAUDE_PROJECT_DIR/$TMB_STATE_HOST_DIR/$(tmb_plugin_name)"
else
  STATE_DIR=$(tmb_state_dir) || exit 0
fi
[ -d "$STATE_DIR" ] || exit 0

SESSIONS_DIR="$STATE_DIR/sessions"
mkdir -p "$SESSIONS_DIR" 2>/dev/null || exit 0
find "$SESSIONS_DIR" -maxdepth 1 -type f -name '*.plugin-hooks' -mmin +1440 -delete 2>/dev/null || true
: > "$SESSIONS_DIR/$SESSION_ID.plugin-hooks" 2>/dev/null || true
exit 0
