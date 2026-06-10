#!/usr/bin/env bash
# Shared roundtable-panel seed for the 11-roundtable scenario.
#
# Used by BOTH suites so L5 and L6 convene the identical panel:
#   - L5: setup-l5.sh calls this to build the whole shape from scratch.
#   - L6: the step-11 chain_setup_command calls this to add the panel on top
#         of cumulative chain state (step 10 already created cto for real).
#
# Panel = cto (templated, mirrors step 10's /tmb:agent-create) + data-engineer
# (from-scratch consultant). Idempotent: cp overwrites, INSERT OR REPLACE.
set -uo pipefail

PROJECT="${1:?usage: seed-agents.sh <project_dir> [plugin_root]}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${2:-${PLUGIN_ROOT:-$(cd "$HERE/../../../.." && pwd)}}"

mkdir -p "$PROJECT/.claude/agents"
cp "$PLUGIN_ROOT/templates/agents/cto.md" "$PROJECT/.claude/agents/cto.md"
cp "$HERE/data-engineer.md" "$PROJECT/.claude/agents/data-engineer.md"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT OR REPLACE INTO agents (name, kind, scope, file_path, created_at)
VALUES
  ('cto',           'consultant', 'project-local', '.claude/agents/cto.md',           datetime('now')),
  ('data-engineer', 'consultant', 'project-local', '.claude/agents/data-engineer.md', datetime('now'));
SQL
