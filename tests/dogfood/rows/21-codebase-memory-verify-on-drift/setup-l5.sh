#!/usr/bin/env bash
# Seed a stale world model + drift: README committed with v1 text,
# deep_scan_completed audit row written (SQLite-side proxy for "kuzu world
# model warm with v1 summary"), then README edited on disk without a commit.
# The pre-state mimics "world model from yesterday's README" — bro should
# detect the drift on the next scan.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
echo "def foo(): return 'v1'" > "$PROJECT/src/foo.py"
cat > "$PROJECT/README.md" <<'MD'
# project — v1

Returns 'v1' from foo().
MD
(cd "$PROJECT" && git add . && git commit -qm "v1")
SEED_HEAD=$(git -C "$PROJECT" rev-parse HEAD)
PROJECT_REAL=$(cd "$PROJECT" && pwd -P)
REPO_NAME=$(basename "$PROJECT_REAL")

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT OR REPLACE INTO repos (name, path)
VALUES ('$REPO_NAME', '$PROJECT_REAL');

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'setup: seeded stale world model', '{}', datetime('now'));

INSERT INTO plugin_config (key, value_json)
VALUES ('last_verified_sha', '"$SEED_HEAD"');
SQL

# Simulate drift: edit foo.py + README on disk, do not commit.
echo "def foo(): return 'v2-modified'" > "$PROJECT/src/foo.py"
cat > "$PROJECT/README.md" <<'MD'
# project — v2

Returns 'v2-modified' from foo().
MD
