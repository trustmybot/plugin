#!/usr/bin/env bash
# Lint: ensure committed mcp/trajectory-server/dist/ matches the current src/.
#
# Why this exists: CC's marketplace install skips lifecycle scripts (postinstall
# doesn't fire), so the published artifact MUST contain a pre-built dist/
# directory. We commit dist/ to git (.gitignore exception). This lint catches
# the contributor regression where someone modifies src/ but forgets to
# rebuild dist/ before commit — leaving the published artifact serving stale
# code.
#
# How it works: rebuild dist/ in a temp location, diff against the committed
# version. Any divergence → FAIL with instructions to rebuild + recommit.
#
# First, the installed esbuild must be the version bun.lock pins: a dist built
# with another esbuild (e.g. a symlinked node_modules) otherwise passes (GH 1628).
#
# Usage: dist-fresh.sh [--self-test]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

check_esbuild_version() {
  local pkg_json="$1" lockfile="$2" installed locked
  installed=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" | head -1)
  locked=$(sed -n 's/^[[:space:]]*"esbuild":[[:space:]]*\[[[:space:]]*"esbuild@\([^"]*\)".*/\1/p' "$lockfile" | head -1)
  if [ -z "$installed" ] || [ -z "$locked" ]; then
    echo "dist-fresh: cannot read esbuild version (installed='$installed' from $pkg_json, locked='$locked' from $lockfile)" >&2
    return 1
  fi
  if [ "$installed" != "$locked" ]; then
    echo "dist-fresh: esbuild $installed installed but bun.lock pins $locked — run bun install --frozen-lockfile in mcp/trajectory-server" >&2
    return 1
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  FIX="$ROOT/tests/l1-lint/fixtures/dist-fresh"
  if ! check_esbuild_version "$FIX/match/package.json" "$FIX/match/bun.lock"; then
    echo "Dist-fresh self-test: FAIL — matching fixture rejected" >&2
    exit 1
  fi
  if check_esbuild_version "$FIX/mismatch/package.json" "$FIX/mismatch/bun.lock" 2>/dev/null; then
    echo "Dist-fresh self-test: FAIL — mismatched fixture accepted" >&2
    exit 1
  fi
  echo "Dist-fresh self-test: PASS"
  exit 0
fi

cd "$ROOT/mcp/trajectory-server"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-dist-fresh-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

# Build into a temp outDir (without touching the committed dist/).
# The shipped Claude and Codex entrypoints are esbuild bundles (self-contained
# so a fresh marketplace install with no node_modules still boots the MCP,
# #647/GH 1157); the rest of dist/ is plain tsc output. Reproduce both so the
# diff is apples-to-apples.
if [ ! -x ./node_modules/.bin/tsc ] || [ ! -x ./node_modules/.bin/esbuild ]; then
  echo "  ⊘ tsc/esbuild not installed locally — skipping (run 'bun install' first)" >&2
  echo "Dist-fresh: SKIPPED"
  exit 0
fi

ESBUILD_PKG=./node_modules/esbuild/package.json
[ -f "$ESBUILD_PKG" ] || ESBUILD_PKG="$ROOT/node_modules/esbuild/package.json"
if ! check_esbuild_version "$ESBUILD_PKG" "$ROOT/bun.lock"; then
  echo "Dist-fresh: FAIL" >&2
  exit 1
fi

./node_modules/.bin/tsc --outDir "$TMPDIR" >/dev/null
./node_modules/.bin/esbuild src/index.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@huggingface/transformers \
  --outfile="$TMPDIR/index.js" --sourcemap >/dev/null 2>&1
./node_modules/.bin/esbuild src/codex.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@huggingface/transformers \
  --outfile="$TMPDIR/codex.js" --sourcemap >/dev/null 2>&1
# Canonicalize the volatile bun-store path baked into the bundle. esbuild bakes
# the relative climb-out to the `.bun` store as __commonJS labels + comments; the
# depth varies by build location (symlinked worktree vs root vs CI). These are
# cosmetic labels (modules referenced by variable, not by the string key), so a
# consistent global collapse is runtime-safe. Use the production postprocessor
# here as well; it deliberately preserves every other byte, including significant
# trailing whitespace inside generated JavaScript template literals.
perl scripts/postprocess-bundle.pl \
  "$TMPDIR/index.js" "$TMPDIR/index.js.map" \
  "$TMPDIR/codex.js" "$TMPDIR/codex.js.map"
./node_modules/.bin/esbuild src/hooks/index.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@huggingface/transformers \
  --outfile="$TMPDIR/hooks.js" --sourcemap >/dev/null 2>&1
perl scripts/postprocess-bundle.pl "$TMPDIR/hooks.js" "$TMPDIR/hooks.js.map"
./node_modules/.bin/esbuild src/run-scan.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@huggingface/transformers \
  --outfile="$TMPDIR/run-scan.js" --sourcemap >/dev/null 2>&1
perl scripts/postprocess-bundle.pl "$TMPDIR/run-scan.js" "$TMPDIR/run-scan.js.map"
./node_modules/.bin/esbuild src/hooks/manifest.ts \
  --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  | node --input-type=module > "$TMPDIR/hooks-gates.txt"
cp src/schema*.sql "$TMPDIR/"
mkdir -p "$TMPDIR/parsing"
# The wasm list comes from the build script itself so the two cannot drift (GH 1848).
WASM_FILES=()
while IFS= read -r wasm; do
  [ -n "$wasm" ] && WASM_FILES+=("$wasm")
done < <(node -e 'for (const t of require("./package.json").scripts.build.split(/\s+/)) if (/^node_modules\/\S*\.wasm$/.test(t)) console.log(t);')
if [ "${#WASM_FILES[@]}" -eq 0 ]; then
  echo "dist-fresh: no node_modules/...*.wasm path found in package.json scripts.build" >&2
  echo "Dist-fresh: FAIL" >&2
  exit 1
fi
cp "${WASM_FILES[@]}" "$TMPDIR/parsing/"

# Diff (ignore .map files since their sourceRoot is path-dependent)
DIFF_OUT=$(diff -ru \
  --exclude='*.map' \
  --exclude='test' \
  --exclude='node-compile-cache' \
  --exclude='.cache' \
  dist/ "$TMPDIR/" 2>&1 || true)

if [ -n "$DIFF_OUT" ]; then
  echo "❌ Committed mcp/trajectory-server/dist/ is STALE (out of sync with src/)." >&2
  echo "" >&2
  echo "  CC's marketplace install ships whatever dist/ is in the published tag." >&2
  echo "  Stale dist/ = users get old code while their session reports the new" >&2
  echo "  version. This is the v0.2.0/v0.3.0 bug class one step removed." >&2
  echo "" >&2
  echo "  To fix:" >&2
  echo "    cd mcp/trajectory-server && bun run build && cd -" >&2
  echo "    git add mcp/trajectory-server/dist/" >&2
  echo "    # commit (or amend the in-flight commit)" >&2
  echo "" >&2
  echo "  First few diffs:" >&2
  echo "$DIFF_OUT" | head -20 >&2
  echo "Dist-fresh: FAIL" >&2
  exit 1
fi

echo "  ✓ Committed dist/ matches current src/"
echo ""
echo "Dist-fresh: PASS"
