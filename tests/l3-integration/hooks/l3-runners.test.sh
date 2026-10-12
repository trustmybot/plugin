#!/usr/bin/env bash
# Tests for the L3 runners (tests/l3-integration/hooks/run.sh and mcp/run.sh):
# the summary names each failing file with its last lines, verbose mode
# prints per-file durations, and the TMPDIR footprint assertion fires on a
# file a test leaves behind.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
HOOKS_RUNNER="$HERE/run.sh"
MCP_RUNNER="$HERE/../mcp/run.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAIL_DIR="$WORK/failing"
mkdir -p "$FAIL_DIR"
cat > "$FAIL_DIR/broken.test.sh" <<'EOF'
for i in $(seq 1 15); do echo "broken-line-$i"; done
echo "FAIL planted failure"
exit 1
EOF
cat > "$FAIL_DIR/fine.test.sh" <<'EOF'
echo "fine"
EOF

test_case "hooks runner: summary names the failing file with its last 10 lines"
rc=0
out=$(L3_HOOKS_TEST_DIR="$FAIL_DIR" bash "$HOOKS_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a failing file exits 1"
summary=$(printf '%s\n' "$out" | sed -n '/^Failing test files:/,$p')
assert_contains "$summary" "FAIL broken.test.sh — last 10 lines:" "summary names the failing file"
assert_contains "$summary" "broken-line-15" "summary carries the file's last lines"
assert_contains "$summary" "FAIL planted failure" "summary carries the file's final line"
assert_not_contains "$summary" "broken-line-6" "summary stops at the last 10 lines"
assert_not_contains "$summary" "fine.test.sh" "summary omits passing files"
assert_contains "$out" "FAIL files: broken.test.sh" "final line names the failing file"
assert_contains "$out" "1 of 2 hook test files had failures." "count line unchanged"

test_case "hooks runner: verbose mode prints per-file durations"
out=$(L3_HOOKS_TEST_DIR="$FAIL_DIR" bash "$HOOKS_RUNNER" -v 2>&1 || true)
assert_contains "$out" "duration fine.test.sh:" "verbose prints each file's duration"

LEAK_DIR="$WORK/leaking"
mkdir -p "$LEAK_DIR"
cat > "$LEAK_DIR/leaks.test.sh" <<'EOF'
touch "$TMPDIR/planted-leak"
EOF

test_case "hooks runner: TMPDIR assertion fires on a planted file"
rc=0
out=$(L3_HOOKS_TEST_DIR="$LEAK_DIR" bash "$HOOKS_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a file left in TMPDIR exits 1"
assert_contains "$out" "FAIL footprint: hook tests left files in TMPDIR:" "TMPDIR leak reported"
assert_contains "$out" "\$TMPDIR/planted-leak" "the planted file is named"
assert_contains "$out" "footprint: HOME untouched by the hook suite" "the TMPDIR under HOME is not a HOME leak"

PASS_DIR="$WORK/passing"
mkdir -p "$PASS_DIR"
cp "$FAIL_DIR/fine.test.sh" "$PASS_DIR/"

test_case "hooks runner: a clean suite passes every footprint check"
rc=0
out=$(L3_HOOKS_TEST_DIR="$PASS_DIR" bash "$HOOKS_RUNNER" 2>&1) || rc=$?
assert_eq "0" "$rc" "a clean suite exits 0"
assert_contains "$out" "footprint: TMPDIR left clean by the hook suite" "TMPDIR check reported"
assert_contains "$out" "footprint: /tmp gained no tmb*/claude* entries" "/tmp check reported"

cat > "$WORK/broken.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
test('planted mcp failure', () => { assert.equal('planted-actual', 'planted-expected'); });
EOF
cat > "$WORK/leak.test.sh" <<'EOF'
touch "$TMPDIR/planted-mcp-leak"
EOF

test_case "mcp runner: summary names the failing node test file with its lines"
rc=0
out=$(L3_MCP_TEST_FILES="$WORK/broken.test.mjs" L3_MCP_TEST_SCRIPTS="" bash "$MCP_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a failing node test file exits 1"
summary=$(printf '%s\n' "$out" | sed -n '/^Failing test files:/,$p')
assert_contains "$summary" "FAIL broken.test.mjs — last 10 lines:" "summary names the failing file"
assert_contains "$summary" "planted mcp failure" "summary carries the failing test's lines"
assert_contains "$out" "FAIL files: broken.test.mjs" "final line names the failing file"

test_case "mcp runner: TMPDIR assertion fires on a planted file"
rc=0
out=$(L3_MCP_TEST_FILES="$WORK/broken.test.mjs" L3_MCP_TEST_SCRIPTS="$WORK/leak.test.sh" bash "$MCP_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a file left in TMPDIR exits 1"
assert_contains "$out" "FAIL footprint: the L3 MCP suite left files in TMPDIR:" "TMPDIR leak reported"
assert_contains "$out" "\$TMPDIR/planted-mcp-leak" "the planted file is named"

summarize
