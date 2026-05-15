#!/usr/bin/env bash
# Interactive remediation for the CC plugin MCP-config cache bug (issue #2888).
#
# Two independent recovery steps:
#   Step A — clear per-project `disabledMcpServers["plugin:tmb:trajectory-server"]`
#            entries from ~/.claude.json. CC writes this flag when a user
#            disables an MCP server through CC's UI; it persists across plugin
#            re-enable, plugin updates, full CC restarts, and rm -rf .claude/.
#            The plugin cannot read or write this — CC-owned state.
#   Step B — nuke ~/.claude/plugins/cache/trustmybot-rc/ + remove tmb entries
#            from installed_plugins.json. The Mode A recovery doctrine for
#            CC's plugin-cache bug.
#
# Each step has its own y/N prompt. Step A is the lighter, more common fix
# and defaults to y; Step B is more aggressive and defaults to N.
# Idempotent: re-runs see nothing to do and exit 0.
# Run from a terminal, NOT from inside Claude Code.

set -euo pipefail

CACHE_DIR="${HOME}/.claude/plugins/cache/trustmybot-rc"
INSTALLED_JSON="${HOME}/.claude/plugins/installed_plugins.json"
CC_CONFIG="${HOME}/.claude.json"
PLUGIN_NAME="tmb@trustmybot-rc"
MCP_SERVER_KEY="plugin:tmb:trajectory-server"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  printf '⚠️  This script appears to be running INSIDE Claude Code.\n' >&2
  printf '    It will mutate ~/.claude.json (which CC reads on every prompt)\n' >&2
  printf '    and the plugins cache. Quit CC first (⌘Q), then re-run from a\n' >&2
  printf '    regular terminal.\n' >&2
  printf '    Continuing anyway in 3s — Ctrl-C to abort.\n' >&2
  sleep 3
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'Error: jq is required but not on PATH.\n' >&2
  exit 1
fi

printf '=== TMB MCP-cache heal — issue #2888 ===\n\n'

# ============================================================================
# Step A — clear disabledMcpServers entries in ~/.claude.json
# ============================================================================

printf '%s\n\n' '--- Step A: per-project disabledMcpServers flags in ~/.claude.json ---'

disabled_projects=()
if [ ! -f "$CC_CONFIG" ]; then
  printf '  %s not found — skipping Step A.\n\n' "$CC_CONFIG"
