#!/usr/bin/env bash
# Lint: the artifacts generated from mcp/trajectory-server/src/audit-events.ts
# are current — the audit.event_type table in docs/contributing/ENUMS.md
# (between its generated markers) and scripts/hooks/lib/audit-events.txt, the
# list hooks validate against. Reads the compiled dist/audit-events.js, which
# dist-fresh.sh keeps in step with src/.
#
# Every run first self-tests: a copy with one doc row dropped, and a copy with
# one txt line dropped, must each fail naming the stale file.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$ROOT/scripts/maintenance/gen-enums-doc.mjs"

TMP=$(mktemp -d -t tmb-enums-doc-fresh-XXXX)
trap 'rm -rf "$TMP"' EXIT

stage() {
  mkdir -p "$TMP/$1/docs/contributing" "$TMP/$1/scripts/hooks/lib"
  cp "$ROOT/docs/contributing/ENUMS.md" "$TMP/$1/docs/contributing/ENUMS.md"
  cp "$ROOT/scripts/hooks/lib/audit-events.txt" "$TMP/$1/scripts/hooks/lib/audit-events.txt"
}

self_ok=0
stage doc
sed -i.bak '/^| `planning_complete` |/d' "$TMP/doc/docs/contributing/ENUMS.md"
if node "$GEN" --check --root "$TMP/doc" 2>"$TMP/doc.err" || ! grep -q 'docs/contributing/ENUMS.md' "$TMP/doc.err"; then
  echo "  ✗ self-test: a doc missing a generated row should fail naming ENUMS.md" >&2
  self_ok=1
fi
stage txt
sed -i.bak '/^planning_complete$/d' "$TMP/txt/scripts/hooks/lib/audit-events.txt"
if node "$GEN" --check --root "$TMP/txt" 2>"$TMP/txt.err" || ! grep -q 'audit-events.txt' "$TMP/txt.err"; then
  echo "  ✗ self-test: a txt missing an event should fail naming audit-events.txt" >&2
  self_ok=1
fi
if [ "$self_ok" -ne 0 ]; then
  echo "Enums-doc-fresh: FAIL (self-test)" >&2
  exit 1
fi

if ! node "$GEN" --check; then
  echo "" >&2
  echo "  To fix: cd mcp/trajectory-server && npm run build && cd - && node scripts/maintenance/gen-enums-doc.mjs" >&2
  echo "Enums-doc-fresh: FAIL" >&2
  exit 1
fi

echo "  ✓ self-test: a stale doc row and a stale txt line both fail"
echo "  ✓ ENUMS.md audit.event_type table and scripts/hooks/lib/audit-events.txt match audit-events.ts"
echo ""
echo "Enums-doc-fresh: PASS"
