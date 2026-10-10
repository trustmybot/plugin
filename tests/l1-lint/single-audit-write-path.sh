#!/usr/bin/env bash
# Lint: every server-side audit row goes through insertAudit (tools/audit.ts),
# which populates audit.repo and embeds at write time. A second raw
# `INSERT INTO audit` under src/tools/ bypasses both.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS="$ROOT/mcp/trajectory-server/src/tools"

matches="$(grep -n "INSERT INTO audit" "$TOOLS"/*.ts || true)"
count="$(printf '%s' "$matches" | grep -c . || true)"

if [ "$count" -eq 1 ] && printf '%s' "$matches" | grep -q "/audit.ts:"; then
  echo "  ✓ exactly one INSERT INTO audit in src/tools/ (insertAudit)"
  echo ""
  echo "Single-audit-write-path: PASS"
else
  echo "  ✗ expected exactly 1 INSERT INTO audit in src/tools/ (inside insertAudit in audit.ts), found $count:" >&2
  printf '%s\n' "$matches" | sed "s|$ROOT/||" >&2
  echo "" >&2
  echo "Single-audit-write-path: FAIL — route audit writes through insertAudit()" >&2
  exit 1
fi