else
  has_projects=$(jq -r 'if has("projects") then "yes" else "no" end' "$CC_CONFIG" 2>/dev/null || echo "no")
  if [ "$has_projects" != "yes" ]; then
    printf '  No .projects key in %s — skipping Step A.\n\n' "$CC_CONFIG"
  else
    while IFS= read -r project; do
      [ -n "$project" ] && disabled_projects+=("$project")
    done < <(jq -r --arg key "$MCP_SERVER_KEY" '
      .projects
      | to_entries
      | map(select(
          (.value.disabledMcpServers // [])
          | type == "array"
          and (index($key) != null)
        ))
      | .[].key
    ' "$CC_CONFIG" 2>/dev/null || true)

    if [ "${#disabled_projects[@]}" -eq 0 ]; then
      printf '  No projects have %s in disabledMcpServers.\n' "$MCP_SERVER_KEY"
      printf '  No disabled-MCP flags to clear; skipping.\n\n'
    else
      printf '  Projects with trajectory-server disabled:\n'
      for p in "${disabled_projects[@]}"; do
        printf '    %s\n' "$p"
      done
      printf '\n  Would: for each above, remove "%s" from .projects."<path>".disabledMcpServers\n' "$MCP_SERVER_KEY"
      printf '         (preserves every other disabled server + other keys).\n\n'
      printf '  Proceed with Step A? (Y/n) '
      read -r answer_a
      case "$answer_a" in
        n|N|no|NO)
          printf '  Skipped Step A.\n\n'
          ;;
        *)
          ts=$(date -u +%Y%m%dT%H%M%SZ)
          backup="${CC_CONFIG}.bak.${ts}"
          cp -p "$CC_CONFIG" "$backup"
          printf '  Backup: %s\n' "$backup"
          for p in "${disabled_projects[@]}"; do
            tmp="${CC_CONFIG}.tmp.$$"
            jq --arg path "$p" --arg key "$MCP_SERVER_KEY" '
              .projects[$path].disabledMcpServers =
                ((.projects[$path].disabledMcpServers // []) | map(select(. != $key)))
            ' "$CC_CONFIG" > "$tmp"
            mv -f "$tmp" "$CC_CONFIG"
            printf '  Cleaned: %s\n' "$p"
          done
          printf '\n'
          ;;
      esac
    fi
  fi
fi

# ============================================================================
# Step B — plugin cache + installed_plugins.json
# ============================================================================

printf '%s\n\n' '--- Step B: plugin cache + installed_plugins.json ---'

cache_exists="no"
[ -d "$CACHE_DIR" ] && cache_exists="yes"

manifest_exists="no"
matching_count=0
total_count=0
if [ -f "$INSTALLED_JSON" ]; then
  manifest_exists="yes"
  total_count=$(jq -r '. | length' "$INSTALLED_JSON" 2>/dev/null || echo 0)
  matching_count=$(jq --arg name "$PLUGIN_NAME" '[.[] | select(.name == $name or .id == $name)] | length' "$INSTALLED_JSON" 2>/dev/null || echo 0)
fi

printf 'Discovered state:\n'
printf '  cache dir:           %s (%s)\n' "$CACHE_DIR" "$cache_exists"
if [ "$manifest_exists" = "yes" ]; then
  printf '  installed_plugins:   %s\n' "$INSTALLED_JSON"
  printf '  total entries:       %s\n' "$total_count"
  printf '  matching "%s": %s\n' "$PLUGIN_NAME" "$matching_count"
else
  printf '  installed_plugins:   %s (missing)\n' "$INSTALLED_JSON"
fi

if [ "$cache_exists" = "yes" ]; then
  printf '\nCache subdirectories under %s:\n' "$CACHE_DIR"
  for sub in "$CACHE_DIR"/*/; do
    [ -d "$sub" ] || continue
    name="$(basename "$sub")"
    versions=()
    for v in "$sub"*/; do
      [ -d "$v" ] || continue
      versions+=("$(basename "$v")")
    done
    if [ "${#versions[@]}" -gt 0 ]; then
      printf '  %s: %s\n' "$name" "${versions[*]}"
    else
      printf '  %s: (empty)\n' "$name"
    fi
  done
fi

if command -v pgrep >/dev/null 2>&1; then
  pgrep_count=$({ pgrep -f 'trajectory-server/dist/index.js' 2>/dev/null || true; } | wc -l | tr -d ' ')
  [ -z "$pgrep_count" ] && pgrep_count=0
  printf '\ntrajectory-server processes: %s\n' "$pgrep_count"
else
  printf '\ntrajectory-server processes: unknown (pgrep missing)\n'
fi

if [ "$cache_exists" = "no" ] && [ "$matching_count" -eq 0 ]; then
  printf '\n  Nothing to nuke — cache dir already gone and no %s entry in installed_plugins.json.\n' "$PLUGIN_NAME"
  printf '  Skipping Step B.\n\n'
  printf 'Done. To reinstall:\n'
  printf '  1. Launch Claude Code.\n'
  printf '  2. /plugin install %s\n' "$PLUGIN_NAME"
  printf '  3. Verify with: tail -1 ~/.claude/tmb/logs/mcp-health.log\n'
  printf '     (expect mcp_alive:true and mode:null)\n'
  exit 0
fi

printf '\nDry-run — would remove:\n'
if [ "$cache_exists" = "yes" ]; then
  printf '  rm -rf %s\n' "$CACHE_DIR"
fi
if [ "$matching_count" -gt 0 ]; then
  printf '  jq "del(.[] | select(.name == \"%s\" or .id == \"%s\"))" %s   (%s entries)\n' \
    "$PLUGIN_NAME" "$PLUGIN_NAME" "$INSTALLED_JSON" "$matching_count"
fi

printf '\nProceed with Step B (cache nuke)? (y/N) '
read -r answer_b
case "$answer_b" in
  y|Y|yes|YES)
    ;;
  *)
    printf '\nSkipped Step B. Manual recovery options:\n'
    printf '  1. claude --plugin-dir <plugin-source-path>   (cache-bust via inline)\n'
    printf '  2. Inside CC: /plugin uninstall %s, quit, reinstall\n' "$PLUGIN_NAME"
    printf '  3. Re-run this script and answer y to Step B.\n'
    exit 0
    ;;
esac

if [ "$cache_exists" = "yes" ]; then
  rm -rf "$CACHE_DIR"
  printf 'Removed %s\n' "$CACHE_DIR"
fi

if [ "$matching_count" -gt 0 ]; then
  tmp="${INSTALLED_JSON}.tmp.$$"
  jq --arg name "$PLUGIN_NAME" 'del(.[] | select(.name == $name or .id == $name))' \
    "$INSTALLED_JSON" > "$tmp"
  mv -f "$tmp" "$INSTALLED_JSON"
  printf 'Removed %s entries from %s\n' "$matching_count" "$INSTALLED_JSON"
fi

printf '\nDone. To reinstall:\n'
printf '  1. Launch Claude Code.\n'
printf '  2. /plugin install %s\n' "$PLUGIN_NAME"
printf '  3. Verify with: tail -1 ~/.claude/tmb/logs/mcp-health.log\n'
printf '     (expect mcp_alive:true and mode:null)\n'
