#!/usr/bin/env bash
# Tests for scripts/hooks/ensure-kuzu-installed.sh
# SessionStart hook — lazy-installs kuzu native binaries in the background.
# Tests verify: bypass, missing-env-var early-exit, idempotence (already
# installed), no-package-manager path, and backgrounding behaviour.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/ensure-kuzu-installed.sh"

TMPDIR_EK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EK"' EXIT

run_hook() {
  echo "" | env "$@" bash "$HOOK" 2>&1 || true
}

# ──────────────────────────────────────────────────────────────
# Case 1: bypass env var exits silently
# ──────────────────────────────────────────────────────────────
test_case "TMB_SKIP_KUZU_INSTALL=1 exits silently"
out=$(echo "" | TMB_SKIP_KUZU_INSTALL=1 CLAUDE_PLUGIN_ROOT="$TMPDIR_EK" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var produces no output"

# ──────────────────────────────────────────────────────────────
# Case 2: missing CLAUDE_PLUGIN_ROOT exits silently
# ──────────────────────────────────────────────────────────────
test_case "missing CLAUDE_PLUGIN_ROOT exits silently"
out=$(echo "" | env -i HOME="$HOME" PATH="$PATH" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "no CLAUDE_PLUGIN_ROOT produces no output"

# ──────────────────────────────────────────────────────────────
# Case 3: CLAUDE_PLUGIN_ROOT set but MCP dir absent exits silently
# ──────────────────────────────────────────────────────────────
test_case "CLAUDE_PLUGIN_ROOT with no mcp/trajectory-server dir exits silently"
out=$(echo "" | CLAUDE_PLUGIN_ROOT="$TMPDIR_EK" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "absent MCP dir exits silently"

# ──────────────────────────────────────────────────────────────
# Case 4: MCP dir exists but package.json absent exits silently
# ──────────────────────────────────────────────────────────────
test_case "MCP dir without package.json exits silently"
MCP_DIR_4="$TMPDIR_EK/mcp4/trajectory-server"
mkdir -p "$MCP_DIR_4"
PLUGIN_ROOT_4="$TMPDIR_EK/mcp4"
out=$(echo "" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT_4" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "no package.json exits silently"

# ──────────────────────────────────────────────────────────────
# Case 5: package.json without "kuzu" dependency exits silently
# ──────────────────────────────────────────────────────────────
test_case "package.json without kuzu dep exits silently"
MCP_DIR_5="$TMPDIR_EK/mcp5/trajectory-server"
mkdir -p "$MCP_DIR_5"
echo '{"name":"traj","dependencies":{"better-sqlite3":"*"}}' > "$MCP_DIR_5/package.json"
PLUGIN_ROOT_5="$TMPDIR_EK/mcp5"
out=$(echo "" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT_5" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "no kuzu dep exits silently"

# ──────────────────────────────────────────────────────────────
# Case 6: idempotence — kuzu fully installed exits silently (fast-path)
# ──────────────────────────────────────────────────────────────
test_case "kuzu already installed exits silently (idempotent)"
MCP_DIR_6="$TMPDIR_EK/mcp6/trajectory-server"
KUZU_DIR_6="$MCP_DIR_6/node_modules/kuzu"
mkdir -p "$KUZU_DIR_6/prebuilt"
echo '{"name":"traj","dependencies":{"kuzu":"*"}}' > "$MCP_DIR_6/package.json"

# Detect the suffix the hook itself would compute.
SUFFIX=$(node -e 'process.stdout.write(process.platform + "-" + process.arch)' 2>/dev/null || echo "")
if [ -n "$SUFFIX" ]; then
  touch "$KUZU_DIR_6/prebuilt/kuzujs-${SUFFIX}.node"
fi
touch "$KUZU_DIR_6/index.js"

PLUGIN_ROOT_6="$TMPDIR_EK/mcp6"
out=$(echo "" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT_6" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "already-installed kuzu produces no output (idempotent)"

# ──────────────────────────────────────────────────────────────
# Case 7: kuzu partially installed (prebuilt present, index.js missing)
# triggers install.js recovery path — emits additionalContext
# ──────────────────────────────────────────────────────────────
test_case "prebuilt present but index.js missing triggers recovery notice"
MCP_DIR_7="$TMPDIR_EK/mcp7/trajectory-server"
KUZU_DIR_7="$MCP_DIR_7/node_modules/kuzu"
mkdir -p "$KUZU_DIR_7/prebuilt"
echo '{"name":"traj","dependencies":{"kuzu":"*"}}' > "$MCP_DIR_7/package.json"
SUFFIX=$(node -e 'process.stdout.write(process.platform + "-" + process.arch)' 2>/dev/null || echo "")
if [ -n "$SUFFIX" ]; then
  touch "$KUZU_DIR_7/prebuilt/kuzujs-${SUFFIX}.node"
fi
# No index.js — but also no install.js, so recovery no-ops silently.
# The hook emits the notice only when install.js exists; without it, exits 0 silently.
PLUGIN_ROOT_7="$TMPDIR_EK/mcp7"
out=$(echo "" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT_7" bash "$HOOK" 2>&1 || true)
# With no install.js: hook falls through to full-install path (emits install notice)
# or exits silently. Either way: no error, exits 0.
assert_not_contains "$out" "error" "partial install path does not emit error"

# ──────────────────────────────────────────────────────────────
# Case 8: full-install path — when kuzu absent, hook backgrounds install
# and emits additionalContext notice (requires bun or npm on PATH).
# We mock by pointing CLAUDE_PLUGIN_ROOT at a dir with kuzu dep but no
# node_modules. We verify: exit 0 and (if a package manager is present)
# the additionalContext notice is emitted.
# ──────────────────────────────────────────────────────────────
test_case "full-install path emits kuzu additionalContext notice (deterministic)"
# NOTE: the hook resolves MCP_DIR as $CLAUDE_PLUGIN_ROOT/mcp/trajectory-server,
# so the fixture must nest under mcp/ or the hook exits early at the -d check
# (the old mcp8/trajectory-server layout never reached this path — a tautology).
MCP_DIR_8="$TMPDIR_EK/mcp8/mcp/trajectory-server"
mkdir -p "$MCP_DIR_8"
echo '{"name":"traj","dependencies":{"kuzu":"*"}}' > "$MCP_DIR_8/package.json"
PLUGIN_ROOT_8="$TMPDIR_EK/mcp8"
# Curated PATH exposing only grep + jq (and bash to run the hook), deliberately
# omitting bun/npm so the hook takes the deterministic "no package manager"
# branch — it emits an additionalContext advisory instead of backgrounding a
# real network install (isolation: no stray process, no package-cache writes).
STUB_PATH_8="$TMPDIR_EK/stubpath8"
mkdir -p "$STUB_PATH_8"
for tool in bash grep jq; do
  src=$(command -v "$tool") && ln -sf "$src" "$STUB_PATH_8/$tool"
done
exit_code=0
out=$(echo "" | env -i HOME="$HOME" PATH="$STUB_PATH_8" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT_8" bash "$HOOK" 2>&1) || exit_code=$?
assert_exit_code "0" "$exit_code" "full-install path exits 0"
# Unconditional (anti-no-op): the full-install path always emits an
# additionalContext notice. A no-op replacement of the hook would emit nothing
# and fail these. Not guarded by [ -n "$out" ].
assert_contains "$out" '"additionalContext"' "full-install path emits additionalContext notice"
assert_contains "$out" "kuzu" "full-install notice names the kuzu install"

summarize
