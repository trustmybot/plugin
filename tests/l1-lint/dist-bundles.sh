#!/usr/bin/env bash
# Lint: the built esbuild entrypoints in mcp/trajectory-server/dist/ are bundles, not tsc module output.
#
# Why this exists: dist/index.js, dist/codex.js and dist/run-scan.js ship as
# self-contained esbuild bundles so a marketplace install with no node_modules
# still boots (#647/GH 1157). A plain `tsc` with outDir dist used to emit the
# same paths, replacing each bundle with a ~170-line module that imports its
# siblings (GH 2149). This check reads whatever dist/ the last build left.
#
# Allowlist: a file passes only when its first line starts with `var __` (the
# esbuild runtime prelude) AND no line is a relative `import`/`export ... from`.
#
# Usage: dist-bundles.sh [--self-test]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELATIVE_IMPORT_RE="^(import|export) .* from ['\"]\\.\\.?/"

# check_bundle <path> <label>: 0 when <path> is bundle-shaped, else 1 with the reason on stderr.
check_bundle() {
  local file="$1" label="$2" first relative
  if [ ! -s "$file" ]; then
    echo "  ✗ $label is missing or empty" >&2
    return 1
  fi
  first=$(head -n 1 "$file")
  case "$first" in
    'var __'*) ;;
    *)
      echo "  ✗ $label does not open with the esbuild prelude (\`var __\`): $first" >&2
      return 1
      ;;
  esac
  relative=$(grep -cE "$RELATIVE_IMPORT_RE" "$file" || true)
  if [ "$relative" != "0" ]; then
    echo "  ✗ $label has $relative relative import/export line(s) — tsc module output, not a bundle" >&2
    return 1
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  FIX="$ROOT/tests/l1-lint/fixtures/dist-bundles"
  if ! check_bundle "$FIX/bundle.js" "fixtures/dist-bundles/bundle.js"; then
    echo "Dist-bundles self-test: FAIL — bundle-shaped fixture rejected" >&2
    exit 1
  fi
  if check_bundle "$FIX/module.js" "fixtures/dist-bundles/module.js" 2>/dev/null; then
    echo "Dist-bundles self-test: FAIL — tsc-module-shaped fixture accepted" >&2
    exit 1
  fi
  echo "Dist-bundles self-test: PASS"
  exit 0
fi

DIST="$ROOT/mcp/trajectory-server/dist"
failed=0
for name in index.js codex.js run-scan.js; do
  if ! check_bundle "$DIST/$name" "mcp/trajectory-server/dist/$name"; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "  These dist entrypoints must be esbuild bundles. To fix:" >&2
  echo "    cd mcp/trajectory-server && bun run build" >&2
  echo "    git add mcp/trajectory-server/dist/" >&2
  echo "Dist-bundles: FAIL" >&2
  exit 1
fi

echo "  ✓ dist/index.js, dist/codex.js and dist/run-scan.js are esbuild bundles"
echo ""
echo "Dist-bundles: PASS"
