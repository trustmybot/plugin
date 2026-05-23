#!/usr/bin/env bash
# Regression guard: bun's default postinstall behavior is to SKIP scripts
# for security. kuzu's npm package relies on its postinstall (install.js)
# to copy connection.js / database.js / index.js / kuzu.d.ts etc. from
# kuzu-source/tools/nodejs_api/src_js/ to the package root. Without those
# files at the root, Node can't resolve `require('kuzu')` even though
# the prebuilt .node binary is present.
#
# Fix: mcp/trajectory-server/package.json declares
#   "trustedDependencies": ["kuzu"]
# which tells bun to run kuzu's postinstall. This lint blocks a regression
# where that field gets removed.
#
# Production failure mode this catches: fresh plugin install → bun install
# fires from ensure-kuzu-installed.sh → kuzu's binaries land but the JS
# shim doesn't → MCP server fails to import 'kuzu' → graph init catches
# the failure (graph=null) → world_model_* returns 'world-model-unavailable'.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
PKG="$PLUGIN_ROOT/mcp/trajectory-server/package.json"

if [ ! -f "$PKG" ]; then
  printf 'kuzu-trusted-dep: SKIP (no package.json at %s)\n' "$PKG"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'kuzu-trusted-dep: SKIP (jq unavailable)\n' >&2
  exit 0
fi

HAS_KUZU_DEP=$(jq -r '.dependencies.kuzu // empty' "$PKG")
if [ -z "$HAS_KUZU_DEP" ]; then
  printf 'kuzu-trusted-dep: SKIP (kuzu not declared as a dep)\n'
  exit 0
fi

TRUSTED=$(jq -r '.trustedDependencies // [] | index("kuzu") // empty' "$PKG")
if [ -z "$TRUSTED" ]; then
  printf 'kuzu-trusted-dep: FAIL — kuzu is a dependency but missing from "trustedDependencies".\n' >&2
  printf '  Without it, bun install skips kuzu postinstall (security default), leaving\n' >&2
  printf '  node_modules/kuzu/ with prebuilt binaries but no root index.js. The MCP server\n' >&2
  printf '  then fails to import kuzu and the graph DB silently never loads.\n' >&2
  printf '  Fix: add "trustedDependencies": ["kuzu"] to %s\n' "$PKG" >&2
  exit 1
fi

printf 'kuzu-trusted-dep: PASS\n'
