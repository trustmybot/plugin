#!/usr/bin/env bash
# PostToolUse hook on bro_atomic_close: re-run /scan to refresh the world
# model + file_registry against the post-close git state. scan_run walks
# each repo's README.md tree to refresh dir summaries; file-level md5 drift
# detection runs in the same pass.
#
# Backgrounds the rescan via `disown` so the hook returns immediately and
# bro's response isn't blocked. The rescan output goes to stderr (visible
# in CC's debug log; not user-facing).
#
# Triggers ONLY on:
#   - tool_name = mcp__plugin_<channel>_trajectory-server__bro_atomic_close
#
# Bypass: TMB_SKIP_AUTO_RESCAN=1 (when running scripted tests / smoke).

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  mcp__*trajectory-server__bro_atomic_close) ;;
  *) exit 0 ;;
esac

if [ "${TMB_SKIP_AUTO_RESCAN:-0}" = "1" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKER="$SCRIPT_DIR/../maintenance/run-scan.mjs"
[ -f "$INVOKER" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# Background + disown so bro's response isn't blocked. stderr ends up in
# CC's debug log via the inherited fd; >/dev/null on stdout so the hook's
# JSON-RPC channel stays clean.
node --experimental-sqlite "$INVOKER" >/dev/null 2>&1 &
disown
exit 0
