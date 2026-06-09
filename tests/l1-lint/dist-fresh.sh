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

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/mcp/trajectory-server"

TMPDIR=$(mktemp -d -t tmb-dist-fresh-XXXX)
trap 'rm -rf "$TMPDIR"' EXIT

# Build into a temp outDir (without touching the committed dist/)
if [ ! -x ./node_modules/.bin/tsc ]; then
  echo "  ⊘ tsc not installed locally — skipping (run 'bun install' first)" >&2
  echo "Dist-fresh: SKIPPED"
  exit 0
fi

./node_modules/.bin/tsc --outDir "$TMPDIR" >/dev/null
cp src/schema*.sql "$TMPDIR/"

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
