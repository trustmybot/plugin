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
  if ! grep -F -q 'scripts/postprocess-bundle.pl' "$caller"; then
    fail "$caller must use the shared bundle postprocessor"
  fi
done

tmpdir=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-bundle-whitespace-safety.XXXXXX")
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

# Every esbuild bundle in build:bundle, and its map, goes through the
# postprocessor, so the next entry cannot skip it (GH 1850).
BUNDLES=()
while IFS= read -r bundle; do
  [ -n "$bundle" ] && BUNDLES+=("$bundle")
done < <(node -e '
const script = require("./mcp/trajectory-server/package.json").scripts["build:bundle"] || "";
const processed = new Set();
for (const step of script.split("&&")) {
  const words = step.trim().split(/\s+/);
  if (words[0] === "perl" && words[1] === "scripts/postprocess-bundle.pl") words.slice(2).forEach((w) => processed.add(w));
}
for (const m of script.matchAll(/--outfile=dist\/([^\s\/]+)\.js(?=\s|$)/g)) {
  for (const file of [`dist/${m[1]}.js`, `dist/${m[1]}.js.map`]) {
    if (!processed.has(file)) console.log(`UNPROCESSED ${file}`);
  }
  console.log(`dist/${m[1]}.js`);
}')
if [ "${#BUNDLES[@]}" -eq 0 ]; then
  fail "no --outfile=dist/<name>.js found in mcp/trajectory-server/package.json scripts.build:bundle"
fi
for bundle in "${BUNDLES[@]}"; do
  if [[ "$bundle" == UNPROCESSED\ * ]]; then
    fail "build:bundle must pass ${bundle#UNPROCESSED } to scripts/postprocess-bundle.pl"
  fi
done

if leaked=$(grep -lE '"(\.\./)+node_modules/\.bun/' mcp/trajectory-server/dist/*.js); then
  fail "committed bundle carries a build-location module key: $leaked"
fi

for rel in "${BUNDLES[@]}"; do
  bundle="mcp/trajectory-server/$rel"
  attr=$(git check-attr whitespace -- "$bundle")
  if [[ "$attr" != "$bundle: whitespace: unset" ]]; then
    fail "$bundle must opt out of git whitespace diagnostics as a generated bundle"
  fi
done

echo "bundle-whitespace-safety: PASS"
