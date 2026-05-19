#!/usr/bin/env bash
# Seed stale file_registry row + drift: foo.py committed, registry row written
# with wrong md5, then file modified on disk without commit.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
echo "def foo(): return 'v1'" > "$PROJECT/src/foo.py"
(cd "$PROJECT" && git add . && git commit -qm "v1")
SEED_HEAD=$(git -C "$PROJECT" rev-parse HEAD)

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" "
INSERT INTO file_registry (path, type, content_md5, summary, summary_updated_at)
VALUES ('src/foo.py', 'source', '00000000000000000000000000000000', 'returns v1', datetime('now'));
INSERT INTO plugin_config (key, value_json)
VALUES ('last_verified_sha', '\"$SEED_HEAD\"');
"

# Simulate drift: edit the file on disk, don't commit
echo "def foo(): return 'v2-modified'" > "$PROJECT/src/foo.py"
