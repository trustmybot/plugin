#!/usr/bin/env bash
# L3: cheatcode uninstall stage.
#   scripts/cheatcode-uninstall.sh assembles the teardown payload from a fixture
#   (no live marketplace). JSON shape + kind-dependent method, plus the env-unset
#   default-path probe that lets the L6 chain reach the staged fixture.
# Network is stubbed via TMB_CHEATCODE_UNINSTALL_FIXTURE / the default file — no
# live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-uninstall.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

# ---------------------------------------------------------------------------
# Fixture-stubbed marketplace teardown (env var set).
# ---------------------------------------------------------------------------
FIXTURE="$WORKSPACE/uninstall.json"
cat > "$FIXTURE" <<'JSON'
{ "removed": true, "error": null }
JSON

OUT=$(TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf","tier":1}')

test_case "uninstall output is valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT"; fi

test_case "plugin kind removed via marketplace method"
assert_eq "marketplace" "$(printf '%s' "$OUT" | jq -r '.method')" "method"

test_case "plugin uninstall reports removed=true"
assert_eq "true" "$(printf '%s' "$OUT" | jq -r '.removed')" "removed"

test_case "mcp kind uses the mcp-deregister method"
OUT_MCP=$(TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"server","kind":"mcp","source_url":"https://x.test/mcp"}')
assert_eq "mcp-deregister" "$(printf '%s' "$OUT_MCP" | jq -r '.method')" "mcp method"

test_case "invalid kind fails non-zero"
set +e
bash "$SCRIPT" --candidate '{"name":"x","kind":"bad","source_url":"https://x"}' >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on bad kind"; fi

# Env-unset default-path probe: when TMB_CHEATCODE_UNINSTALL_FIXTURE is
# unset/empty the script falls back to "$PWD/.tmb-cheatcode-uninstall-fixture.json"
# (the path the row setup-l5.sh stages in the step's CWD) and uses it if present.
# Run from a CWD that holds the default-named file, with the env var explicitly
# unset.
PROBE_DIR="$WORKSPACE/probe"
mkdir -p "$PROBE_DIR"
cat > "$PROBE_DIR/.tmb-cheatcode-uninstall-fixture.json" <<'JSON'
{ "removed": true, "error": null }
JSON

OUT_PROBE=$(cd "$PROBE_DIR" && env -u TMB_CHEATCODE_UNINSTALL_FIXTURE bash "$SCRIPT" \
  --candidate '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}')

test_case "env unset + default fixture file present → fixture used"
assert_eq "true" "$(printf '%s' "$OUT_PROBE" | jq -r '.removed')" "probe removed"
assert_eq "marketplace" "$(printf '%s' "$OUT_PROBE" | jq -r '.method')" "probe method"

# Env-set still wins over the default file: with the env pointing at a DIFFERENT
# fixture (removed=false), the default file in CWD is ignored.
WINS_FIXTURE="$WORKSPACE/wins.json"
cat > "$WINS_FIXTURE" <<'JSON'
{ "removed": false, "error": "stub-not-removed" }
JSON

OUT_WINS=$(cd "$PROBE_DIR" && TMB_CHEATCODE_UNINSTALL_FIXTURE="$WINS_FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}')

test_case "env-set fixture wins over the default file in CWD"
assert_eq "false" "$(printf '%s' "$OUT_WINS" | jq -r '.removed')" "env wins removed"
assert_eq "stub-not-removed" "$(printf '%s' "$OUT_WINS" | jq -r '.error')" "env wins error"

# No env and no default file: the no-fixture path is unchanged. Use a skill kind
# (which never calls the marketplace) from a CWD with no default file so the probe
# misses and nothing is removed — fast and network-free.
NOFIX_DIR="$WORKSPACE/nofix"
mkdir -p "$NOFIX_DIR"
OUT_NOFIX=$(cd "$NOFIX_DIR" && env -u TMB_CHEATCODE_UNINSTALL_FIXTURE bash "$SCRIPT" \
  --candidate '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}')

test_case "no env + no default file → no-fixture path unchanged (not removed)"
assert_eq "false" "$(printf '%s' "$OUT_NOFIX" | jq -r '.removed')" "no-fixture removed"
assert_eq "skill-proposed-pr-revert" "$(printf '%s' "$OUT_NOFIX" | jq -r '.method')" "no-fixture method"

summarize
printf "PASS cheatcode-uninstall\n"
