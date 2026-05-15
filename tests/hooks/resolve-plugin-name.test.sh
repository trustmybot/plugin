#!/usr/bin/env bash
# Tests for scripts/lib/resolve-plugin-name.sh::tmb_resolve_plugin_name.
#
# Case 1: manifest present with name "tmb"   → returns "tmb"
# Case 2: manifest present with name "tmb-rc" → returns "tmb-rc"
# Case 3: no manifest / CLAUDE_PLUGIN_ROOT unset → returns "tmb" (fallback)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/resolve-plugin-name.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ---- Case 1: manifest with name "tmb" ----------------------------------------

test_case "manifest name=tmb returns tmb"
FAKE_ROOT="$TMPDIR/plugin-stable"
mkdir -p "$FAKE_ROOT/.claude-plugin"
printf '{"name":"tmb","version":"0.6.0"}' > "$FAKE_ROOT/.claude-plugin/plugin.json"
result=$(CLAUDE_PLUGIN_ROOT="$FAKE_ROOT" bash -c ". '$LIB'; tmb_resolve_plugin_name")
assert_eq "tmb" "$result" "plugin name"

# ---- Case 2: manifest with name "tmb-rc" -------------------------------------

test_case "manifest name=tmb-rc returns tmb-rc"
FAKE_ROOT_RC="$TMPDIR/plugin-rc"
mkdir -p "$FAKE_ROOT_RC/.claude-plugin"
printf '{"name":"tmb-rc","version":"0.6.0-rc.7"}' > "$FAKE_ROOT_RC/.claude-plugin/plugin.json"
result=$(CLAUDE_PLUGIN_ROOT="$FAKE_ROOT_RC" bash -c ". '$LIB'; tmb_resolve_plugin_name")
assert_eq "tmb-rc" "$result" "plugin name"

# ---- Case 3: no manifest (CLAUDE_PLUGIN_ROOT unset) → fallback "tmb" --------

test_case "no manifest fallback returns tmb"
result=$(bash -c "unset CLAUDE_PLUGIN_ROOT; . '$LIB'; tmb_resolve_plugin_name")
assert_eq "tmb" "$result" "plugin name fallback"

# ---- Case 4: CLAUDE_PLUGIN_ROOT set but manifest missing → fallback "tmb" ---

test_case "CLAUDE_PLUGIN_ROOT set but missing manifest returns tmb"
FAKE_ROOT_EMPTY="$TMPDIR/plugin-empty"
mkdir -p "$FAKE_ROOT_EMPTY"
result=$(CLAUDE_PLUGIN_ROOT="$FAKE_ROOT_EMPTY" bash -c ". '$LIB'; tmb_resolve_plugin_name")
assert_eq "tmb" "$result" "plugin name fallback when manifest missing"

# ---- Case 5: manifest with missing name field → fallback "tmb" ---------------

test_case "manifest with no name field returns tmb"
FAKE_ROOT_NONAME="$TMPDIR/plugin-noname"
mkdir -p "$FAKE_ROOT_NONAME/.claude-plugin"
printf '{"version":"1.0.0"}' > "$FAKE_ROOT_NONAME/.claude-plugin/plugin.json"
result=$(CLAUDE_PLUGIN_ROOT="$FAKE_ROOT_NONAME" bash -c ". '$LIB'; tmb_resolve_plugin_name")
assert_eq "tmb" "$result" "plugin name fallback when name field absent"

summarize
