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

WORKFLOW_SIM="$PLUGIN_ROOT/tests/workflow-sim"

# Run both L3 integration tests and L4 workflow-simulation flows in one Node
# process. Both share the same harness + spawn the real MCP server.
# --experimental-sqlite needed on Node 22 (no-op on 24+); the harness imports
# the MCP server, which uses node:sqlite via its own --experimental-sqlite flag
# on the spawned subprocess. The flag here is for any direct node:sqlite use
# the test files might add later.
exec node --experimental-sqlite --test --test-reporter spec "$HERE"/*.test.mjs "$WORKFLOW_SIM"/*.test.mjs
