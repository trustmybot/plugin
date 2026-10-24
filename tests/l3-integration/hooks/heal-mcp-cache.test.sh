#!/usr/bin/env bash
# L3: scripts/maintenance/heal-mcp-cache.sh refuses to run inside Claude Code
# (GH 1533). With CLAUDE_PROJECT_DIR or CLAUDE_PLUGIN_ROOT set it exits non-zero
# with the quit-and-run-from-a-terminal message and leaves the fixture HOME's
# .claude.json byte-identical. A control run from a "terminal" (both unset)
# proves the fixture is one the script would otherwise edit.
# GH 1611: each channel (stable, rc, dev) resolves to its own cache dir,
# installed_plugins entry and the plugin:tmb:trajectory-server MCP key.
# GH 1675: --dry-run previews Steps A, B and C without prompting or writing.
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
OUT=$(run_heal 2>&1)
rc=$?
set -e
assert_eq "0" "$rc" "control exit"
assert_eq '["other"]' "$(jq -c '.projects["/work/demo"].disabledMcpServers' "$FAKE_HOME/.claude.json")" "control disabledMcpServers"

test_case "control: Step B skipped prints scoped uninstall + reinstall (stable → project)"
assert_contains "$OUT" "claude plugin uninstall tmb@trustmybot --scope project, then reinstall with: claude plugin install tmb@trustmybot --scope project" "scoped manual recovery"
assert_contains "$OUT" "INSTALL.md#recommended-scope-project-or-local" "scope rule link"

# ---- Channel targeting (GH 1611) ----------------------------------------------
# Each case seeds all three channel caches; only the targeted channel's cache,
# installed_plugins entry and MCP key may change.
new_home() {
  local h="$WORKSPACE/$1"
  local plugins="$2"
  mkdir -p "$h/.claude/plugins"
  for owner in trustmybot trustmybot-rc trustmybot-dev; do
    mkdir -p "$h/.claude/plugins/cache/$owner/tmb/1.0.0"
  done
  printf '{ "plugins": %s }\n' "$plugins" > "$h/.claude/plugins/installed_plugins.json"
  cat > "$h/.claude.json" <<'JSON'
{ "projects": { "/work/demo": { "disabledMcpServers": ["plugin:tmb:trajectory-server", "other"] } } }
JSON
  printf '%s' "$h"
}
caches_left() { (cd "$1/.claude/plugins/cache" && ls -1 | sort | tr '\n' ' '); }
entries_left() { jq -r '.plugins | keys | join(" ")' "$1/.claude/plugins/installed_plugins.json"; }
heal_in() {
  local h="$1"; shift
  printf 'y\ny\n' | env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_ROOT HOME="$h" bash "$SCRIPT" "$@" 2>&1
}

H=$(new_home rc-only '{ "tmb@trustmybot-rc": [ { "version": "1.0.0", "scope": "local" } ] }')
set +e; OUT=$(heal_in "$H"); rc=$?; set -e
test_case "rc auto-detected: exits 0"
assert_eq "0" "$rc" "exit; output: $OUT"
test_case "rc auto-detected: only cache/trustmybot-rc is removed"
assert_eq "trustmybot trustmybot-dev " "$(caches_left "$H")" "caches left"
test_case "rc auto-detected: entry tmb@trustmybot-rc is removed"
assert_eq "" "$(entries_left "$H")" "entries left"
assert_contains "$OUT" "claude plugin install tmb@trustmybot-rc --scope local" "reinstall hint"
test_case "rc auto-detected: Step A clears plugin:tmb:trajectory-server"
assert_eq '["other"]' "$(jq -c '.projects["/work/demo"].disabledMcpServers' "$H/.claude.json")" "disabledMcpServers"

H=$(new_home dev-flag '{ "tmb@trustmybot": [ { "version": "1.0.0", "scope": "project" } ], "tmb@trustmybot-dev": [ { "version": "1.0.0", "scope": "local" } ] }')
set +e; OUT=$(heal_in "$H" --channel dev); rc=$?; set -e
test_case "--channel dev: exits 0"
assert_eq "0" "$rc" "exit; output: $OUT"
test_case "--channel dev: only cache/trustmybot-dev is removed"
assert_eq "trustmybot trustmybot-rc " "$(caches_left "$H")" "caches left"
test_case "--channel dev: only entry tmb@trustmybot-dev is removed"
assert_eq "tmb@trustmybot" "$(entries_left "$H")" "entries left"
test_case "--channel dev: Step A clears plugin:tmb:trajectory-server"
assert_eq '["other"]' "$(jq -c '.projects["/work/demo"].disabledMcpServers' "$H/.claude.json")" "disabledMcpServers"

