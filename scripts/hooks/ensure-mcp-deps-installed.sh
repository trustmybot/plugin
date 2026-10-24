#!/usr/bin/env bash
# SessionStart: make sure the MCP server's external runtime dependency,
# @huggingface/transformers, resolves from mcp/trajectory-server. dist/index.js
# is bundled with --external:@huggingface/transformers (its onnxruntime-node
# native prebuilts are per platform), and a marketplace install runs no
# package install, so without this the server boots with embeddings_degraded.
#
# Ready (Node's ESM resolver finds the package from the MCP dir) → exit 0 with
# no output. Missing → a detached `bun install --production --ignore-scripts
# --no-save` (npm fallback: `npm install --omit=dev --ignore-scripts --no-save
# --no-audit --no-fund`) in the MCP dir, and an additionalContext notice that
# embeddings go live on the next restart. The MCP dir is a workspace member, so
# both package managers install at the plugin root's workspace (node_modules
# under $CLAUDE_PLUGIN_ROOT, which Node reaches by walking up from the MCP
# dir); --ignore-scripts keeps the root postinstall build from running in the
# plugin cache and --no-save leaves its lockfile alone. No package manager →
# an additionalContext notice naming the manual command.
#
# One install at a time per plugin install: the lock is the directory
# mcp/trajectory-server/.deps-install.lock, reclaimed after
# TMB_MCP_DEPS_LOCK_STALE_MIN minutes (default 15). When the project has a TMB
# state dir, the install logs to <state>/logs/mcp-deps-install.log and the
# package-manager caches go to <state>/cache/{bun,npm}.
#
# Every path exits 0. Bypass: TMB_SKIP_MCP_DEPS_INSTALL=1. Unset
# CLAUDE_PLUGIN_ROOT, no MCP dir or no node → exit 0, no output.

set -uo pipefail

[ "${TMB_SKIP_MCP_DEPS_INSTALL:-0}" = "1" ] && exit 0
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0

MCP_DIR="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server"
[ -f "$MCP_DIR/package.json" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

if (cd "$MCP_DIR" && node --input-type=module \
      -e 'import.meta.resolve("@huggingface/transformers")') >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

notice() {
  command -v jq >/dev/null 2>&1 || return 0
  jq -nc --arg msg "$1" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$msg}}'
}

if command -v bun >/dev/null 2>&1; then
  INSTALLER=(bun install --production --ignore-scripts --no-save)
elif command -v npm >/dev/null 2>&1; then
  INSTALLER=(npm install --omit=dev --ignore-scripts --no-save --no-audit --no-fund)
else
  notice "📦 Semantic search is degraded: the MCP server's @huggingface/transformers is not installed and neither bun nor npm is on PATH. Install one and restart Claude Code, or run: cd \"$MCP_DIR\" && bun install --production --ignore-scripts --no-save"
  exit 0
fi

LOCK="$MCP_DIR/.deps-install.lock"
STALE_MIN="${TMB_MCP_DEPS_LOCK_STALE_MIN:-15}"
case "$STALE_MIN" in ''|*[!0-9]*) STALE_MIN=15 ;; esac
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +"$STALE_MIN" 2>/dev/null)" ]; then
  rmdir "$LOCK" 2>/dev/null
fi
mkdir "$LOCK" 2>/dev/null || exit 0

LOG=/dev/null
LOG_NOTE=""
if STATE_DIR=$(tmb_state_dir 2>/dev/null) && mkdir -p "$STATE_DIR/logs" 2>/dev/null; then
  LOG="$STATE_DIR/logs/mcp-deps-install.log"
  LOG_NOTE=" Log: $LOG"
  export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$STATE_DIR/cache/bun}"
  export npm_config_cache="${npm_config_cache:-$STATE_DIR/cache/npm}"
fi

(
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  cd "$MCP_DIR" || exit 0
  printf '[%s] ensure-mcp-deps-installed: %s in %s\n' "$(date -u +%FT%TZ)" "${INSTALLER[*]}" "$MCP_DIR"
  "${INSTALLER[@]}"
  rc=$?
  printf '[%s] ensure-mcp-deps-installed: exit %s\n' "$(date -u +%FT%TZ)" "$rc"
) </dev/null >>"$LOG" 2>&1 &
disown 2>/dev/null || true

notice "📦 Installing the MCP server's @huggingface/transformers in the background (${INSTALLER[0]}); semantic search runs on FTS until then and embeddings go live on the next Claude Code restart.${LOG_NOTE}"
exit 0
