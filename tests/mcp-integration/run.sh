#!/usr/bin/env bash
# Layer 2: MCP integration tests. Spawns the real MCP server as a subprocess
# and exercises the actual JSON-RPC stdio protocol — catches bugs that
# unit tests (which call handlers directly) miss: schema drift, protocol
# plumbing, role-enforcement at the wire level.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$PLUGIN_ROOT"

# Ensure server is built (harness spawns dist/index.js).
if [ ! -f "mcp/trajectory-server/dist/index.js" ]; then
  echo "Building MCP server before integration tests..."
  (cd mcp/trajectory-server && bun run build)
fi

exec node --test --test-reporter spec "$HERE"/*.test.mjs
