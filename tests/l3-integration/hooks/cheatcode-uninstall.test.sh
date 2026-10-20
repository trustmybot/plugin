#!/usr/bin/env bash
# L3: cheatcode uninstall stage.
#   scripts/cheatcode-uninstall.sh assembles the teardown payload from a fixture
#   (no live marketplace). JSON shape + kind-dependent method, plus the env-unset
#   default-path probe that lets the L6 chain reach the staged fixture.
# Network is stubbed via TMB_CHEATCODE_UNINSTALL_FIXTURE / the default file, or a
# claude PATH shim that records argv — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-uninstall.sh"

command -v jq >/dev/null 2>&1 || { printf "FAIL jq not found — required dependency for this security-gate test\n"; exit 1; }

WORKSPACE=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-cheatcode-uninstall.XXXXXX")
trap 'rm -rf "$WORKSPACE"' EXIT
export TMB_PROJECT_ROOT="$WORKSPACE/project"
mkdir -p "$TMB_PROJECT_ROOT"

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

test_case "TMB_PROJECT_ROOT unset fails non-zero with a clear message"
set +e
ERR_NOROOT=$(env -u TMB_PROJECT_ROOT TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf"}' 2>&1 >/dev/null)
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit with TMB_PROJECT_ROOT unset"; fi
assert_contains "$ERR_NOROOT" "TMB_PROJECT_ROOT is unset" "unset-root message"

# Env-unset default-path probe: when TMB_CHEATCODE_UNINSTALL_FIXTURE is
# unset/empty the script falls back to
# "$TMB_PROJECT_ROOT/.tmb-cheatcode-uninstall-fixture.json" (the path the row
# setup-l5.sh stages in the project) and uses it if present. Run from an
# unrelated cwd with TMB_PROJECT_ROOT at the dir holding the file.
OTHER_CWD="$WORKSPACE/other"
mkdir -p "$OTHER_CWD"
PROBE_DIR="$WORKSPACE/probe"
mkdir -p "$PROBE_DIR"
cat > "$PROBE_DIR/.tmb-cheatcode-uninstall-fixture.json" <<'JSON'
{ "removed": true, "error": null }
JSON

OUT_PROBE=$(cd "$OTHER_CWD" && TMB_PROJECT_ROOT="$PROBE_DIR" env -u TMB_CHEATCODE_UNINSTALL_FIXTURE bash "$SCRIPT" \
  --candidate '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}')

test_case "env unset + default fixture file present → fixture used"
assert_eq "true" "$(printf '%s' "$OUT_PROBE" | jq -r '.removed')" "probe removed"
assert_eq "marketplace" "$(printf '%s' "$OUT_PROBE" | jq -r '.method')" "probe method"

test_case "a default fixture in the caller cwd (not the project) is ignored"
OUT_CWD_FIX=$(cd "$PROBE_DIR" && env -u TMB_CHEATCODE_UNINSTALL_FIXTURE bash "$SCRIPT" \
  --candidate '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}')
assert_eq "false" "$(printf '%s' "$OUT_CWD_FIX" | jq -r '.removed')" "cwd fixture ignored"

# Env-set still wins over the default file: with the env pointing at a DIFFERENT
# fixture (removed=false), the default file in the project is ignored.
WINS_FIXTURE="$WORKSPACE/wins.json"
cat > "$WINS_FIXTURE" <<'JSON'
{ "removed": false, "error": "stub-not-removed" }
JSON

OUT_WINS=$(TMB_PROJECT_ROOT="$PROBE_DIR" TMB_CHEATCODE_UNINSTALL_FIXTURE="$WINS_FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}')

test_case "env-set fixture wins over the default file in the project"
assert_eq "false" "$(printf '%s' "$OUT_WINS" | jq -r '.removed')" "env wins removed"
assert_eq "stub-not-removed" "$(printf '%s' "$OUT_WINS" | jq -r '.error')" "env wins error"

# No env and no default file: the no-fixture path is unchanged. Use a skill kind
# (which never calls the marketplace) with a project holding no default file so
# the probe misses and nothing is removed — fast and network-free.
NOFIX_DIR="$WORKSPACE/nofix"
mkdir -p "$NOFIX_DIR"
OUT_NOFIX=$(TMB_PROJECT_ROOT="$NOFIX_DIR" env -u TMB_CHEATCODE_UNINSTALL_FIXTURE bash "$SCRIPT" \
  --candidate '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}')

test_case "no env + no default file → no-fixture path unchanged (not removed)"
assert_eq "false" "$(printf '%s' "$OUT_NOFIX" | jq -r '.removed')" "no-fixture removed"
assert_eq "skill-proposed-pr-revert" "$(printf '%s' "$OUT_NOFIX" | jq -r '.method')" "no-fixture method"

# ---------------------------------------------------------------------------
# Live adapters through a claude PATH shim that records each call's argv, one
# line per call: both teardowns run with --scope project (GH 1533).
# ---------------------------------------------------------------------------
SHIM_DIR="$WORKSPACE/shim"
ARGV_LOG="$WORKSPACE/claude-argv.log"
PWD_LOG="$WORKSPACE/claude-pwd.log"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLAUDE_ARGV_LOG"
pwd -P >> "$CLAUDE_PWD_LOG"
exit 0
SH
chmod +x "$SHIM_DIR/claude"
LIVE_CWD="$WORKSPACE/live"
mkdir -p "$LIVE_CWD"

run_live() {
  : > "$ARGV_LOG"
  : > "$PWD_LOG"
  (cd "$LIVE_CWD" && env -u TMB_CHEATCODE_UNINSTALL_FIXTURE \
    PATH="$SHIM_DIR:$PATH" CLAUDE_ARGV_LOG="$ARGV_LOG" CLAUDE_PWD_LOG="$PWD_LOG" bash "$SCRIPT" "$@")
}
PROJECT_REAL=$(cd "$TMB_PROJECT_ROOT" && pwd -P)

test_case "plugin kind: claude plugin uninstall runs with --scope project --keep-data"
OUT_LIVE=$(run_live --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf"}')
assert_eq "true" "$(printf '%s' "$OUT_LIVE" | jq -r '.removed')" "live plugin removed"
assert_eq "plugin uninstall pdf-plugin --scope project --keep-data" "$(cat "$ARGV_LOG")" "plugin argv"
assert_eq "$PROJECT_REAL" "$(cat "$PWD_LOG")" "plugin claude cwd"

test_case "mcp kind: claude mcp remove runs with --scope project"
OUT_MCP_LIVE=$(run_live --candidate '{"name":"pdf-mcp","kind":"mcp","source_url":"https://x.test/pdf-mcp"}')
assert_eq "true" "$(printf '%s' "$OUT_MCP_LIVE" | jq -r '.removed')" "live mcp removed"
assert_eq "mcp remove pdf-mcp --scope project" "$(cat "$ARGV_LOG")" "mcp argv"
assert_eq "$PROJECT_REAL" "$(cat "$PWD_LOG")" "mcp claude cwd"

summarize
printf "PASS cheatcode-uninstall\n"
