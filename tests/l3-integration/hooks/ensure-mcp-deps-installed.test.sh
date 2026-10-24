#!/usr/bin/env bash
# Tests for scripts/hooks/ensure-mcp-deps-installed.sh (SessionStart, GH 1669):
# lazy-installs the MCP server's @huggingface/transformers in the background.
# A fake plugin root and stub bun/npm on PATH record every invocation (cwd,
# args, cache env), so no real install or network call runs.
#
# Cases: installed → no installer; missing → bun once in the MCP dir with
# production flags, notice, log + cache under the project state dir; install
# already running (lock held) → no second installer; npm fallback; no package
# manager → notice naming the manual command; bypass env → no-op; no plugin
# root → exit 0.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
. "$HERE/fixtures/no-jq-path.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/ensure-mcp-deps-installed.sh"

BASE=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-ensure-mcp-deps.XXXXXX")
trap 'rm -rf "$BASE"' EXIT
cd "$BASE"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

PROJECT="$BASE/project"
mkdir -p "$PROJECT/.claude/tmb"
: > "$PROJECT/.claude/tmb/trajectory.db"
export CLAUDE_PROJECT_DIR="$PROJECT"
export TRAJECTORY_DB_PATH="$PROJECT/.claude/tmb/trajectory.db"
unset NODE_PATH BUN_INSTALL_CACHE_DIR npm_config_cache TMB_SKIP_MCP_DEPS_INSTALL

STUBS="$BASE/stubs"
mkdir -p "$STUBS/bun" "$STUBS/npm"
for pm in bun npm; do
  cat > "$STUBS/$pm/$pm" <<EOF
#!/usr/bin/env bash
printf '%s|%s|%s|%s\n' "\$PWD" "\$*" "\${BUN_INSTALL_CACHE_DIR:-}" "\${npm_config_cache:-}" >> "\$STUB_RECORD"
EOF
  chmod +x "$STUBS/$pm/$pm"
done
NO_PM_PATH=$(no_cmd_path "$BASE/shadow-bun" bun)
NO_PM_PATH=$(PATH="$NO_PM_PATH" no_cmd_path "$BASE/shadow-npm" npm)

# fake_root <name> — a plugin root holding mcp/trajectory-server/package.json.
fake_root() {
  mkdir -p "$BASE/$1/mcp/trajectory-server"
  echo '{"name":"traj","type":"module","dependencies":{"@huggingface/transformers":"^3.0.0"}}' \
    > "$BASE/$1/mcp/trajectory-server/package.json"
  printf '%s\n' "$BASE/$1"
}

# wait_unlocked <mcp dir> — waits up to 10 s for the background install to end.
wait_unlocked() {
  local i=0
  while [ -d "$1/.deps-install.lock" ] && [ "$i" -lt 100 ]; do
    sleep 0.1
    i=$((i + 1))
  done
}

# run_hook <path> <plugin root> [env...] — sets RC and OUT.
run_hook() {
  local path="$1" root="$2"
  shift 2
  RC=0
  OUT=$(echo '{"hook_event_name":"SessionStart","session_id":"s1"}' \
    | env PATH="$path" CLAUDE_PLUGIN_ROOT="$root" "$@" bash "$HOOK" 2>&1) || RC=$?
}

test_case "installed: transformers resolves from the MCP dir → no installer, no output"
ROOT=$(fake_root installed)
PKG="$ROOT/node_modules/@huggingface/transformers"
mkdir -p "$PKG"
echo '{"name":"@huggingface/transformers","version":"3.0.0","exports":"./index.js"}' > "$PKG/package.json"
echo 'export const pipeline = 1;' > "$PKG/index.js"
export STUB_RECORD="$BASE/installed.rec"
run_hook "$STUBS/bun:$PATH" "$ROOT"
assert_exit_code 0 "$RC" "installed path exits 0"
assert_eq "" "$OUT" "installed path prints nothing"
assert_eq "0" "$( [ -f "$STUB_RECORD" ] && wc -l < "$STUB_RECORD" | tr -d ' ' || echo 0)" "installed path invokes no installer"