H=$(new_home two-channels '{ "tmb@trustmybot": [ { "version": "1.0.0" } ], "tmb@trustmybot-dev": [ { "version": "1.0.0" } ] }')
set +e; OUT=$(heal_in "$H"); rc=$?; set -e
test_case "two channels, no flag: exits 2 naming stable|rc|dev"
assert_eq "2" "$rc" "exit"
assert_contains "$OUT" "Pass --channel stable|rc|dev to choose." "help"
test_case "two channels, no flag: nothing removed"
assert_eq "trustmybot trustmybot-dev trustmybot-rc " "$(caches_left "$H")" "caches left"
assert_eq "tmb@trustmybot tmb@trustmybot-dev" "$(entries_left "$H")" "entries left"

H=$(new_home stable-b '{ "tmb@trustmybot": [ { "version": "1.0.0", "scope": "project" } ] }')
set +e; OUT=$(heal_in "$H"); rc=$?; set -e
test_case "stable Step B yes: exits 0"
assert_eq "0" "$rc" "exit; output: $OUT"
test_case "stable Step B yes: only cache/trustmybot is removed"
assert_eq "trustmybot-dev trustmybot-rc " "$(caches_left "$H")" "caches left"
test_case "stable Step B yes: entry tmb@trustmybot is gone from installed_plugins.json"
assert_eq "" "$(entries_left "$H")" "entries left"

# ---- --dry-run is a pure preview (GH 1675) ------------------------------------
# Every step has work to do; answering y to every prompt (or having no stdin)
# must still leave HOME untouched.
dry_home() {
  local h="$WORKSPACE/$1"
  mkdir -p "$h/.claude/plugins"
  for v in 1.0.0 1.1.0 1.2.0; do
    mkdir -p "$h/.claude/plugins/cache/trustmybot-dev/tmb/$v"
    printf 'x\n' > "$h/.claude/plugins/cache/trustmybot-dev/tmb/$v/plugin.json"
  done
  printf '{ "plugins": { "tmb@trustmybot-dev": [ { "version": "1.2.0", "scope": "local" } ] } }\n' > "$h/.claude/plugins/installed_plugins.json"
  cat > "$h/.claude.json" <<'JSON'
{ "projects": { "/work/demo": { "disabledMcpServers": ["plugin:tmb:trajectory-server", "other"] } } }
JSON
  printf '%s' "$h"
}
home_snapshot() {
  (cd "$1" && find . -print | sort && find . -type f -print0 | sort -z | xargs -0 cksum)
}

for stdin_mode in yes closed; do
  H=$(dry_home "dry-$stdin_mode")
  SNAP_BEFORE=$(home_snapshot "$H")
  touch "$WORKSPACE/dry-$stdin_mode.marker"
  set +e
  if [ "$stdin_mode" = yes ]; then
    OUT=$(printf 'y\n%.0s' 1 2 3 4 5 6 7 8 9 10 | env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_ROOT HOME="$H" bash "$SCRIPT" --channel dev --dry-run 2>&1)
  else
    OUT=$(env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_ROOT HOME="$H" bash "$SCRIPT" --channel dev --dry-run 2>&1 <&-)
  fi
  rc=$?
  set -e

  test_case "--dry-run (stdin $stdin_mode): exits 0"
  assert_eq "0" "$rc" "exit; output: $OUT"
  test_case "--dry-run (stdin $stdin_mode): HOME is identical before and after"
  assert_eq "$SNAP_BEFORE" "$(home_snapshot "$H")" "HOME snapshot"
  assert_eq "" "$(find "$H" -newer "$WORKSPACE/dry-$stdin_mode.marker" -print)" "nothing newer than marker"
  test_case "--dry-run (stdin $stdin_mode): previews Steps A, B and C"
  assert_contains "$OUT" "[dry-run] Step A would:" "Step A preview"
  assert_contains "$OUT" "[dry-run] Step C would: rm -rf $H/.claude/plugins/cache/trustmybot-dev/tmb/1.0.0" "Step C preview"
  assert_contains "$OUT" "[dry-run] Step B would: rm -rf $H/.claude/plugins/cache/trustmybot-dev;" "Step B preview"
  test_case "--dry-run (stdin $stdin_mode): never prompts"
  if printf '%s' "$OUT" | grep -q 'Proceed with'; then _fail "prompt shown; output: $OUT"; else _pass; fi
done

summarize
printf "PASS heal-mcp-cache\n"
