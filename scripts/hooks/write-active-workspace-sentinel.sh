#!/usr/bin/env bash
# SessionStart hook for #113. Writes the workspace path to a well-known
# sentinel file so subagents (which inherit cwd=~ and lack env vars) can
# discover the workspace DB.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

DB_PATH=$(tmb_db_path 2>/dev/null) || true
[ -z "$DB_PATH" ] && exit 0

# Workspace = dirname x 3 of DB path: <ws>/.claude/<plugin>/trajectory.db -> <ws>/.claude/<plugin> -> <ws>/.claude -> <ws>
WORKSPACE=$(dirname "$(dirname "$(dirname "$DB_PATH")")")

SENTINEL_DIR="$HOME/.claude"
SENTINEL="$SENTINEL_DIR/tmb-active-workspace"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || exit 0
printf '%s\n' "$WORKSPACE" > "$SENTINEL" 2>/dev/null || exit 0

exit 0
