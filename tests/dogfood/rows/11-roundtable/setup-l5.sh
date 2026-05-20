#!/usr/bin/env bash
# L5 isolation setup for 11-roundtable (two-phase: from-scratch agent + mixed roundtable).
# Phase 1: /tmb:agent-create data-engineer triggers Branch C from-scratch.
# Phase 2: /roundtable with cto + data-engineer participants.
#
# Pre-seeds cto (templated, project-local) so the roundtable's templated half is
# already in place — we don't re-test Branch B here (row 10's job).
# Leaves data-engineer absent so Phase 1's Branch C is the substantive check.
# Pre-seeds an issue + decision the roundtable can cite for grounding.
set -uo pipefail

PROJECT="$1"
SCENARIO_DIR="$2"
# shellcheck disable=SC2034  # SCENARIO_DIR referenced for symmetry
:

PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$SCENARIO_DIR/../../../.." && pwd)}"

mkdir -p "$PROJECT/.claude/agents"

# Pre-seed cto only (templated half of the mixed roundtable).
src="$PLUGIN_ROOT/templates/agents/cto.md"
if [ -f "$src" ]; then
  cp "$src" "$PROJECT/.claude/agents/cto.md"
fi

# Ensure data-engineer is absent so Phase 1 Branch C must create it from scratch.
rm -f "$PROJECT/.claude/agents/data-engineer.md"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
-- Pre-seed an open issue + a SQLite-storage decision the roundtable cites.
-- AUTOINCREMENT works in both L5 (clean DB) and L6 (IDs already taken);
-- the discussion FK binds via last_insert_rowid().
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Analytics warehouse storage choice', 'Roundtable on ClickHouse vs PostgreSQL', 'open', datetime('now'), datetime('now'));

INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (last_insert_rowid(), 'bro', 'decision', 'Decision (row 8): switched TODO storage from JSON files to SQLite. Analytics warehouse is the next storage call.', datetime('now'));

-- Pre-register cto as project-local so Phase 2 doesn't need to re-run Branch B.
INSERT OR REPLACE INTO agents (name, kind, scope, file_path, created_at)
VALUES ('cto', 'consultant', 'project-local', '.claude/agents/cto.md', datetime('now'));
SQL
