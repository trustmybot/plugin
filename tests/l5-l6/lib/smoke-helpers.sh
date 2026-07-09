#!/usr/bin/env bash
# Shared substrate-health checks for any test runner that spawns claude.
# Used by tests/l5-l6/run-l5.sh.
#
# Philosophy: anything an L0–L4 test would catch (MCP server can spawn,
# schema applies, auth works, plugin tree is intact) must be verified
# BEFORE expensive claude calls run. A failed substrate check aborts
# immediately — never spend tokens on a known-broken environment.
#
# Sourced into the calling script:  . "$HERE/lib/smoke-helpers.sh"

set -uo pipefail

# shellcheck source=tests/l5-l6/lib/timeout-shim.sh
source "$(dirname "${BASH_SOURCE[0]}")/timeout-shim.sh"

# _l5_throwaway_db_dir — holds the mktemp dir backing the smoke's throwaway
# trajectory DB so the EXIT trap can remove it. Empty until first use.
_L5_SMOKE_DB_DIR=""

# _l5_smoke_isolate_db — point the MCP server (spawned directly OR via
# `claude --plugin-dir`) at a FRESH throwaway trajectory DB. Without this the
# server's resolveDbPath walk-up adopts a PARENT PROJECT's live trajectory.db,
# so the smoke (a server-CODE health check) would mutate / migrate a real DB.
# Idempotent: reuses the same throwaway across all smokes in one process.
_l5_smoke_isolate_db() {
  if [ -n "$_L5_SMOKE_DB_DIR" ]; then return 0; fi
  _L5_SMOKE_DB_DIR=$(mktemp -d "${TMPDIR:-/tmp}/l5-smoke-db.XXXXXX")
  mkdir -p "$_L5_SMOKE_DB_DIR/.claude/tmb"
  export TRAJECTORY_DB_PATH="$_L5_SMOKE_DB_DIR/.claude/tmb/trajectory.db"
  trap '_l5_smoke_cleanup_db' EXIT
}

# _l5_smoke_cleanup_db — remove the throwaway DB dir created above.
_l5_smoke_cleanup_db() {
  if [ -n "$_L5_SMOKE_DB_DIR" ] && [ -d "$_L5_SMOKE_DB_DIR" ]; then
    rm -rf "$_L5_SMOKE_DB_DIR"
    _L5_SMOKE_DB_DIR=""
  fi
}

# l5_smoke_mcp <plugin_dir> — verifies the plugin tree at <plugin_dir> can
# spawn the MCP trajectory server and respond to tools/list. Returns 0 if
# response contains a tools list within 10s, 1 otherwise.
#
# Catches: missing dist/index.js, missing node_modules deps, schema.sql
# parse error in applySchema, any startup exception in the MCP server.
l5_smoke_mcp() {
  local plugin_dir="$1"
  _l5_smoke_isolate_db
  local mcp_entry="$plugin_dir/mcp/trajectory-server/dist/index.js"
  if [ ! -f "$mcp_entry" ]; then
    printf "  ✗ MCP smoke: entrypoint missing at %s\n" "$mcp_entry" >&2
    return 1
  fi

  local req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

  local resp
  resp=$(printf '%s\n' "$req" | _l5_timeout 10 node --experimental-sqlite "$mcp_entry" 2>&1 || true)

  if echo "$resp" | grep -q '"tools"'; then
    return 0
  fi

  printf "  ✗ MCP smoke: server did not return a tools list. Output:\n" >&2
  printf '%s\n' "$resp" | head -10 | sed 's/^/      /' >&2
  return 1
}

# l5_smoke_claude_auth — verifies CLAUDE_CODE_OAUTH_TOKEN is set + claude -p
# can produce output. Returns 0 if output is non-empty within 30s.
l5_smoke_claude_auth() {
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    printf "  ✗ Auth smoke: CLAUDE_CODE_OAUTH_TOKEN is not set\n" >&2
    return 1
  fi
  local out
  out=$(_l5_timeout 30 claude -p "say hi in one word" 2>&1 || true)
  if [ -z "$out" ]; then
    printf "  ✗ Auth smoke: claude -p returned empty output (token may be revoked)\n" >&2
    return 1
  fi
  return 0
}

# l5_smoke_claude_plugin_load <plugin_dir> — verifies claude can load the
# plugin without bro engaging. Smaller than the L5 flow runs. ~30s budget.
l5_smoke_claude_plugin_load() {
  local plugin_dir="$1"
  _l5_smoke_isolate_db
  local out
  out=$(_l5_timeout 60 claude --plugin-dir "$plugin_dir" --dangerously-skip-permissions -p "say hi in one word" 2>&1 || true)
  if [ -z "$out" ]; then
    printf "  ✗ Plugin-load smoke: claude --plugin-dir returned empty output\n" >&2
    printf "    plugin_dir=%s\n" "$plugin_dir" >&2
    return 1
  fi
  return 0
}

# l5_pre_flight_or_abort <plugin_dir> — runs all three smokes in order;
# aborts the calling script on any failure. Use as the FIRST thing in any
# test runner that's about to spend tokens on real claude calls.
l5_pre_flight_or_abort() {
  local plugin_dir="$1"
  printf "=== Pre-flight substrate health (fail-fast) ===\n"

  printf "  [1/3] MCP smoke (server spawns + responds): "
  if l5_smoke_mcp "$plugin_dir"; then
    printf "✓\n"
  else
    printf "\n❌ Pre-flight FAILED at MCP smoke. Aborting before token spend.\n"
    exit 1
  fi

  printf "  [2/3] Auth smoke (claude -p basic call): "
  if l5_smoke_claude_auth; then
    printf "✓\n"
  else
    printf "\n❌ Pre-flight FAILED at auth smoke. Aborting before token spend.\n"
    exit 1
  fi

  printf "  [3/3] Plugin-load smoke (claude --plugin-dir loads cleanly): "
  if l5_smoke_claude_plugin_load "$plugin_dir"; then
    printf "✓\n"
  else
    printf "\n❌ Pre-flight FAILED at plugin-load smoke. Aborting before token spend.\n"
    exit 1
  fi

  printf "=== Pre-flight passed ===\n\n"
}
