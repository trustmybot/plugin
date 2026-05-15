#!/usr/bin/env bash
# MCP trajectory-server health check (GL #22 + #25 + #2888 mitigation).
#
# Fires on SessionStart + UserPromptSubmit.
#
# Purpose:
#   1. Detects whether the trajectory-server MCP process is alive and emits
#      an additionalContext warning when it is absent. Distinguishes:
#        Mode A — MCP never spawned this session (CC's plugin MCP-config
#                 cache wasn't invalidated; /reload-plugins + full quit do
#                 NOT recover; see issue #2888). Strong halt directive.
#        Mode B — MCP died mid-session (was alive earlier; existing kill
#                 zombies + relaunch doctrine).
#   2. Writes a forensic JSONL line on EVERY fire to:
#        ${HOME}/.claude/tmb/logs/mcp-health.log
#      so last-hook-fire evidence survives a Claude Code host crash (GL #25).
#
# Cross-fire state: ${HOME}/.claude/tmb/logs/mcp-health.state (JSON, single
# object) tracks `last_session_id` + `last_alive_at_session_start`. SessionStart
# resets it; UserPromptSubmit reads it to classify Mode A vs B.
#
# Detection: pgrep -f 'trajectory-server/dist/index.js' | wc -l
#
# Behavior matrix:
#   pgrep missing  → JSONL written (mcp_alive:null, mode:null), silent exit 0
#   pgrep_count>0  → JSONL written (mcp_alive:true,  mode:null), silent exit 0
#   pgrep_count=0  → JSONL written (mcp_alive:false, mode:"A"|"B"),
#                    additionalContext warning per mode, exit 0

set -euo pipefail

LOG_DIR="${HOME}/.claude/tmb/logs"
LOG_FILE="${LOG_DIR}/mcp-health.log"
STATE_FILE="${LOG_DIR}/mcp-health.state"
mkdir -p "$LOG_DIR" 2>/dev/null || true

db_path="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/tmb/trajectory.db"

INPUT=$(cat)
event=$(echo "$INPUT" | jq -r '.hookEventName // .event // "unknown"' 2>/dev/null || true)
[ -n "$event" ] || event="unknown"

