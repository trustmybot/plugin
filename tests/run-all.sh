#!/usr/bin/env bash
# Full TMB plugin test suite: MCP server + hook scripts.
# Exit 0 only if every suite passes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
FAIL=0

printf "=== Layer 1: MCP unit tests (handlers direct, no protocol) ===\n"
if (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build && node --test dist/test/*.test.js); then
  printf "MCP unit suite: PASS\n\n"
else
  printf "MCP unit suite: FAIL\n\n"
  FAIL=1
fi

printf "=== Layer 2: MCP integration tests (real server subprocess + stdio JSON-RPC) ===\n"
if bash "$HERE/mcp-integration/run.sh"; then
  printf "\nMCP integration suite: PASS\n\n"
else
  printf "\nMCP integration suite: FAIL\n\n"
  FAIL=1
fi

printf "=== Hook script tests (tests/hooks) ===\n"
if bash "$HERE/hooks/run.sh"; then
  printf "\nHook suite: PASS\n"
else
  printf "\nHook suite: FAIL\n"
  FAIL=1
fi

printf "\n=== Lint: agent prompt budget (tests/lint) ===\n"
if bash "$HERE/lint/agent-line-budget.sh"; then
  printf "\nLint suite: PASS\n"
else
  printf "\nLint suite: FAIL\n"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  printf "\nAll test suites passed.\n"
  exit 0
else
  printf "\nOne or more test suites failed. See output above.\n"
  exit 1
fi
