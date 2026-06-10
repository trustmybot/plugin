#!/usr/bin/env bash
# Lint: TypeScript type-check the MCP server source without emitting JS.
#
# Build (`bun run build`) does emit, so type errors there look the same
# as a clean compile if you don't read the log. This isolates the type
# check as its own fast assertion — fails the lint suite immediately
# instead of relying on someone noticing tsc warnings during build.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/mcp/trajectory-server"

# Prefer the locally-installed TS in node_modules (deterministic, what
# the build also uses). Fall back to PATH-tsc if for some reason node_modules
# isn't populated.
if [ -x ./node_modules/.bin/tsc ]; then
  TSC="./node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC="tsc"
else
  echo "  ⊘ tsc not found locally or on PATH — run 'bun install' first" >&2
  echo "Tsc-noemit: SKIPPED"
  exit 0
fi

if $TSC --noEmit; then
  echo "  ✓ MCP server type-checks clean"
  echo ""
  echo "Tsc-noemit: PASS"
else
  echo "" >&2
  echo "Tsc-noemit: FAIL — fix type errors above" >&2
  exit 1
fi
