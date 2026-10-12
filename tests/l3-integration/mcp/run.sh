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
# plugin root, so no server spawned here can reach the real ~/.claude, and
# TMPDIR is a fresh dir under that HOME. Afterwards HOME must hold nothing but
# that TMPDIR, TMPDIR nothing but the runner's own logs, and /tmp must have
# gained no entry named for this run (tests/lib/tmp-footprint.sh).
# The embedding model cache is a shared user cache, not TMB state: keep using
# the real one so the suite never re-downloads the model.
TOOL_PATH="$PATH"
export TMB_MODEL_CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-$HOME/.cache/huggingface}}"
. "$HERE/../../lib/tmp-footprint.sh"
. "$HERE/../../lib/live-db-shim.sh"
tmp_footprint_start l3-mcp
FOOTPRINT_HOME="$(mktemp -d "$(tmp_footprint_parent)/$TMB_TEST_RUN_ID-home.XXXXXX")"
RUN_TMPDIR="$FOOTPRINT_HOME/tmp"
RUNNER_LOGS="$RUN_TMPDIR/l3-mcp-runner"
mkdir -p "$RUNNER_LOGS"
# mise shims resolve tools from the real install + config; their own state and
# caches go to a throwaway dir, not the footprint HOME.
TOOL_STATE="$(mktemp -d "$(tmp_footprint_parent)/$TMB_TEST_RUN_ID-tools.XXXXXX")"
trap 'rm -rf "$FOOTPRINT_HOME" "$TOOL_STATE"' EXIT
export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$HOME/.config/mise}"
export MISE_STATE_DIR="$TOOL_STATE/mise-state" MISE_CACHE_DIR="$TOOL_STATE/mise-cache"
unset CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR CLAUDE_CONFIG_DIR

# Live DB: hooks spawned by the suite see a sqlite3 shim first on PATH that
# refuses (and records) any argument under the real project's .claude/tmb/
# (tests/lib/live-db-shim.sh); one refusal fails the suite.
live_db_shim_start "$PLUGIN_ROOT" "$RUNNER_LOGS/live-db-shim"
TOOL_PATH="$PATH"

L3_MCP_TESTS=("$HERE"/*.test.mjs)
[ -z "${L3_MCP_TEST_FILES:-}" ] || read -r -a L3_MCP_TESTS <<< "$L3_MCP_TEST_FILES"
L3_MCP_SCRIPTS=("$HERE/maintenance-scripts-no-db.test.sh")
[ -z "${L3_MCP_TEST_SCRIPTS+x}" ] || read -r -a L3_MCP_SCRIPTS <<< "$L3_MCP_TEST_SCRIPTS"

rc=0
FAILED_FILES=()
NODE_LOG="$RUNNER_LOGS/node-test.log"
HOME="$FOOTPRINT_HOME" TMPDIR="$RUN_TMPDIR" PATH="$TOOL_PATH" node --experimental-sqlite --test --test-reporter spec "${L3_MCP_TESTS[@]}" 2>&1 | tee "$NODE_LOG" || rc=$?
if [ "$rc" -ne 0 ]; then
  while IFS= read -r f; do FAILED_FILES+=("$f"); done < <(
    sed -n 's/^test at \(.*\):[0-9][0-9]*:[0-9][0-9]*$/\1/p' "$NODE_LOG" | sed 's|^file://||; s|.*/||' | awk '!seen[$0]++'
  )
  [ "${#FAILED_FILES[@]}" -gt 0 ] || FAILED_FILES+=("node --test (no failing file reported)")
fi
for script in ${L3_MCP_SCRIPTS[@]+"${L3_MCP_SCRIPTS[@]}"}; do
  [ -n "$script" ] || continue
  name="$(basename "$script")"
  HOME="$FOOTPRINT_HOME" TMPDIR="$RUN_TMPDIR" PATH="$TOOL_PATH" bash "$script" 2>&1 | tee "$RUNNER_LOGS/$name.log" || { rc=1; FAILED_FILES+=("$name"); }
done

footprint_fail=0
leaked="$(find "$FOOTPRINT_HOME" -mindepth 1 -path "$RUN_TMPDIR" -prune -o -print 2>/dev/null | sed "s|^$FOOTPRINT_HOME|\$HOME|")"
if [ -n "$leaked" ]; then
  printf 'FAIL footprint: the L3 MCP suite wrote under HOME:\n%s\n' "$leaked" >&2
  footprint_fail=1
else
  printf 'footprint: HOME untouched by the L3 MCP suite\n'
fi
leaked_tmp="$(find "$RUN_TMPDIR" -mindepth 1 -path "$RUNNER_LOGS" -prune -o -print 2>/dev/null | sed "s|^$RUN_TMPDIR|\$TMPDIR|")"
if [ -n "$leaked_tmp" ]; then
  printf 'FAIL footprint: the L3 MCP suite left files in TMPDIR:\n%s\n' "$leaked_tmp" >&2
  footprint_fail=1
else
  printf 'footprint: TMPDIR left clean by the L3 MCP suite\n'
fi
tmp_footprint_check "the L3 MCP suite" "$FOOTPRINT_HOME" "$TOOL_STATE" || footprint_fail=1
live_db_shim_check "the L3 MCP suite" || footprint_fail=1

# Summary: every failing file with its last 10 lines — for a node test file,
# the last 10 lines of its entries in node's "failing tests" report, stack
# frames dropped.
if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  printf '\nFailing test files:\n'
  for name in "${FAILED_FILES[@]}"; do
    printf '\nFAIL %s — last 10 lines:\n' "$name"
    if [ -f "$RUNNER_LOGS/$name.log" ]; then
      tail -n 10 "$RUNNER_LOGS/$name.log"
    else
      awk -v f="$name" '
        /^✖ failing tests:/ { report = 1; next }
        report && /^test at / { keep = index($0, "/" f ":") || index($0, "at " f ":") }
        report && keep && !/^[[:space:]]+at / { print }
      ' "$NODE_LOG" | tail -n 10
    fi | sed 's/^/  | /'
  done
  printf '\nFAIL files: %s\n' "${FAILED_FILES[*]}"
fi

[ "$footprint_fail" -eq 0 ] || exit 1
exit "$rc"
