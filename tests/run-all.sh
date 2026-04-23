#!/usr/bin/env bash
# Full TMB plugin test suite: MCP server + hook scripts.
# Exit 0 only if every suite passes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
FAIL=0

printf "=== MCP server tests (mcp/trajectory-server) ===\n"
if (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build && node --test dist/test/*.test.js); then
  printf "MCP suite: PASS\n\n"
else
  printf "MCP suite: FAIL\n\n"
  FAIL=1
fi

printf "=== Hook script tests (tests/hooks) ===\n"
if bash "$HERE/hooks/run.sh"; then
  printf "\nHook suite: PASS\n"
else
  printf "\nHook suite: FAIL\n"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  printf "\nAll test suites passed.\n"
  exit 0
else
  printf "\nOne or more test suites failed. See output above.\n"
  exit 1
fi
