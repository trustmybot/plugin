#!/usr/bin/env bash
# Deferred-tools registry drift warning (#98).
#
# Fires on SessionStart. Detects when on-disk MCP tool sources are newer
# than the running trajectory-server child process. When drift is found,
# emits additionalContext with a Tier 2 restart recommendation.
#
# CC's deferred-tools registry is session-scoped: /reload-plugins does NOT
# refresh it for newly-registered MCP tools (upstream CC behavior). This
# hook provides structural, plugin-side visibility into that drift.
#
# Silent no-op when:
#   - pgrep is not available (and no TMB_MCP_PID_OVERRIDE)
#   - No trajectory-server child is running
#   - dist/tools/ directory does not exist
#   - No tool source files are newer than the running child
#   - ps start-time parse fails (defensive — avoid false alarms)
#
# Test overrides (env vars):
#   TMB_MCP_PID_OVERRIDE   — inject a known PID (skips pgrep)
#   TMB_MCP_START_OVERRIDE — inject epoch seconds for child start-time (skips ps)
#   TMB_TOOL_DIR_OVERRIDE  — inject alternate dist/tools path (skips PLUGIN_ROOT)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -n "${TMB_MCP_PID_OVERRIDE:-}" ]; then
  MCP_PID="$TMB_MCP_PID_OVERRIDE"
else
  command -v pgrep >/dev/null 2>&1 || exit 0
  MCP_PID=$(pgrep -f 'trajectory-server/dist/index.js' 2>/dev/null | head -1 || true)
  [ -n "$MCP_PID" ] || exit 0
fi

TOOL_DIR="${TMB_TOOL_DIR_OVERRIDE:-$PLUGIN_ROOT/mcp/trajectory-server/dist/tools}"
[ -d "$TOOL_DIR" ] || exit 0

if [ -n "${TMB_MCP_START_OVERRIDE:-}" ]; then
  MCP_START="$TMB_MCP_START_OVERRIDE"
else
  # Compute MCP_START (epoch seconds) portably (#371):
  #   Linux: ps -o etimes= gives elapsed seconds directly.
  #   macOS: etimes unsupported — use ps -o etime= (DD-HH:MM:SS / HH:MM:SS / MM:SS)
  #   and convert to seconds, then compute start = now - elapsed.
  NOW_EPOCH=$(date +%s 2>/dev/null || true)
  [ -n "$NOW_EPOCH" ] || exit 0

  MCP_ETIMES=$(ps -o etimes= -p "$MCP_PID" 2>/dev/null | tr -d ' ' || true)
  if [ -n "$MCP_ETIMES" ] && echo "$MCP_ETIMES" | grep -qE '^[0-9]+$'; then
    MCP_START=$(( NOW_EPOCH - MCP_ETIMES ))
  else
    # macOS fallback: parse ps -o etime= output (DD-HH:MM:SS, HH:MM:SS, or MM:SS)
    MCP_ETIME_RAW=$(ps -o etime= -p "$MCP_PID" 2>/dev/null | tr -d ' ' || true)
    [ -n "$MCP_ETIME_RAW" ] || exit 0
    # Convert to elapsed seconds
    MCP_ETIMES_CALC=0
    case "$MCP_ETIME_RAW" in
      *-*)
        # DD-HH:MM:SS
        _days="${MCP_ETIME_RAW%%-*}"
        _rest="${MCP_ETIME_RAW#*-}"
        ;;
      *)
        _days=0
        _rest="$MCP_ETIME_RAW"
        ;;
    esac
    _hms_count=$(echo "$_rest" | tr -cd ':' | wc -c | tr -d ' ')
    if [ "$_hms_count" -eq 2 ]; then
      # HH:MM:SS
      _h="${_rest%%:*}"; _rest2="${_rest#*:}"; _m="${_rest2%%:*}"; _s="${_rest2#*:}"
      MCP_ETIMES_CALC=$(( _days * 86400 + _h * 3600 + _m * 60 + _s ))
    else
      # MM:SS
      _m="${_rest%%:*}"; _s="${_rest#*:}"
      MCP_ETIMES_CALC=$(( _days * 86400 + _m * 60 + _s ))
    fi
    [ "$MCP_ETIMES_CALC" -ge 0 ] 2>/dev/null || exit 0
    MCP_START=$(( NOW_EPOCH - MCP_ETIMES_CALC ))
  fi
  [ "$MCP_START" -gt 0 ] 2>/dev/null || exit 0
fi

# Create a reference file stamped at the MCP child's start time.
# Using -newer REFFILE instead of -newermt @EPOCH for compatibility with
# both GNU find and bfs (which Claude Code substitutes for find).
REF_FILE=$(mktemp 2>/dev/null) || exit 0
# Cross-platform: GNU date -d '@EPOCH' first, BSD date -j -r EPOCH fallback.
REF_DATE=$(date -d "@$MCP_START" '+%Y%m%d%H%M.%S' 2>/dev/null || \
           date -j -r "$MCP_START" '+%Y%m%d%H%M.%S' 2>/dev/null || echo "")
if [ -z "$REF_DATE" ]; then
  rm -f "$REF_FILE"
  exit 0
fi
touch -t "$REF_DATE" "$REF_FILE" 2>/dev/null || { rm -f "$REF_FILE"; exit 0; }

NEWER_TOOLS=$(find "$TOOL_DIR" -name '*.js' -newer "$REF_FILE" 2>/dev/null || true)
rm -f "$REF_FILE"

[ -n "$NEWER_TOOLS" ] || exit 0

count=$(printf '%s\n' "$NEWER_TOOLS" | grep -c . || true)

CONTEXT="[tmb deferred-tools drift] ${count} MCP tool source file(s) on disk are newer than the running trajectory-server child (PID ${MCP_PID}). /reload-plugins is INSUFFICIENT — CC's deferred-tools registry is session-scoped and will not replay tool discovery. Workaround (Tier 2): pkill -f 'trajectory-server/dist/index.js' then quit and relaunch CC to bind the new tools. See #98."

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
