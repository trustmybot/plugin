#!/usr/bin/env bash
# Lint: the generated part of docs/architecture/ERD.md (between the
# erd:generated markers: mermaid diagram, column tables, foreign keys, search
# indexes, index list, eval-mode tables) and the `schema_version = N` token
# above it match mcp/trajectory-server/src/schema.sql, schema-eval.sql and
# TARGET_SCHEMA_VERSION in src/db.ts.
#
# Every run first self-tests: a copy with one generated row dropped, and a copy
# with a stale schema_version, must each fail naming ERD.md.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$ROOT/scripts/maintenance/gen-erd-doc.mjs"

TMP=$(mktemp -d -t tmb-erd-doc-fresh-XXXX)
trap 'rm -rf "$TMP"' EXIT

stage() {
  mkdir -p "$TMP/$1/docs/architecture"
  cp "$ROOT/docs/architecture/ERD.md" "$TMP/$1/docs/architecture/ERD.md"
}

self_ok=0
stage row
sed -i.bak '/^| `idx_tasks_status` |/d' "$TMP/row/docs/architecture/ERD.md"
if node "$GEN" --check --root "$TMP/row" 2>"$TMP/row.err" || ! grep -q 'docs/architecture/ERD.md' "$TMP/row.err"; then
  echo "  ✗ self-test: an ERD missing a generated index row should fail naming ERD.md" >&2
  self_ok=1
fi
stage version
sed -i.bak '1,/`schema_version = [0-9]*`/s/`schema_version = [0-9]*`/`schema_version = 1`/' "$TMP/version/docs/architecture/ERD.md"
if node "$GEN" --check --root "$TMP/version" 2>"$TMP/version.err" || ! grep -q 'docs/architecture/ERD.md' "$TMP/version.err"; then
  echo "  ✗ self-test: an ERD with a stale schema_version should fail naming ERD.md" >&2
  self_ok=1
fi
if [ "$self_ok" -ne 0 ]; then
  echo "Erd-doc-fresh: FAIL (self-test)" >&2
  exit 1
fi

if ! node "$GEN" --check; then
  echo "" >&2
  echo "  To fix: node scripts/maintenance/gen-erd-doc.mjs" >&2
  echo "Erd-doc-fresh: FAIL" >&2
  exit 1
fi

echo "  ✓ self-test: a dropped generated row and a stale schema_version both fail"
echo "  ✓ ERD.md generated section matches schema.sql, schema-eval.sql and TARGET_SCHEMA_VERSION"
echo ""
echo "Erd-doc-fresh: PASS"
