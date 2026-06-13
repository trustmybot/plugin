#!/usr/bin/env bash
# Lint: enforce that the three version fields agree.
#
#   .claude-plugin/plugin.json  → the canonical published version
#   mcp/trajectory-server/package.json → the MCP subpackage version
#   package.json (root workspace)      → the workspace root version
#
# All three MUST equal each other on every commit.
#
# Catches: stale workspace-root version (we shipped 0.3.2 through v0.1.2),
# release-prep PRs that bump only one of the three.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CANON=$(jq -r '.version' .claude-plugin/plugin.json)
MCP=$(jq -r '.version'   mcp/trajectory-server/package.json)
WSROOT=$(jq -r '.version' package.json)

failed=0
check() {
  local name="$1" actual="$2"
  if [ "$actual" = "$CANON" ]; then
    printf "  ✓ %-40s %s\n" "$name" "$actual"
  else
    printf "  ✗ %-40s %s  (expected %s)\n" "$name" "$actual" "$CANON" >&2
    failed=1
  fi
}

echo "Enforcing version sync (canonical: .claude-plugin/plugin.json = $CANON)"
check ".claude-plugin/plugin.json"            "$CANON"
check "mcp/trajectory-server/package.json"    "$MCP"
check "package.json (workspace root)"         "$WSROOT"

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "Version sync FAILED. Bump all three to match in the same commit." >&2
  exit 1
fi

echo ""
echo "Version sync: PASS"
