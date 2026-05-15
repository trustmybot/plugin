#!/usr/bin/env bash
# Interactive remediation for the CC plugin MCP-config cache bug (issue #2888).
#
# Mode A symptom: /plugin disable + re-enable (or auto-update) leaves the tmb
# MCP server missing from CC's resolved-plugin list. /reload-plugins and full
# CC quit + relaunch don't recover; CC persists the broken cache to disk.
#
# This script does a dry-run preview, then on confirmation:
#   1. rm -rf ~/.claude/plugins/cache/trustmybot-rc/
#   2. Removes the tmb@trustmybot-rc entry from installed_plugins.json
#      (preserves every other plugin).
#
# Idempotent: a second run sees nothing to remove and exits 0.
# Run from a terminal, NOT from inside Claude Code.

set -euo pipefail

CACHE_DIR="${HOME}/.claude/plugins/cache/trustmybot-rc"
INSTALLED_JSON="${HOME}/.claude/plugins/installed_plugins.json"
PLUGIN_NAME="tmb@trustmybot-rc"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  printf '⚠️  This script appears to be running INSIDE Claude Code.\n' >&2
  printf '    Quit CC first (⌘Q), then re-run from a regular terminal.\n' >&2
  printf '    Continuing anyway in 3s — Ctrl-C to abort.\n' >&2
  sleep 3
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'Error: jq is required but not on PATH.\n' >&2
  exit 1
fi

printf '=== TMB MCP-cache heal — issue #2888 ===\n\n'

# --- Discover ---------------------------------------------------------------
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

# Inspect tmb installs under the cache, if any
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

# Trajectory-server process state
if command -v pgrep >/dev/null 2>&1; then
  pgrep_count=$({ pgrep -f 'trajectory-server/dist/index.js' 2>/dev/null || true; } | wc -l | tr -d ' ')
  [ -z "$pgrep_count" ] && pgrep_count=0
  printf '\ntrajectory-server processes: %s\n' "$pgrep_count"
else
  printf '\ntrajectory-server processes: unknown (pgrep missing)\n'
fi

# --- Anything to do? --------------------------------------------------------
if [ "$cache_exists" = "no" ] && [ "$matching_count" -eq 0 ]; then
  printf '\nNothing to heal — cache dir already gone and no %s entry in installed_plugins.json.\n' "$PLUGIN_NAME"
  printf 'Run /plugin install %s inside Claude Code if you want to reinstall.\n' "$PLUGIN_NAME"
  exit 0
fi

# --- Dry-run preview --------------------------------------------------------
printf '\nDry-run — would remove:\n'
if [ "$cache_exists" = "yes" ]; then
  printf '  rm -rf %s\n' "$CACHE_DIR"
fi
if [ "$matching_count" -gt 0 ]; then
  printf '  jq "del(.[] | select(.name == \"%s\" or .id == \"%s\"))" %s   (%s entries)\n' \
    "$PLUGIN_NAME" "$PLUGIN_NAME" "$INSTALLED_JSON" "$matching_count"
fi

# --- Confirm ----------------------------------------------------------------
printf '\nProceed with cache nuke? (y/N) '
read -r answer
case "$answer" in
  y|Y|yes|YES)
    ;;
  *)
    printf '\nAborted. Manual recovery steps if you change your mind:\n'
    printf '  1. claude --plugin-dir <plugin-source-path>   (cache-bust via inline)\n'
    printf '  2. Inside CC: /plugin uninstall %s, quit, reinstall\n' "$PLUGIN_NAME"
    printf '  3. Re-run this script with "y" to do option 2 by hand.\n'
    exit 0
    ;;
esac

# --- Execute ----------------------------------------------------------------
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
