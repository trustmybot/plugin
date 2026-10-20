#!/usr/bin/env bash
# L3: scripts/maintenance/heal-mcp-cache.sh refuses to run inside Claude Code
# (GH 1533). With CLAUDE_PROJECT_DIR or CLAUDE_PLUGIN_ROOT set it exits non-zero
# with the quit-and-run-from-a-terminal message and leaves the fixture HOME's
# .claude.json byte-identical. A control run from a "terminal" (both unset)
# proves the fixture is one the script would otherwise edit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/maintenance/heal-mcp-cache.sh"

command -v jq >/dev/null 2>&1 || { printf "FAIL jq not found — required dependency for this test\n"; exit 1; }

WORKSPACE=$(mktemp -d "$PLUGIN_ROOT/.heal-mcp-cache-test.XXXXXX")
trap 'rm -rf "$WORKSPACE"' EXIT

FAKE_HOME="$WORKSPACE/home"
mkdir -p "$FAKE_HOME/.claude/plugins"
cat > "$FAKE_HOME/.claude/plugins/installed_plugins.json" <<'JSON'
{ "plugins": { "tmb@trustmybot": [ { "version": "1.0.0" } ] } }
JSON
cat > "$FAKE_HOME/.claude.json" <<'JSON'
{ "projects": { "/work/demo": { "disabledMcpServers": ["plugin:tmb:trajectory-server", "other"] } } }
JSON
cp -p "$FAKE_HOME/.claude.json" "$WORKSPACE/claude.json.orig"
home_listing() { (cd "$FAKE_HOME" && find . | sort); }
LISTING_BEFORE=$(home_listing)

# Answers yes to Step A, so a script that did not refuse would edit .claude.json.
run_heal() {
  printf 'y\nn\n' | env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_ROOT HOME="$FAKE_HOME" "$@" bash "$SCRIPT"
}

for var in CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT; do
  set +e
  OUT=$(run_heal "$var=$WORKSPACE/project" 2>&1)
  rc=$?
  set -e

  test_case "$var set: exits non-zero"
  if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit, got 0; output: $OUT"; fi

  test_case "$var set: tells the user to quit and run from a terminal"
  assert_contains "$OUT" "Refusing to run inside Claude Code" "refusal"
  assert_contains "$OUT" "Quit Claude Code first, then run it from a regular terminal." "quit message"

  test_case "$var set: .claude.json is byte-identical"
  if cmp -s "$WORKSPACE/claude.json.orig" "$FAKE_HOME/.claude.json"; then _pass; else _fail ".claude.json changed"; fi

  test_case "$var set: nothing created or removed under HOME"
  assert_eq "$LISTING_BEFORE" "$(home_listing)" "HOME listing"
done

test_case "control: run from a terminal, the same fixture is edited (Step A yes, Step B no)"
set +e
run_heal >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "$rc" "control exit"
assert_eq '["other"]' "$(jq -c '.projects["/work/demo"].disabledMcpServers' "$FAKE_HOME/.claude.json")" "control disabledMcpServers"

summarize
printf "PASS heal-mcp-cache\n"
