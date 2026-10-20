#!/usr/bin/env bash
# Lint: the generated key table in docs/reference/CONFIG_KEYS.md (between the
# config-keys:generated markers) matches the plugin_config keys the code reads
# and writes, and every such key has a KEYS entry in
# scripts/maintenance/gen-config-keys-doc.mjs (and every entry is used).
#
# Every run first self-tests: a copy with one generated row dropped must fail
# naming CONFIG_KEYS.md.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$ROOT/scripts/maintenance/gen-config-keys-doc.mjs"

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-config-keys-doc-fresh-XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/row/docs/reference"
cp "$ROOT/docs/reference/CONFIG_KEYS.md" "$TMP/row/docs/reference/CONFIG_KEYS.md"
sed -i.bak '/^| `issue_sync` |/d' "$TMP/row/docs/reference/CONFIG_KEYS.md"
if node "$GEN" --check --root "$TMP/row" 2>"$TMP/row.err" || ! grep -q 'docs/reference/CONFIG_KEYS.md' "$TMP/row.err"; then
  echo "  ✗ self-test: a CONFIG_KEYS.md missing a generated row should fail naming CONFIG_KEYS.md" >&2
  echo "Config-keys-doc-fresh: FAIL (self-test)" >&2
  exit 1
fi

if ! node "$GEN" --check; then
  echo "" >&2
  echo "  To fix: add the key's KEYS entry in scripts/maintenance/gen-config-keys-doc.mjs if it is new, then run node scripts/maintenance/gen-config-keys-doc.mjs" >&2
  echo "Config-keys-doc-fresh: FAIL" >&2
  exit 1
fi

echo "  ✓ self-test: a dropped generated row fails"
echo "  ✓ CONFIG_KEYS.md matches the plugin_config keys the code uses"
echo ""
echo "Config-keys-doc-fresh: PASS"