test_case "missing: bun install runs once in the MCP dir with production flags"
ROOT=$(fake_root missing)
MCP="$ROOT/mcp/trajectory-server"
export STUB_RECORD="$BASE/missing.rec"
run_hook "$STUBS/bun:$PATH" "$ROOT"
wait_unlocked "$MCP"
assert_exit_code 0 "$RC" "missing path exits 0"
assert_contains "$OUT" '"hookEventName":"SessionStart"' "missing path emits a SessionStart notice"
assert_contains "$OUT" '"additionalContext"' "notice is additionalContext"
assert_contains "$OUT" "next Claude Code restart" "notice says embeddings go live on the next restart"
assert_eq "1" "$(wc -l < "$STUB_RECORD" | tr -d ' ')" "installer invoked exactly once"
IFS='|' read -r rec_cwd rec_args rec_bun_cache rec_npm_cache < "$STUB_RECORD"
assert_eq "$(cd "$MCP" && pwd -P)" "$(cd "$rec_cwd" && pwd -P)" "installer runs in mcp/trajectory-server"
assert_eq "install --production --ignore-scripts --no-save" "$rec_args" "bun gets production, no-scripts, no-save flags"
assert_eq "$PROJECT/.claude/tmb/cache/bun" "$rec_bun_cache" "bun cache goes to the project state dir"
assert_eq "$PROJECT/.claude/tmb/cache/npm" "$rec_npm_cache" "npm cache goes to the project state dir"
assert_contains "$(cat "$PROJECT/.claude/tmb/logs/mcp-deps-install.log")" "exit 0" "install is logged under <state>/logs"
assert_eq "no" "$( [ -d "$MCP/.deps-install.lock" ] && echo yes || echo no)" "lock released after the install"

test_case "install already running (lock held) → no second installer"
mkdir "$MCP/.deps-install.lock"
: > "$STUB_RECORD"
run_hook "$STUBS/bun:$PATH" "$ROOT"
sleep 0.5
assert_exit_code 0 "$RC" "held lock exits 0"
assert_eq "0" "$(wc -l < "$STUB_RECORD" | tr -d ' ')" "held lock invokes no installer"
rmdir "$MCP/.deps-install.lock"

test_case "no bun: npm fallback with production flags"
ROOT=$(fake_root npm)
MCP="$ROOT/mcp/trajectory-server"
export STUB_RECORD="$BASE/npm.rec"
run_hook "$STUBS/npm:$NO_PM_PATH" "$ROOT"
wait_unlocked "$MCP"
assert_exit_code 0 "$RC" "npm path exits 0"
assert_eq "1" "$(wc -l < "$STUB_RECORD" | tr -d ' ')" "npm invoked exactly once"
IFS='|' read -r rec_cwd rec_args _ _ < "$STUB_RECORD"
assert_eq "$(cd "$MCP" && pwd -P)" "$(cd "$rec_cwd" && pwd -P)" "npm runs in mcp/trajectory-server"
assert_eq "install --omit=dev --ignore-scripts --no-save --no-audit --no-fund" "$rec_args" "npm gets production, no-scripts, no-save flags"

test_case "no package manager → notice naming the manual command, exit 0"
ROOT=$(fake_root nopm)
run_hook "$NO_PM_PATH" "$ROOT"
assert_exit_code 0 "$RC" "no package manager exits 0"
assert_contains "$OUT" '"additionalContext"' "no package manager emits additionalContext"
assert_contains "$OUT" "bun install --production --ignore-scripts --no-save" "notice names the manual command"
assert_eq "no" "$( [ -d "$ROOT/mcp/trajectory-server/.deps-install.lock" ] && echo yes || echo no)" "no lock left behind"

test_case "TMB_SKIP_MCP_DEPS_INSTALL=1 → no-op"
ROOT=$(fake_root bypass)
export STUB_RECORD="$BASE/bypass.rec"
run_hook "$STUBS/bun:$PATH" "$ROOT" TMB_SKIP_MCP_DEPS_INSTALL=1
sleep 0.3
assert_exit_code 0 "$RC" "bypass exits 0"
assert_eq "" "$OUT" "bypass prints nothing"
assert_eq "no" "$( [ -f "$STUB_RECORD" ] && echo yes || echo no)" "bypass invokes no installer"

test_case "no CLAUDE_PLUGIN_ROOT → exit 0, no output"
export STUB_RECORD="$BASE/noroot.rec"
RC=0
OUT=$(echo '{}' | env -u CLAUDE_PLUGIN_ROOT PATH="$STUBS/bun:$PATH" bash "$HOOK" 2>&1) || RC=$?
sleep 0.3
assert_exit_code 0 "$RC" "no plugin root exits 0"
assert_eq "" "$OUT" "no plugin root prints nothing"
assert_eq "no" "$( [ -f "$STUB_RECORD" ] && echo yes || echo no)" "no plugin root invokes no installer"

summarize
