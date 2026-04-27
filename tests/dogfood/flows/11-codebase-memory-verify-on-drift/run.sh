#!/usr/bin/env bash
# L5 — 11-codebase-memory-verify-on-drift (#45)
# Existing repo + populated file_registry + simulated drift (file content
# changed on disk after registry was written). On first code-touching ask,
# bro must run file_registry_verify and detect the mismatch. The stale row's
# summary should be cleared (or the row updated). last_verified_sha advances.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="11-codebase-memory-verify-on-drift"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro fix the bug in src/foo.py"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"
mkdir -p "$PROJECT/src"
echo "def foo(): return 'v1'" > "$PROJECT/src/foo.py"
(cd "$PROJECT" && git add . && git commit -qm "v1" && git rev-parse HEAD > /tmp/seed_head.$$)
SEED_HEAD=$(cat /tmp/seed_head.$$)

# Seed a stale registry row: file_registry says foo.py exists with a stale
# md5 ("0000...0000" obviously wrong) and an old summary. Plus seed
# last_verified_sha to the seed commit, so HEAD == last_verified_sha
# at moment of registry write — but then we modify the file on disk
# WITHOUT a new commit, so the tree is dirty and verify must run.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" "
INSERT INTO file_registry (path, type, content_md5, summary, summary_updated_at)
VALUES ('src/foo.py', 'source', '00000000000000000000000000000000', 'returns v1', datetime('now'));
INSERT INTO plugin_config (key, value_json, updated_at)
VALUES ('last_verified_sha', '\"$SEED_HEAD\"', datetime('now'));
"

# Simulate drift: edit the file on disk, don't commit
echo "def foo(): return 'v2-modified'" > "$PROJECT/src/foo.py"

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
rm -f /tmp/seed_head.$$
