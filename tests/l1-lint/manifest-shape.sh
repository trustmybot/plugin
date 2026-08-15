#!/usr/bin/env bash
# Lint: validate the shape of the Claude and Codex package manifests.
#
# Catches: typos, missing required fields, structural drift on any of:
#   .claude-plugin/plugin.json
#   .mcp.json
#   hooks/hooks.json
#   .codex-plugin/plugin.json
#   adapters/codex/.mcp.json
#   hooks/codex/hooks.json
#   .agents/plugins/marketplace.json

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
  # version must be semver-like: X.Y.Z or X.Y.Z-<pre> (rc.1, alpha.2, etc.)
  ver=$(jq -r '.version' "$PLUGIN_MANIFEST")
  if ! [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "$PLUGIN_MANIFEST .version '$ver' is not a valid semver (X.Y.Z or X.Y.Z-<pre>)"
  fi
  pass "$PLUGIN_MANIFEST has all required fields and a valid semver"
fi

# --- Codex package -------------------------------------------------------

CODEX_MANIFEST=.codex-plugin/plugin.json
CODEX_MCP=adapters/codex/.mcp.json
CODEX_HOOKS=hooks/codex/hooks.json
CODEX_SKILLS=adapters/codex/skills
MARKETPLACE=.agents/plugins/marketplace.json
echo ""
echo "Validating Codex package manifests"

for manifest in "$CODEX_MANIFEST" "$CODEX_MCP" "$CODEX_HOOKS" "$MARKETPLACE"; do
  if [ ! -f "$manifest" ]; then
    fail "$manifest does not exist"
  elif ! jq -e . "$manifest" >/dev/null 2>&1; then
    fail "$manifest is not valid JSON"
  fi
done

if jq -e . "$CODEX_MANIFEST" >/dev/null 2>&1; then
  if ! jq -e '
    .name == "tmb" and
    (.version | type == "string") and
    .mcpServers == "./adapters/codex/.mcp.json" and
    .hooks == "./hooks/codex/hooks.json" and
    .skills == "./adapters/codex/skills/" and
    (.interface.defaultPrompt | type == "array" and length > 0) and
    all(.interface.defaultPrompt[]; type == "string" and utf8bytelength <= 128)
  ' "$CODEX_MANIFEST" >/dev/null; then
    fail "$CODEX_MANIFEST has invalid identity, component paths, or defaultPrompt length"
  else
    pass "$CODEX_MANIFEST points only to Codex-specific MCP, hook, and Skill surfaces"
  fi
fi

if [ ! -f "$CODEX_SKILLS/tmb-bro/SKILL.md" ] ||
   [ ! -f "$CODEX_SKILLS/tmb-bro/agents/openai.yaml" ] ||
   [ ! -f "$CODEX_SKILLS/tmb-agent-setup/SKILL.md" ] ||
   [ ! -f "$CODEX_SKILLS/tmb-agent-setup/agents/openai.yaml" ]; then
  fail "$CODEX_SKILLS must contain the tmb-bro and tmb-agent-setup Skills with OpenAI metadata"
else
  skill_count=$(find "$CODEX_SKILLS" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  skill_names=$(find "$CODEX_SKILLS" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' ')
  if [ "$skill_count" -ne 2 ] || [ "$skill_names" != "tmb-agent-setup tmb-bro " ]; then
    fail "$CODEX_SKILLS must expose exactly tmb-bro and tmb-agent-setup"
  elif ! grep -q '^name: tmb-bro$' "$CODEX_SKILLS/tmb-bro/SKILL.md" ||
       ! grep -q '^  allow_implicit_invocation: false$' "$CODEX_SKILLS/tmb-bro/agents/openai.yaml" ||
       ! grep -q '^      value: "trajectory-server"$' "$CODEX_SKILLS/tmb-bro/agents/openai.yaml" ||
       ! grep -q '^name: tmb-agent-setup$' "$CODEX_SKILLS/tmb-agent-setup/SKILL.md" ||
       ! grep -q '^  allow_implicit_invocation: false$' "$CODEX_SKILLS/tmb-agent-setup/agents/openai.yaml" ||
       ! grep -q '^      value: "trajectory-server"$' "$CODEX_SKILLS/tmb-agent-setup/agents/openai.yaml" ||
       grep -R -q '\[TODO:' "$CODEX_SKILLS"; then
    fail "$CODEX_SKILLS metadata or explicit-invocation policy is invalid"
  else
    pass "$CODEX_SKILLS exposes exactly two explicit-only Skills with the bundled MCP dependency"
  fi
fi

if jq -e . "$CODEX_MCP" >/dev/null 2>&1; then
  codex_server_count=$(jq -r 'length' "$CODEX_MCP")
  codex_entry=$(jq -r '."trajectory-server".args[-1] // empty' "$CODEX_MCP")
  if [ "$codex_server_count" -ne 1 ] || [ "$codex_entry" != "mcp/trajectory-server/dist/codex.js" ]; then
    fail "$CODEX_MCP must expose exactly the isolated Codex trajectory server"
  else
    pass "$CODEX_MCP exposes exactly one isolated Codex server"
  fi
fi

if jq -e . "$CODEX_HOOKS" >/dev/null 2>&1; then
  if ! jq -e '.hooks == {}' "$CODEX_HOOKS" >/dev/null; then
    fail "$CODEX_HOOKS must remain empty in Codex Scope 4"
  else
    pass "$CODEX_HOOKS prevents Claude hooks from loading in Codex"
  fi
fi

if jq -e . "$MARKETPLACE" >/dev/null 2>&1; then
  if ! jq -e '
    (.plugins | length) == 1 and
    .plugins[0].name == "tmb" and
    .plugins[0].source.source == "local" and
    .plugins[0].source.path == "./"
  ' "$MARKETPLACE" >/dev/null; then
    fail "$MARKETPLACE must point its sole local entry at the repository root"
  else
    pass "$MARKETPLACE exposes the repository-root Codex package"
  fi
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