session_id=$(echo "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)
[ -n "$session_id" ] || session_id="${CLAUDE_SESSION_ID:-unknown}"

if command -v pgrep >/dev/null 2>&1; then
  pgrep_count=$({ pgrep -f 'trajectory-server/dist/index.js' 2>/dev/null || true; } | wc -l | tr -d ' ')
  [ -z "$pgrep_count" ] && pgrep_count=0
else
  pgrep_count=-1
fi

if [ "$pgrep_count" -eq -1 ]; then
  mcp_alive_json="null"
elif [ "$pgrep_count" -gt 0 ]; then
  mcp_alive_json="true"
else
  mcp_alive_json="false"
fi

# --- Mode classification -----------------------------------------------------
# SessionStart with mcp_alive=false  → Mode A (and write state so subsequent
#                                       UserPromptSubmit fires in this session
#                                       keep classifying as A).
# SessionStart with mcp_alive=true   → reset state to alive.
# UserPromptSubmit with mcp_alive=false:
#   - read state; if same session_id AND last_alive_at_session_start=false → A
#   - else → B
mode_json="null"
if [ "$mcp_alive_json" = "false" ]; then
  if [ "$event" = "SessionStart" ]; then
    mode_json='"A"'
  else
    if [ -f "$STATE_FILE" ]; then
      # `// empty` would treat false as falsy and fall through — read raw and
      # default to a sentinel string only when the field is null or missing.
      last_sid=$(jq -r 'if has("last_session_id") then .last_session_id else "" end' "$STATE_FILE" 2>/dev/null || true)
      last_alive_ss=$(jq -r 'if has("last_alive_at_session_start") then .last_alive_at_session_start else "missing" end' "$STATE_FILE" 2>/dev/null || true)
      if [ "$last_sid" = "$session_id" ] && [ "$last_alive_ss" = "false" ]; then
        mode_json='"A"'
      else
        mode_json='"B"'
      fi
    else
      mode_json='"B"'
    fi
  fi
fi

# --- Update state on SessionStart -------------------------------------------
if [ "$event" = "SessionStart" ] && [ "$mcp_alive_json" != "null" ]; then
  alive_ss="false"
  [ "$mcp_alive_json" = "true" ] && alive_ss="true"
  tmp_state="${STATE_FILE}.tmp.$$"
  if jq -nc --arg sid "$session_id" --argjson alive "$alive_ss" \
      '{last_session_id: $sid, last_alive_at_session_start: $alive}' \
      > "$tmp_state" 2>/dev/null; then
    mv -f "$tmp_state" "$STATE_FILE" 2>/dev/null || rm -f "$tmp_state"
  else
    rm -f "$tmp_state" 2>/dev/null || true
  fi
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{"ts":"%s","event":"%s","mcp_alive":%s,"pgrep_count":%s,"mode":%s,"session_id":"%s","db_path":"%s"}\n' \
  "$ts" "$event" "$mcp_alive_json" "$pgrep_count" "$mode_json" "$session_id" "$db_path" \
  >> "$LOG_FILE" || true

if [ "$pgrep_count" -eq -1 ]; then
  exit 0
fi

if [ "$mcp_alive_json" = "true" ]; then
  exit 0
fi

# --- Resolve plugin source path (best-effort) -------------------------------
plugin_source="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$plugin_source" ]; then
  script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
  if [ -n "$script_dir" ]; then
    candidate="$(cd "$script_dir/../.." 2>/dev/null && pwd || true)"
    if [ -n "$candidate" ] && [ -f "$candidate/.claude-plugin/plugin.json" ]; then
      plugin_source="$candidate"
    fi
  fi
fi
[ -n "$plugin_source" ] || plugin_source="<plugin-source-path>"

# --- Emit additionalContext per mode ----------------------------------------
if [ "$mode_json" = '"A"' ]; then
  CONTEXT="🚨 MCP trajectory-server NEVER STARTED this Claude Code session.

This is the CC plugin MCP-config cache bug (issue #2888):
  - /plugin disable + re-enable or auto-update sometimes leaves the
    MCP config out of CC's resolved-plugin list.
  - /reload-plugins does NOT fix this. Full quit + relaunch does NOT
    fix this either.
  - The DB at ${db_path} is INTACT. Nothing has been lost.

To recover, try IN ORDER (stop at the first one that brings MCP back):

  1. claude --plugin-dir ${plugin_source}      (cache-bust via inline)
  2. /plugin uninstall tmb@trustmybot-rc            (then relaunch, reinstall)
  3. rm -rf ~/.claude/plugins/cache/trustmybot-rc   (then reinstall)

Full recovery doctrine: skills/tmb_recovery/SKILL.md § C.

⛔ Bro: HALT. Do not dispatch real work. State-writing tools are unreachable.
   Read-only sqlite3 fallback (bro-sqlite-readonly.sh) remains available
   for emergency reads."
else
  CONTEXT="⚠️ MCP trajectory-server is no longer reachable (was alive earlier this session).

This is a mid-session disconnect — typically:
  - The MCP server process crashed or was killed
  - The DB at ${db_path} may still be intact

Recovery:
  1. pkill -f 'node.*trajectory-server'   (clean zombies)
  2. Quit Claude Code fully (⌘Q) and relaunch.
  3. If MCP doesn't come back after relaunch → it's now Mode A (CC cache bug);
     see skills/tmb_recovery/SKILL.md § C.

⚠️ Bro: pause any task that requires durable state-writing tools until MCP returns."
fi

jq -nc --arg ctx "$CONTEXT" --arg ev "$event" '{
  hookSpecificOutput: {
    hookEventName: $ev,
    additionalContext: $ctx
  }
}'
