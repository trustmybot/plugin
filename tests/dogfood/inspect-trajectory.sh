#!/usr/bin/env bash
# Inspect a debug_trajectory dump in the format L6 expects.
#
# Use this when authoring an expected-trajectory file for a new flow:
#   1. Run the flow once with TMB_DEBUG_TRAJECTORY=1
#   2. Run this script against the resulting DB
#   3. Copy the output to tests/dogfood/expected/<flow>.txt
#
# Usage:
#   bash tests/dogfood/inspect-trajectory.sh <project-dir>
#   bash tests/dogfood/inspect-trajectory.sh /tmp/tmb-l6-XXXX
#   bash tests/dogfood/inspect-trajectory.sh                  # uses $PWD

set -uo pipefail

PROJECT="${1:-$PWD}"
DB_PATH="$PROJECT/.claude/tmb/trajectory.db"

if [ ! -f "$DB_PATH" ]; then
  # Fall back to channel-isolated path
  for candidate in "$PROJECT/.claude/tmb-rc/trajectory.db" "$PROJECT/.claude"/*/trajectory.db; do
    [ -f "$candidate" ] && DB_PATH="$candidate" && break
  done
fi

if [ ! -f "$DB_PATH" ]; then
  echo "❌ no trajectory.db found under $PROJECT/.claude/" >&2
  exit 1
fi

ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM debug_trajectory" 2>/dev/null || echo 0)

if [ "$ROW_COUNT" = "0" ]; then
  echo "⊘ no debug_trajectory rows recorded." >&2
  echo "   Was TMB_DEBUG_TRAJECTORY=1 set when claude ran?" >&2
  exit 1
fi

echo "# Trajectory from $DB_PATH ($ROW_COUNT rows)"
echo "# Copy lines below into tests/dogfood/expected/<flow>.txt"
echo "# (Edit out any setup/teardown calls that aren't part of the flow under test.)"
echo

sqlite3 "$DB_PATH" \
  "SELECT kind || ':' || tool_or_mcp_name FROM debug_trajectory ORDER BY id"
