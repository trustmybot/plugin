#!/usr/bin/env bash
# Pre-seed the SQLite-storage decision context the roundtable will cite,
# plus copy the architect/cto/pm consultant templates into .claude/agents/
# so Agent can spawn them without re-running the template-copy ceremony.
set -uo pipefail

PROJECT="$1"
SCENARIO_DIR="$2"
# shellcheck disable=SC2034  # SCENARIO_DIR referenced for symmetry
:

PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$SCENARIO_DIR/../../../.." && pwd)}"

mkdir -p "$PROJECT/.claude/agents"
for name in architect cto pm; do
  src="$PLUGIN_ROOT/templates/agents/${name}.md"
  if [ -f "$src" ]; then
    cp "$src" "$PROJECT/.claude/agents/${name}.md"
  fi
done

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
-- Pre-seed an open issue with a SQLite-storage decision the roundtable
-- references in its topic. AUTOINCREMENT so this works as both an L5 unit
-- (clean DB) and an L6 chain step where IDs are already taken. The
-- discussion FK uses last_insert_rowid() to bind to the new issue.
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('TODO CLI watcher concurrency', 'Roundtable on async-first vs thread-pooled', 'open', datetime('now'), datetime('now'));

INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (last_insert_rowid(), 'bro', 'decision', 'Decision (row 8): switched TODO storage from JSON files to SQLite.', datetime('now'));

-- Re-register consultants at project-local scope so Agent picks them up
-- without re-running the template-copy ceremony in this row.
INSERT OR REPLACE INTO agents (name, kind, scope, file_path, created_at)
VALUES
  ('architect', 'consultant', 'project-local', '.claude/agents/architect.md', datetime('now')),
  ('cto',       'consultant', 'project-local', '.claude/agents/cto.md',       datetime('now')),
  ('pm',        'consultant', 'project-local', '.claude/agents/pm.md',        datetime('now'));
SQL
