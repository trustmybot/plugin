#!/usr/bin/env bash
# 05.04-multirepo-commit L5 isolation: builds the multi-repo workspace fixture.
# Creates api/ and app/ sibling git repos and registers both via the `repos`
# table (path-keyed resolution — see docs/architecture/REPO_RESOLUTION.md).
# README per inner repo lets scan_run populate the kuzu world model with
# README-derived summaries when bro runs /scan.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/api"
(
  cd "$PROJECT/api" || exit 1
  git init -q -b main
  git config user.email l5@l5.test
  git config user.name "L5 Test"
  cat > README.md <<'MD'
# api

HTTP API handlers + utilities for the auth service.
MD
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
  cat > README.md <<'MD'
# app

TypeScript app entrypoint.
MD
  cat > src/index.ts <<'TS'
export const hello = () => 'world';
TS
  git add . && git commit -qm "seed: app initial"
) >/dev/null

# Register both inner repos by path (path-keyed resolution).
# api carries a per-repo protected_branches value to exercise the per-repo
# authoritative model; app omits it (falls back to the global config).
API_PATH=$(cd "$PROJECT/api" && pwd -P)
APP_PATH=$(cd "$PROJECT/app" && pwd -P)
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT OR REPLACE INTO repos (name, path, protected_branches)
VALUES ('api', '$API_PATH', '["main"]');
INSERT OR REPLACE INTO repos (name, path)
VALUES ('app', '$APP_PATH');
SQL