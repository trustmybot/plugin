#!/usr/bin/env bash
# L5 v2 — 33-multirepo-commit
#
# Multi-repo workspace fixture: workspace root holds the trajectory DB,
# two sibling inner git repos (api/, app/) are submodule-style siblings.
# `tmb_default_repo` is configured to point at `api`. Bro is asked to
# index the source files under api/ into the file_registry.
#
# What's under test (#2869-adjacent / path-translation discipline):
#   - bro reads tmb_default_repo from plugin_config (or tasks.repo)
#   - bro globs / reads the right inner repo
#   - bro inserts file_registry rows with REPO-RELATIVE paths (no `api/`
#     prefix), matching the storage doctrine
#   - bro does NOT touch app/ files

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="33-multirepo-commit"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro this is a multi-repo workspace. Index the default code repo's source files into file_registry. Use repo-relative paths since file_registry is scoped per repo via tasks.repo / tmb_default_repo."

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

# Configure the workspace's default repo.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '\"api\"');"

# --- Build the multi-repo workspace ---
# api/ is the "default" inner repo bro should target.
mkdir -p "$PROJECT/api"
(
  cd "$PROJECT/api" || exit 1
  git init -q -b main
  git config user.email l5@l5.test
  git config user.name "L5 Test"
  cat > handler.py <<'PY'
def handle(request):
    return {"status": "ok"}
PY
  cat > utils.py <<'PY'
def slugify(s):
    return s.lower().replace(' ', '-')
PY
  git add . && git commit -qm "seed: api initial"
) >/dev/null

# app/ is a sibling repo bro must NOT touch.
mkdir -p "$PROJECT/app/src"
(
  cd "$PROJECT/app" || exit 1
  git init -q -b main
  git config user.email l5@l5.test
  git config user.name "L5 Test"
  cat > src/index.ts <<'TS'
export const hello = () => 'world';
TS
  git add . && git commit -qm "seed: app initial"
) >/dev/null

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
