#!/usr/bin/env bash
# Tests for scripts/lib/resolve-hook.sh — the headless-shim resolver, which
# execs the resolved version's router,
# node mcp/trajectory-server/dist/hooks.js <Event> [part] [--shim].
#   - plain mode runs the router with the event, stdin forwarded
#   - --part passes the part; --shim passes --shim and exports
#     TMB_SHIM_PROJECT (the project's physical path)
#   - through the real router: --shim yields when
#     <project>/.claude/<plugin>/sessions/<sid>.plugin-hooks exists or
#     CLAUDE_PROJECT_DIR is another project, and decides otherwise
#   - a --hook that names a gate (an earlier /onboard's entry), a missing node
#     or a version without dist/hooks.js fails open, loudly
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
RESOLVER="$PLUGIN_ROOT/scripts/lib/resolve-hook.sh"
NODE_BIN="$(command -v node)"

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-resolve-hook.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
# Without CLAUDE_PROJECT_DIR the trajectory DB is found by walking up from cwd;
# start outside any checkout so no real project state is resolved.
cd "$TMP"
unset CLAUDE_PROJECT_DIR TMB_SHIM_PROJECT

export CLAUDE_CONFIG_DIR="$TMP/claude"
VERSION_ROOT="$CLAUDE_CONFIG_DIR/plugins/cache/mp/tmb/1.0.0"
mkdir -p "$VERSION_ROOT/mcp/trajectory-server/dist" "$VERSION_ROOT/.claude-plugin"
printf '{"name":"tmb"}\n' > "$VERSION_ROOT/.claude-plugin/plugin.json"
FIRED="$TMP/fired.log"
cat > "$VERSION_ROOT/mcp/trajectory-server/dist/hooks.js" <<EOF
const { appendFileSync, readFileSync } = require('node:fs');
const input = readFileSync(0, 'utf8');
appendFileSync('$FIRED', JSON.stringify({ argv: process.argv.slice(2), shimProject: process.env.TMB_SHIM_PROJECT ?? null, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, input }) + '\n');
process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe"}}\n');
EOF

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude/tmb/sessions"
ln -s "$PROJECT" "$TMP/project-link"
PAYLOAD='{"session_id":"sess-1","tool_name":"Bash"}'

fired_count() { [ -f "$FIRED" ] && wc -l < "$FIRED" | tr -d ' ' || echo 0; }
last_fired() { tail -1 "$FIRED" | jq -c "$1"; }

run() {
  printf '%s' "$PAYLOAD" | bash "$RESOLVER" "$@"
}

test_case "plain mode runs the router for the event, stdin forwarded"
out=$(run --marketplace mp --hook PreToolUse)
assert_contains "$out" '"permissionDecision":"deny"' "router decision forwarded"
assert_eq "1" "$(fired_count)" "router ran once"
assert_eq '["PreToolUse"]' "$(last_fired .argv)" "argv is the event alone"
assert_eq 'null' "$(last_fired .shimProject)" "no TMB_SHIM_PROJECT outside --shim"
assert_eq "\"$VERSION_ROOT\"" "$(last_fired .pluginRoot)" "CLAUDE_PLUGIN_ROOT is the resolved version"
assert_contains "$(last_fired .input)" 'sess-1' "stdin forwarded to the router"

test_case "--shim --part passes the part and --shim, with the project's physical path"
out=$(run --marketplace mp --hook PreToolUse --part guard --shim --project "$TMP/project-link")
assert_contains "$out" '"permissionDecision":"deny"' "router decision forwarded"
assert_eq '["PreToolUse","guard","--shim"]' "$(last_fired .argv)" "argv: event, part, --shim"
assert_eq "\"$(cd "$PROJECT" && pwd -P)\"" "$(last_fired .shimProject)" "TMB_SHIM_PROJECT exported, symlink resolved"

test_case "a --hook naming a gate (an earlier /onboard's entry) fails open, loudly"
rc=0
err=$(run --marketplace mp --hook git-guards --shim --project "$PROJECT" 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_contains "$err" "not a hook event" "stderr names the stale entry"
assert_contains "$err" "re-run /onboard" "stderr names the fix"
assert_eq "2" "$(fired_count)" "router not run"

test_case "node missing on PATH fails open, loudly"
NODELESS="$TMP/nodeless-bin"
mkdir -p "$NODELESS"
for tool in bash jq find sort tail basename dirname cat; do
  src=$(command -v "$tool" || true)
  [ -n "$src" ] && ln -sf "$src" "$NODELESS/$tool"
done
rc=0
err=$(printf '%s' "$PAYLOAD" | PATH="$NODELESS" "$NODELESS/bash" "$RESOLVER" --marketplace mp --hook PreToolUse 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_contains "$err" "node not found" "stderr names the missing node"
assert_contains "$err" "failing OPEN" "stderr says it fails open"
assert_eq "2" "$(fired_count)" "router not run"

test_case "resolved version without dist/hooks.js fails open, loudly"
rm "$VERSION_ROOT/mcp/trajectory-server/dist/hooks.js"
rc=0
err=$(run --marketplace mp --hook PreToolUse 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_contains "$err" "no router" "stderr names the missing router"
assert_eq "2" "$(fired_count)" "router not run"

# The real router: the resolved version is this checkout.
REAL_HOME="$TMP/real-claude"
mkdir -p "$REAL_HOME/plugins"
jq -n --arg p "$PLUGIN_ROOT" '{version: 2, plugins: {"tmb@real": [{scope: "user", installPath: $p}]}}' > "$REAL_HOME/plugins/installed_plugins.json"
AUQ='{"hook_event_name":"PreToolUse","session_id":"sess-real","tool_use_id":"tu-real","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"q","multiSelect":false,"options":[{"label":"one two three four five six seven eight"}]}]}}'
real() {
  printf '%s' "$AUQ" | CLAUDE_CONFIG_DIR="$REAL_HOME" TMB_INSTALLED_JSON="$TMP/none.json" PATH="$(dirname "$NODE_BIN"):$PATH" bash "$RESOLVER" --marketplace real --hook PreToolUse --shim --project "$PROJECT"
}

test_case "real router under --shim decides a headless session"
out=$(real)
assert_contains "$out" "label is 8 words" "the group's gates ran"
out=$(CLAUDE_PROJECT_DIR="$PROJECT" real)
assert_contains "$out" "label is 8 words" "this project's CLAUDE_PROJECT_DIR runs the gates"

test_case "real router under --shim yields to the plugin-hooks marker"
: > "$PROJECT/.claude/tmb/sessions/sess-real.plugin-hooks"
rc=0
out=$(real) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_eq "" "$out" "no decision"
rm "$PROJECT/.claude/tmb/sessions/sess-real.plugin-hooks"

test_case "real router under --shim yields for a foreign CLAUDE_PROJECT_DIR"
mkdir -p "$TMP/other"
rc=0
out=$(CLAUDE_PROJECT_DIR="$TMP/other" real) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_eq "" "$out" "no decision"

summarize
