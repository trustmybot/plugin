#!/usr/bin/env bash
# Enforce total tool-description byte budget for the MCP server.
#
# Builds the server (if dist/ is stale), loads all tool definitions via
# the MCP stdio tools/list request, prints per-tool byte counts, and fails
# if the total exceeds BUDGET_BYTES.
#
# Budget = post-diet measured total + 10% headroom.
# Update BUDGET_BYTES whenever a new tool is added or descriptions are
# intentionally expanded.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
SERVER_DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist/index.js"

BUDGET_BYTES="${TMB_TOOL_DESC_BUDGET:-12280}"  # recalibrated post-merge: B5 issue_link + B6 validation docs + B15 compact-mode params landed after the diet baseline

if [ ! -f "$SERVER_DIST" ]; then
  echo "Building MCP server..."
  (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build 2>&1)
fi

RESULT=$(TRAJECTORY_DB_PATH=:memory: node --experimental-sqlite --input-type=module << 'EOF'
import { TrajectoryDB } from './mcp/trajectory-server/dist/db.js';
import { registerTools, toolDefinitions } from './mcp/trajectory-server/dist/tools/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const db = new TrajectoryDB(':memory:');
const server = new Server({ name: 'budget-lint', version: '1.0' }, { capabilities: { tools: {} } });
registerTools(server, db, ':memory:');

const byLen = toolDefinitions
  .map(t => ({ name: t.name, bytes: Buffer.byteLength(t.description || '', 'utf8') }))
  .sort((a, b) => b.bytes - a.bytes);

const total = byLen.reduce((s, t) => s + t.bytes, 0);

console.log('TOTAL_BYTES=' + total);
console.log('TOOL_COUNT=' + byLen.length);
byLen.forEach(t => console.log('TOOL ' + t.bytes + ' ' + t.name));
EOF
)

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to load tool definitions from $SERVER_DIST"
  exit 1
fi

TOTAL_BYTES=$(echo "$RESULT" | grep '^TOTAL_BYTES=' | cut -d= -f2)
TOOL_COUNT=$(echo "$RESULT" | grep '^TOOL_COUNT=' | cut -d= -f2)

printf "Tool description budget check\n"
printf "  Budget:  %d bytes\n" "$BUDGET_BYTES"
printf "  Total:   %d bytes (%d tools)\n" "$TOTAL_BYTES" "$TOOL_COUNT"
printf "\nPer-tool (sorted by size):\n"
echo "$RESULT" | grep '^TOOL ' | while IFS=' ' read -r _ bytes name; do
  printf "  %4d  %s\n" "$bytes" "$name"
done

if [ "$TOTAL_BYTES" -gt "$BUDGET_BYTES" ]; then
  OVER=$((TOTAL_BYTES - BUDGET_BYTES))
  printf "\n❌ FAIL: total %d bytes exceeds budget %d by %d bytes.\n" \
    "$TOTAL_BYTES" "$BUDGET_BYTES" "$OVER"
  printf "   Trim tool descriptions or raise BUDGET_BYTES (with justification).\n"
  exit 1
fi

printf "\n✓ PASS: %d bytes within %d-byte budget.\n" "$TOTAL_BYTES" "$BUDGET_BYTES"
