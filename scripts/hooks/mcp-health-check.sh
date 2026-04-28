#!/usr/bin/env bash
# MCP trajectory-server health check (GL #22 + #25 mitigation).
#
# Fires on SessionStart + UserPromptSubmit.
#
# Purpose:
#   1. Detects whether the trajectory-server MCP process is alive and emits
#      an additionalContext warning when it is absent (GL #22 — converts silent
#      disconnection into actionable visibility).
#   2. Writes a forensic JSONL line on EVERY fire to:
#        ${HOME}/.claude/tmb/logs/mcp-health.log
#      so last-hook-fire evidence survives a Claude Code host crash (GL #25).
#
# Detection: pgrep -f 'trajectory-server/dist/index.js' | wc -l
#
# Behavior matrix:
#   pgrep missing  → JSONL written (mcp_alive:null, pgrep_count:-1), silent exit 0
#   pgrep_count>0  → JSONL written (mcp_alive:true),  silent exit 0
#   pgrep_count=0  → JSONL written (mcp_alive:false),  additionalContext warning, exit 0

set -euo pipefail

mkdir -p "${HOME}/.claude/tmb/logs" 2>/dev/null || true

db_path="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/tmb/trajectory.db"

INPUT=$(cat)
event=$(echo "$INPUT" | jq -r '.hookEventName // .event // "unknown"' 2>/dev/null || true)
[ -n "$event" ] || event="unknown"

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

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{"ts":"%s","event":"%s","mcp_alive":%s,"pgrep_count":%s,"db_path":"%s"}\n' \
  "$ts" "$event" "$mcp_alive_json" "$pgrep_count" "$db_path" \
  >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

if [ "$pgrep_count" -eq -1 ]; then
  exit 0
fi

if [ "$mcp_alive_json" = "true" ]; then
  exit 0
fi

CONTEXT="⚠️ MCP trajectory-server appears disconnected. State at ${db_path} is intact. Recovery: kill any zombie 'node ... trajectory-server' processes, then quit + relaunch Claude Code. See docs/SELF_DEV.md for full procedure."

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
