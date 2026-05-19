#!/usr/bin/env bash
# 33-multirepo-commit L5 isolation: builds the multi-repo workspace fixture.
# Configures tmb_default_repo='api', creates api/ and app/ sibling git repos.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '\"api\"');"

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