#!/usr/bin/env bash
# Shim: the trajectory DB path for the codex-owned L5/L6 shell harness
# (tests/l5-l6/run-l6-chain.sh). Sourced (not exec'd); it sets no shell options.
# It exists only for those callers and is a removal candidate once codex PRs
# 1183, 2159 and 2162-2166 land. The rule lives in dbPath
# (mcp/trajectory-server/src/hooks/lib/db.ts), documented once in
# docs/reference/TRAJECTORY_DB_LOCATION.md; this shim asks dist/cli.js for it.

# tmb_db_path: prints the resolved trajectory DB; exit 1 and no output when none resolves.
tmb_db_path() {
  local root
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P) || return 1
  node --experimental-sqlite "$root/mcp/trajectory-server/dist/cli.js" hook-lib db-path
}
