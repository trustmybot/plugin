#!/usr/bin/env bash
# L3: cheatcode uninstall stage (#676).
#   scripts/cheatcode-uninstall.sh reverses an install from a fixture (no live
#   marketplace). JSON shape + kind-dependent teardown method + soft-degrade.
# Network is stubbed via TMB_CHEATCODE_UNINSTALL_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-uninstall.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

# ---------------------------------------------------------------------------
# Plugin kind — marketplace uninstall reversed via the fixture.
# ---------------------------------------------------------------------------
FIXTURE="$WORKSPACE/uninstall.json"
cat > "$FIXTURE" <<'JSON'
{ "removed": true, "error": null }
JSON

OUT=$(TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf","tier":1}')

test_case "uninstall output is valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT"; fi

test_case "plugin kind reversed via marketplace method"
assert_eq "marketplace" "$(printf '%s' "$OUT" | jq -r '.method')" "method"

test_case "plugin uninstall reports removed=true"
assert_eq "true" "$(printf '%s' "$OUT" | jq -r '.removed')" "removed"

test_case "plugin uninstall has no error"
assert_eq "null" "$(printf '%s' "$OUT" | jq -r '.error')" "error"

test_case "uninstall echoes the candidate source_url"
assert_eq "https://x.test/pdf" "$(printf '%s' "$OUT" | jq -r '.candidate.source_url')" "candidate.source_url"

# ---------------------------------------------------------------------------
# MCP kind — deregister method.
# ---------------------------------------------------------------------------
OUT_MCP=$(TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-mcp","kind":"mcp","source_url":"https://x.test/pdf-mcp"}')

test_case "mcp kind reversed via mcp-deregister method"
assert_eq "mcp-deregister" "$(printf '%s' "$OUT_MCP" | jq -r '.method')" "mcp method"

# ---------------------------------------------------------------------------
# Skill kind with no fixture — nothing was written to agent md, nothing to
# reverse at the marketplace; soft-degrade to removed=false, never a crash.
# ---------------------------------------------------------------------------
OUT_SKILL=$(bash "$SCRIPT" \
  --candidate '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}')

test_case "skill kind uses the skill-proposed-pr-revert method"
assert_eq "skill-proposed-pr-revert" "$(printf '%s' "$OUT_SKILL" | jq -r '.method')" "skill method"

test_case "skill kind reverses nothing at the marketplace"
assert_eq "false" "$(printf '%s' "$OUT_SKILL" | jq -r '.removed')" "skill removed"

# ---------------------------------------------------------------------------
# Failure surface from the fixture degrades soft (removed=false + error note).
# ---------------------------------------------------------------------------
FAIL_FIXTURE="$WORKSPACE/uninstall-fail.json"
cat > "$FAIL_FIXTURE" <<'JSON'
{ "removed": false, "error": "marketplace uninstall failed (exit 1)" }
JSON

OUT_FAIL=$(TMB_CHEATCODE_UNINSTALL_FIXTURE="$FAIL_FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf"}')

test_case "failed marketplace uninstall degrades soft (removed=false + error)"
assert_eq "false" "$(printf '%s' "$OUT_FAIL" | jq -r '.removed')" "removed=false"
assert_contains "$(printf '%s' "$OUT_FAIL" | jq -r '.error')" "failed" "error note"

test_case "invalid kind fails non-zero"
set +e
bash "$SCRIPT" --candidate '{"name":"x","kind":"bad","source_url":"https://x"}' >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on bad kind"; fi

test_case "missing source_url fails non-zero"
set +e
bash "$SCRIPT" --candidate '{"name":"x","kind":"plugin"}' >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on missing source_url"; fi

summarize
printf "PASS cheatcode-uninstall\n"
