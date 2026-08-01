#!/usr/bin/env bash
# Regression guard for GH 1163: bundle post-processing must not rewrite
# whitespace that can be significant inside generated template literals.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "bundle-whitespace-safety: FAIL: $*" >&2
  exit 1
}

POSTPROCESSOR="mcp/trajectory-server/scripts/postprocess-bundle.pl"

for caller in \
  mcp/trajectory-server/package.json \
  tests/l1-lint/dist-fresh.sh; do
  if ! rg -F 'scripts/postprocess-bundle.pl' "$caller" >/dev/null; then
    fail "$caller must use the shared bundle postprocessor"
  fi
done

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# This fixture models dependency source embedded in a generated template
# literal. The spaces before both newlines are runtime string data and must be
# byte-identical after production postprocessing. Only the variable Bun-store
# prefix may change.
printf 'const generated = `first line   \nsecond line  \n`;\nconst label = "../../node_modules/.bun/pkg";\n' \
  > "$tmpdir/input.js"
printf 'const generated = `first line   \nsecond line  \n`;\nconst label = "node_modules/.bun/pkg";\n' \
  > "$tmpdir/expected.js"

perl "$POSTPROCESSOR" "$tmpdir/input.js"
if ! cmp -s "$tmpdir/expected.js" "$tmpdir/input.js"; then
  fail "production bundle postprocessing changed bytes outside Bun-store labels"
fi

for bundle in \
  mcp/trajectory-server/dist/index.js \
  mcp/trajectory-server/dist/codex.js; do
  attr=$(git check-attr whitespace -- "$bundle")
  if [[ "$attr" != "$bundle: whitespace: unset" ]]; then
    fail "$bundle must opt out of git whitespace diagnostics as a generated bundle"
  fi
done

echo "bundle-whitespace-safety: PASS"
