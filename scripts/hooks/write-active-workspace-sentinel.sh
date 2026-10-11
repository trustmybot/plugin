#!/usr/bin/env bash
# SessionStart hook for #113. Writes the workspace path to a well-known
# sentinel file so subagents (which inherit cwd=~ and lack env vars) can
# discover the workspace DB.
#
# This hook resolves the DB with the one DB-path rule minus its sentinel step
# (tmb_db_path_local) — never via the sentinel itself. Reading the sentinel
# here would be circular: a stale sentinel from a prior session would re-write itself, and a fresh
# session in a different workspace would never get its sentinel updated
# (which was the L5 failure mode where flows in scratch dirs
# kept seeing the developer's main-workspace DB).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/resolve-plugin-name.sh
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

PLUGIN_NAME=$(tmb_resolve_plugin_name)
DB_PATH=$(tmb_db_path_local) || exit 0
[ -z "$DB_PATH" ] && exit 0

# Schema-mismatch guard: never adopt a stale legacy DB (no prompt_bearing
# column). A sentinel pointing at a legacy ~/.claude/<plugin> DB is exactly
# what silently denied prompt_bearing=1 edits. Require the current schema.
tmb_db_schema_current "$DB_PATH" || exit 0

# Workspace = dirname x 3 of the DB path (<ws>/<host-dir>/<plugin>/<db-file>).
WORKSPACE=$(dirname "$(dirname "$(dirname "$DB_PATH")")")

# Never record $HOME as the workspace. A DB resolved to $HOME/.claude/<plugin>
# is the legacy home DB; writing it would re-poison every subagent that reads
# the sentinel.
[ "$WORKSPACE" = "$HOME" ] && exit 0

SENTINEL_DIR="$HOME/.claude"
SENTINEL="$SENTINEL_DIR/${PLUGIN_NAME}-active-workspace"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || exit 0
printf '%s\n' "$WORKSPACE" > "$SENTINEL" 2>/dev/null || exit 0

exit 0
