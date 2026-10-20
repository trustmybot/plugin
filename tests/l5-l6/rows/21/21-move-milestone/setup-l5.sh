#!/usr/bin/env bash
# L5 isolation setup for 21-move-milestone. Seeds the project's repo row,
# three open milestones (v0.1.0 < v0.2.0 < v0.3.0) and the count-subcommand
# issue on v0.1.0 at medium priority. "The next milestone" is v0.2.0.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)}"
DB="$PROJECT/.claude/tmb/trajectory.db"

# run-l5.sh seeds the DB before this script; a bare project gets the schema.
if [ ! -f "$DB" ]; then
  mkdir -p "$PROJECT/.claude/tmb" || exit 1
  sqlite3 "$DB" < "$ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null || exit 1
fi

REPO=$(basename "$PROJECT")
REPO_SQL=${REPO//\'/\'\'}
PROJECT_SQL=${PROJECT//\'/\'\'}

sqlite3 "$DB" <<SQL
PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO repos (name, path) VALUES ('${REPO_SQL}', '${PROJECT_SQL}');

INSERT OR IGNORE INTO milestones (name, repo, state) VALUES
  ('v0.1.0', '${REPO_SQL}', 'open'),
  ('v0.2.0', '${REPO_SQL}', 'open'),
  ('v0.3.0', '${REPO_SQL}', 'open');

INSERT INTO issues (objective, description, status, created_at, updated_at,
                    repo, milestone, labels)
VALUES ('Add count subcommand to todo CLI',
        'Add a count subcommand that prints the number of todo items.',
        'open', datetime('now'), datetime('now'),
        '${REPO_SQL}', 'v0.1.0', '["Feature","Priority: Medium"]');
SQL
