#!/usr/bin/env bash
# Single source of truth for plugin-name resolution; sourced by hooks.
# Usage: source this file then call `tmb_resolve_plugin_name`.
tmb_resolve_plugin_name() {
  local manifest="${CLAUDE_PLUGIN_ROOT:-}/.claude-plugin/plugin.json"
  if [ -f "$manifest" ]; then
    jq -r '.name // "tmb"' "$manifest" 2>/dev/null || echo "tmb"
  else
    echo "tmb"
  fi
}
