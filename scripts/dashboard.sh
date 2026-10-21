#!/usr/bin/env bash
# Start the local read-only TMB dashboard (dashboard/dist/server.mjs).
# The server resolves the trajectory DB like the MCP server does
# (TRAJECTORY_DB_PATH, else a walk up from CLAUDE_PROJECT_DIR or the cwd),
# binds 127.0.0.1 on TMB_DASHBOARD_PORT (default 7477) and prints its URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/dashboard/dist/server.mjs"

if [ ! -f "$SERVER" ]; then
  echo "dashboard is not built: $SERVER missing (cd dashboard && bun install && bun run build)" >&2
  exit 1
fi

exec node "$SERVER"
