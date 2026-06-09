#!/usr/bin/env bash
# Regression guard: file_registry was retired in schema v7 (ADR 0001).
# Anything resembling a live reference to file_registry / file-registry in
# production code, prompts, or docs is treated as drift back toward the
# pre-world-model design.
#
# Allowed exceptions (intentional historical/retirement references):
#  - docs/architecture/WORLD_MODEL.md — 'What was replaced' note
#  - docs/architecture/manual/decisions/0001-world-model-as-bro-memory.md — ADR retiring file_registry
#  - mcp/trajectory-server/src/db.ts — the migrateV6toV7 DROP TABLE itself
#  - CHANGELOG.md — accurate history
#  - tests/lint/no-file-registry-refs.sh — this script itself
#  - tests/run-all.sh — step label references this script name
#  - tests/EVALUATION.md — L6 journey table with historical step descriptions
#  - tests/mcp-integration/search-tools.test.mjs — "replaces file_registry_search" note in comment
#  - tests/manual/bench/ — historical bench scripts predating v7 retirement
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$PLUGIN_ROOT" || exit 1

HITS=$(grep -rlE 'file_registry|file-registry\.ts' \
  --include='*.ts' --include='*.js' --include='*.sh' \
  --include='*.mjs' --include='*.md' --include='*.json' \
  --include='*.sql' \
  agents/ skills/ commands/ hooks/ scripts/ mcp/trajectory-server/src/ docs/ CLAUDE.md \
  mcp/trajectory-server/README.md tests/ \
  2>/dev/null || true)

FAIL=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/architecture/WORLD_MODEL.md) continue;;
    docs/architecture/manual/decisions/0001-world-model-as-bro-memory.md) continue;;
    docs/architecture/manual/decisions/0002-graph-db-as-world-model.md) continue;;
    mcp/trajectory-server/src/db.ts) continue;;
    mcp/trajectory-server/src/test/schema.test.ts) continue;;
    mcp/trajectory-server/src/test/schema-upgrade.test.ts) continue;;
    tests/lint/no-file-registry-refs.sh) continue;;
    tests/run-all.sh) continue;;
    tests/EVALUATION.md) continue;;
    tests/mcp-integration/search-tools.test.mjs) continue;;
    tests/manual/bench/*) continue;;
    # CLAUDE.md is Human-owned (feedback_claude_md_owned_by_human) — warn,
    # don't fail. Surfacing the drift is the value; the Human applies the fix.
    CLAUDE.md)
      printf 'no-file-registry-refs: WARN — CLAUDE.md still references file_registry. Human-owned file; propose changes in chat.\n' >&2
      continue
      ;;
  esac
  printf 'no-file-registry-refs: %s contains file_registry / file-registry reference\n' "$f" >&2
  FAIL=1
done <<< "$HITS"

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-file-registry-refs: FAIL — file_registry was retired in v7. Use world_model_get / world_model_search (kuzu graph DB) or scan_run.\n' >&2
  exit 1
fi

printf 'no-file-registry-refs: PASS\n'
