#!/usr/bin/env bash
# Tests for scripts/hooks/substrate-preflight.sh — the SessionStart hook that
# emits a TMB DEGRADED banner when required host binaries are missing.
#
# Coverage:
#   1. Healthy host (all 4 present): exits 0, no output
#   2. Degraded: jq missing — emits TMB DEGRADED containing "jq"
#   3. Degraded: sqlite3 missing — emits TMB DEGRADED containing "sqlite3"
#   4. Degraded: multiple binaries missing — all named in one message
#   5. Output is valid JSON when degraded
#   6. Schema: hookSpecificOutput.hookEventName = "SessionStart"
#   7. Self-contained: banner produced even when jq is the missing binary
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/substrate-preflight.sh"

STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

_make_stub_dir_with() {
  local dir
  dir=$(mktemp -d -p "$STUB_DIR")
  for bin in "$@"; do
    local real
    real=$(command -v "$bin" 2>/dev/null || true)
    if [ -n "$real" ]; then
      ln -s "$real" "$dir/$bin"
    fi
  done
  printf '%s' "$dir"
}

run_hook_with_path() {
  local path="$1"
  echo '{}' | PATH="$path" /bin/bash "$HOOK" 2>/dev/null || true
}

# ============================================================================
# Case 1 — Healthy host: all 4 present, silent exit 0
# ============================================================================
test_case "healthy host: exits 0 with no output"
out=$(echo '{}' | /bin/bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out" "no output when all binaries present"

test_case "healthy host: exit code is 0"
exit_code=0
echo '{}' | /bin/bash "$HOOK" >/dev/null 2>&1 || exit_code=$?
assert_eq "0" "$exit_code" "exit code"

# ============================================================================
# Case 2 — jq missing: emits TMB DEGRADED mentioning jq
# ============================================================================
test_case "jq missing: emits TMB DEGRADED"
stub2=$(_make_stub_dir_with sqlite3 git node)
out2=$(run_hook_with_path "$stub2")
assert_contains "$out2" "TMB DEGRADED" "DEGRADED banner present"

test_case "jq missing: banner names jq"
assert_contains "$out2" "jq" "jq named in banner"

# ============================================================================
# Case 3 — sqlite3 missing: emits TMB DEGRADED mentioning sqlite3
# ============================================================================
test_case "sqlite3 missing: emits TMB DEGRADED"
stub3=$(_make_stub_dir_with jq git node)
out3=$(run_hook_with_path "$stub3")
assert_contains "$out3" "TMB DEGRADED" "DEGRADED banner present"

test_case "sqlite3 missing: banner names sqlite3"
assert_contains "$out3" "sqlite3" "sqlite3 named in banner"

# ============================================================================
# Case 4 — multiple binaries missing: all named in one message
# ============================================================================
test_case "multiple missing: both jq and git named"
stub4=$(_make_stub_dir_with sqlite3 node)
out4=$(run_hook_with_path "$stub4")
assert_contains "$out4" "jq" "jq named when multiple missing"
assert_contains "$out4" "git" "git named when multiple missing"

# ============================================================================
# Case 5 — degraded output is valid JSON
# ============================================================================
test_case "degraded output is valid JSON"
if echo "$out2" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "degraded stdout failed jq parse — output was: $out2"
fi

# ============================================================================
# Case 6 — schema: hookEventName = "SessionStart"
# ============================================================================
test_case "schema: hookEventName is SessionStart"
ev=$(echo "$out2" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "SessionStart" "$ev" "hookSpecificOutput.hookEventName"

test_case "schema: additionalContext is a string"
ctx_type=$(echo "$out2" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

# ============================================================================
# Case 7 — self-contained: banner produced even when jq is the missing binary
#          (hook must not depend on jq to emit its own JSON output)
# ============================================================================
test_case "self-contained: TMB DEGRADED emitted when jq is absent"
assert_contains "$out2" "TMB DEGRADED" "banner produced without jq on PATH"

test_case "self-contained: output is non-empty when jq is absent"
if [ -n "$out2" ]; then
  _pass
else
  _fail "output was empty — hook depends on jq for its own output"
fi

summarize
