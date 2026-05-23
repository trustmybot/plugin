#!/usr/bin/env bash
# SessionStart hook — make sure the MCP server's kuzu native binary is
# present so the world-model graph DB loads on next MCP boot. kuzu ships
# platform-specific prebuilts (~20MB each, 95MB total) which we don't
# commit to the plugin repo. Instead, this hook lazy-installs them on
# first session after a fresh plugin install / update.
#
# Strategy: backgrounded `bun install` (or npm fallback) in the MCP
# server dir. The hook returns immediately so session start isn't
# blocked. First session after install may run with graph=null
# (world_model_get returns 'world-model-unavailable'); subsequent
# sessions have kuzu and the graph lights up.
#
# Idempotent — exits 0 fast when the platform-specific .node binary
# already exists. Bypass: TMB_SKIP_KUZU_INSTALL=1.
set -uo pipefail

if [ "${TMB_SKIP_KUZU_INSTALL:-0}" = "1" ]; then exit 0; fi
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0

MCP_DIR="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server"
[ -d "$MCP_DIR" ] || exit 0
[ -f "$MCP_DIR/package.json" ] || exit 0

# Skip if kuzu isn't declared as a dep (e.g., on a pre-v0.7 plugin checkout).
if ! grep -q '"kuzu"' "$MCP_DIR/package.json" 2>/dev/null; then
  exit 0
fi

# Detect platform suffix matching kuzu's prebuilt naming:
# kuzujs-<platform>-<arch>.node (darwin-arm64, darwin-x64, linux-arm64,
# linux-x64, win32-x64). node -e is the safest way to get these strings.
SUFFIX=""
if command -v node >/dev/null 2>&1; then
  SUFFIX=$(node -e 'process.stdout.write(process.platform + "-" + process.arch)' 2>/dev/null || true)
fi

if [ -n "$SUFFIX" ] && [ -f "$MCP_DIR/node_modules/kuzu/prebuilt/kuzujs-${SUFFIX}.node" ]; then
  exit 0
fi

# Pick the package manager.
INSTALLER=""
if command -v bun >/dev/null 2>&1; then
  INSTALLER="bun install --silent"
elif command -v npm >/dev/null 2>&1; then
  INSTALLER="npm install --silent --no-audit --no-fund"
else
  # No package manager available — surface as additionalContext so bro
  # can tell the human what's wrong.
  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg msg "kuzu install skipped: neither bun nor npm found on PATH. Install one + restart CC, OR run 'cd $MCP_DIR && bun install' manually. Without kuzu, world_model_get returns warning='world-model-unavailable'." '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$msg}}'
  fi
  exit 0
fi

# Run install in the background so session start isn't blocked. Log to a
# tmp file for diagnostics. disown lets the hook return immediately.
LOG="${TMPDIR:-/tmp}/tmb-kuzu-install.log"
(
  cd "$MCP_DIR" || exit 0
  printf '[%s] ensure-kuzu-installed: starting %s\n' "$(date -u +%FT%TZ)" "$INSTALLER" >> "$LOG"
  # shellcheck disable=SC2086
  $INSTALLER >> "$LOG" 2>&1
  printf '[%s] ensure-kuzu-installed: completed (exit=%s)\n' "$(date -u +%FT%TZ)" "$?" >> "$LOG"
) >/dev/null 2>&1 &
disown

# Surface a friendly notice so the Human knows what's happening on first
# session after install.
if command -v jq >/dev/null 2>&1; then
  jq -nc '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"📦 Installing kuzu native binaries for the world-model graph DB (first session after plugin install/update). Runs in the background; world_model_get goes live on next CC restart. Log: '"${LOG}"'"}}'
fi

exit 0
