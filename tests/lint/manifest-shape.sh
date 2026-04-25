#!/usr/bin/env bash
# Lint: validate the shape of the plugin's three manifest files.
#
# Catches: typos, missing required fields, structural drift on any of:
#   .claude-plugin/plugin.json
#   .mcp.json
#   hooks/hooks.json

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

failed=0
fail() { echo "  ✗ $1" >&2; failed=1; }
pass() { echo "  ✓ $1"; }

# --- .claude-plugin/plugin.json -------------------------------------------

PLUGIN_MANIFEST=.claude-plugin/plugin.json
echo "Validating $PLUGIN_MANIFEST"

if ! jq -e . "$PLUGIN_MANIFEST" >/dev/null 2>&1; then
  fail "$PLUGIN_MANIFEST is not valid JSON"
else
  for field in name version description author license repository; do
    val=$(jq -r --arg f "$field" '.[$f] // empty' "$PLUGIN_MANIFEST")
    if [ -z "$val" ]; then
      fail "$PLUGIN_MANIFEST missing required field: $field"
    fi
  done
  # version must be semver-like
  ver=$(jq -r '.version' "$PLUGIN_MANIFEST")
  if ! [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "$PLUGIN_MANIFEST .version '$ver' is not a valid semver (X.Y.Z)"
  fi
  pass "$PLUGIN_MANIFEST has all required fields and a valid semver"
fi

# --- .mcp.json -----------------------------------------------------------

MCP_MANIFEST=.mcp.json
echo ""
echo "Validating $MCP_MANIFEST"

if ! jq -e . "$MCP_MANIFEST" >/dev/null 2>&1; then
  fail "$MCP_MANIFEST is not valid JSON"
else
  if ! jq -e '.mcpServers' "$MCP_MANIFEST" >/dev/null 2>&1; then
    fail "$MCP_MANIFEST missing .mcpServers"
  else
    server_count=$(jq -r '.mcpServers | length' "$MCP_MANIFEST")
    if [ "$server_count" -lt 1 ]; then
      fail "$MCP_MANIFEST .mcpServers is empty"
    fi
    # Every server must have command + args
    while IFS= read -r server; do
      cmd=$(jq -r --arg s "$server" '.mcpServers[$s].command // empty' "$MCP_MANIFEST")
      args=$(jq -r --arg s "$server" '.mcpServers[$s].args // empty' "$MCP_MANIFEST")
      if [ -z "$cmd" ]; then
        fail "$MCP_MANIFEST .mcpServers.$server.command is missing"
      fi
      if [ "$args" = "empty" ] || [ -z "$args" ]; then
        fail "$MCP_MANIFEST .mcpServers.$server.args is missing"
      fi
    done < <(jq -r '.mcpServers | keys[]' "$MCP_MANIFEST")
    pass "$MCP_MANIFEST has $server_count MCP server(s), all with command + args"
  fi
fi

# --- hooks/hooks.json ----------------------------------------------------

HOOKS_MANIFEST=hooks/hooks.json
echo ""
echo "Validating $HOOKS_MANIFEST"

if [ ! -f "$HOOKS_MANIFEST" ]; then
  fail "$HOOKS_MANIFEST does not exist"
elif ! jq -e . "$HOOKS_MANIFEST" >/dev/null 2>&1; then
  fail "$HOOKS_MANIFEST is not valid JSON"
else
  if ! jq -e '.hooks' "$HOOKS_MANIFEST" >/dev/null 2>&1; then
    fail "$HOOKS_MANIFEST missing .hooks"
  else
    # Walk every hook and verify referenced script paths exist
    missing=0
    while IFS= read -r script; do
      # Strip ${CLAUDE_PLUGIN_ROOT} prefix for local resolution
      local_path="${script//\$\{CLAUDE_PLUGIN_ROOT\}/.}"
      local_path="${local_path//\$CLAUDE_PLUGIN_ROOT/.}"
      if [ ! -f "$local_path" ]; then
        fail "$HOOKS_MANIFEST references missing script: $script (resolved: $local_path)"
        missing=1
      fi
    done < <(jq -r '.. | objects | .command? // empty | select(. | type == "string")' "$HOOKS_MANIFEST")
    if [ $missing -eq 0 ]; then
      pass "$HOOKS_MANIFEST is valid + all referenced scripts exist"
    fi
  fi
fi

echo ""
if [ $failed -ne 0 ]; then
  echo "Manifest shape: FAIL" >&2
  exit 1
fi
echo "Manifest shape: PASS"
