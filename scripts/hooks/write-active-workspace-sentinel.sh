#!/usr/bin/env bash
# SessionStart hook for #113. Writes the workspace path to a well-known
# sentinel file so subagents (which inherit cwd=~ and lack env vars) can
# discover the workspace DB.
#
# This hook deliberately resolves the DB via cwd walk-up only — never via
# the sentinel itself. Reading the sentinel here would be circular: a
# stale sentinel from a prior session would re-write itself, and a fresh
# session in a different workspace would never get its sentinel updated
# (which was the L5 dogfood failure mode where flows in scratch dirs
# kept seeing the developer's main-workspace DB).

set -uo pipefail

resolve_plugin_name() {
  local plugin_name="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    plugin_name=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  echo "$plugin_name"
}

# Cwd walk-up DB resolution. Skips the sentinel-fallback step that the
# regular tmb_db_path helper uses, breaking the circular dependency.
resolve_db_cwd_only() {
  local plugin_name="$1"
  if [ -n "${TRAJECTORY_DB_PATH:-}" ] && [ -f "$TRAJECTORY_DB_PATH" ]; then
    echo "$TRAJECTORY_DB_PATH"
    return 0
  fi
  local candidates=()
  local dir
  dir="$(pwd)"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    local candidate="$dir/.claude/$plugin_name/trajectory.db"
    [ -f "$candidate" ] && candidates+=("$candidate")
    dir="$(dirname "$dir")"
  done
  if [ ${#candidates[@]} -gt 0 ]; then
    echo "${candidates[${#candidates[@]}-1]}"
    return 0
  fi
  return 1
}

PLUGIN_NAME=$(resolve_plugin_name)
DB_PATH=$(resolve_db_cwd_only "$PLUGIN_NAME") || exit 0
[ -z "$DB_PATH" ] && exit 0

# Workspace = dirname x 3 of DB path: <ws>/.claude/<plugin>/trajectory.db -> <ws>/.claude/<plugin> -> <ws>/.claude -> <ws>
WORKSPACE=$(dirname "$(dirname "$(dirname "$DB_PATH")")")

SENTINEL_DIR="$HOME/.claude"
SENTINEL="$SENTINEL_DIR/tmb-active-workspace"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || exit 0
printf '%s\n' "$WORKSPACE" > "$SENTINEL" 2>/dev/null || exit 0

exit 0
