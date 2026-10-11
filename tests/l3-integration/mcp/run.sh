#!/usr/bin/env bash
# Layer 2: MCP integration tests. Spawns the real MCP server as a subprocess
# and exercises the actual JSON-RPC stdio protocol — catches bugs that
# unit tests (which call handlers directly) miss: schema drift, protocol
# plumbing, role-enforcement at the wire level.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

cd "$PLUGIN_ROOT"

# Ensure server is built (harness spawns dist/index.js).
if [ ! -f "mcp/trajectory-server/dist/index.js" ]; then
  echo "Building MCP server before integration tests..."
  (cd mcp/trajectory-server && bun run build)
fi

# Run L3 integration tests. L4 workflow-simulation flows are run separately by
# run-all.sh via bun test (canonical). Both share the same harness + spawn the
# real MCP server.
# --experimental-sqlite needed on Node 22 (no-op on 24+); the harness imports
# the MCP server, which uses node:sqlite via its own --experimental-sqlite flag
# on the spawned subprocess. The flag here is for any direct node:sqlite use
# the test files might add later.
#
# Footprint: the suite runs against an empty temp HOME with no inherited
# plugin root, so no server spawned here can reach the real ~/.claude, and the
# HOME must still be empty afterwards.
# The embedding model cache is a shared user cache, not TMB state: keep using
# the real one so the suite never re-downloads the model.
TOOL_PATH="$PATH"
export TMB_MODEL_CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-$HOME/.cache/huggingface}}"
FOOTPRINT_HOME="$(mktemp -d)"
trap 'rm -rf "$FOOTPRINT_HOME"' EXIT
unset CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR CLAUDE_CONFIG_DIR

rc=0
HOME="$FOOTPRINT_HOME" PATH="$TOOL_PATH" node --experimental-sqlite --test --test-reporter spec "$HERE"/*.test.mjs || rc=$?

leaked="$(find "$FOOTPRINT_HOME" -mindepth 1 -print 2>/dev/null | sed "s|^$FOOTPRINT_HOME|\$HOME|")"
if [ -n "$leaked" ]; then
  printf 'FAIL footprint: the L3 MCP suite wrote under HOME:\n%s\n' "$leaked" >&2
  exit 1
fi
printf 'footprint: HOME untouched by the L3 MCP suite\n'
exit "$rc"
