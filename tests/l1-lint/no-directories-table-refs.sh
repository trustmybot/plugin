#!/usr/bin/env bash
# Regression guard: the SQLite `directories` table was dropped in schema v8
# (ADR 0002). The kuzu graph DB is the sole world-model store. Any new
# CREATE TABLE directories / INSERT INTO directories / FROM directories
# in production code, prompts, tests, or docs is drift back toward the
# pre-kuzu design.
#
# Allowed exceptions (historical migration + guard itself):
#  - mcp/trajectory-server/src/db.ts — migrateV7toV8 DROP TABLE (historical)
#  - mcp/trajectory-server/dist/db.js — compiled output of the above
#  - docs/architecture/WORLD_MODEL.md — 'What was replaced' context
#  - CHANGELOG.md — accurate history
#  - tests/l1-lint/no-directories-table-refs.sh — this script itself
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$PLUGIN_ROOT" || exit 1

HITS=$(grep -rnE \
  'CREATE TABLE[[:space:]]+IF NOT EXISTS[[:space:]]+directories|CREATE TABLE[[:space:]]+directories|INSERT( OR IGNORE)? INTO directories|FROM[[:space:]]+directories' \
  --include='*.ts' --include='*.js' --include='*.sh' \
  --include='*.mjs' --include='*.md' --include='*.json' \
  --include='*.sql' \
  . \
  2>/dev/null | grep -v '^\./\.claude/' | awk -F: '{print $1}' | sed 's|^\./||' | sort -u || true)

FAIL=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    mcp/trajectory-server/src/db.ts) continue;;
    mcp/trajectory-server/dist/db.js) continue;;
    docs/architecture/WORLD_MODEL.md) continue;;
    CHANGELOG.md) continue;;
    tests/l1-lint/no-directories-table-refs.sh) continue;;
  esac
  printf 'no-directories-table-refs: %s contains SQLite directories-table DML/DDL\n' "$f" >&2
  FAIL=1
done <<< "$HITS"

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-directories-table-refs: FAIL — directories table was dropped in v8. Use world_model_get / world_model_search (kuzu graph DB) or scan_run.\n' >&2
  exit 1
fi

printf 'no-directories-table-refs: PASS\n'
