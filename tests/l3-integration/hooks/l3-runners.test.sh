#!/usr/bin/env bash
# Tests for the L3 runners (tests/l3-integration/hooks/run.sh and mcp/run.sh):
# the summary names each failing file with its last lines, verbose mode
# prints per-file durations, the TMPDIR footprint assertion fires on a file a
# test leaves behind, and the /tmp check fails only on entries named for the
# run itself — another session's entries are a warning — and the sqlite3 shim
# refuses the real project's .claude/tmb/ (failing the run) while passing every
# other call through.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
HOOKS_RUNNER="$HERE/run.sh"
MCP_RUNNER="$HERE/../mcp/run.sh"

WORK=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-l3-runners.XXXXXX")
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
assert_contains "$out" "footprint: /tmp gained no entries from this run" "/tmp check reported"

SLOW_DIR="$WORK/slow"
mkdir -p "$SLOW_DIR"
cat > "$SLOW_DIR/slow.test.sh" <<'EOF'
sleep 2
EOF
FOREIGN="/tmp/tmb-foreign-$$"
FOREIGN_CWD="/tmp/claude-f00d$$-cwd"
cleanup_foreign() { rm -rf "$FOREIGN" "$FOREIGN_CWD" /tmp/tmb-l3-*-leak-$$ 2>/dev/null || true; }
trap 'cleanup_foreign; rm -rf "$WORK"' EXIT

test_case "hooks runner: another session's /tmp entries during the run do not fail it"
rc=0
L3_HOOKS_TEST_DIR="$SLOW_DIR" bash "$HOOKS_RUNNER" > "$WORK/concurrent.out" 2>&1 &
runner=$!
sleep 1
mkdir "$FOREIGN"
touch "$FOREIGN_CWD"
wait "$runner" || rc=$?
out=$(cat "$WORK/concurrent.out")
cleanup_foreign
assert_eq "0" "$rc" "a concurrent foreign tmb-* entry does not fail the run"
assert_contains "$out" "warning: /tmp gained entries not named for this run" "foreign growth is a warning"
assert_contains "$out" "$FOREIGN" "the foreign entry is named in the warning"
assert_not_contains "$out" "$FOREIGN_CWD" "claude-*-cwd entries are not counted"
assert_contains "$out" "footprint: /tmp gained no entries from this run" "the run's own check still passes"

OWN_DIR="$WORK/own-leak"
mkdir -p "$OWN_DIR"
printf 'mkdir "/tmp/$TMB_TEST_RUN_ID-leak-%s"\n' "$$" > "$OWN_DIR/own.test.sh"

test_case "hooks runner: a /tmp entry named for the run fails it"
rc=0
out=$(L3_HOOKS_TEST_DIR="$OWN_DIR" bash "$HOOKS_RUNNER" 2>&1) || rc=$?
cleanup_foreign
assert_eq "1" "$rc" "the run's own /tmp leak exits 1"
assert_contains "$out" "FAIL footprint: the hook suite left entries in /tmp:" "own leak reported"
assert_contains "$out" "-leak-$$" "the leaked entry is named"

CHECKOUT="$(cd "$HERE/../../.." && pwd -P)"
SHIM_DIR="$WORK/live-db"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/probe.test.sh" <<EOF
sqlite3 :memory: 'select 41 + 1'
sqlite3 -readonly "$CHECKOUT/.claude/tmb/shim-probe.db" 'select 1' || echo "probe refused"
EOF

test_case "hooks runner: the sqlite3 shim refuses the real project DB dir and fails the run"
rc=0
out=$(L3_HOOKS_TEST_DIR="$SHIM_DIR" bash "$HOOKS_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a refused sqlite3 call exits 1"
assert_contains "$out" "42" "other sqlite3 calls pass through to the real binary"
assert_contains "$out" "sqlite3-shim: refused $CHECKOUT/.claude/tmb/shim-probe.db" "the refusal is printed to the test"
assert_contains "$out" "probe refused" "the refused call exits non-zero"
assert_contains "$out" "FAIL live DB: the hook suite ran sqlite3 against the real project DB (1 refusals" "the runner fails with the refusal list"

test_case "hooks runner: a suite with no refusals reports zero"
out=$(L3_HOOKS_TEST_DIR="$PASS_DIR" bash "$HOOKS_RUNNER" 2>&1 || true)
assert_contains "$out" "live DB: 0 sqlite3 refusals from the hook suite" "zero refusals reported"

cat > "$WORK/broken.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
test('planted mcp failure', () => { assert.equal('planted-actual', 'planted-expected'); });
EOF
cat > "$WORK/leak.test.sh" <<'EOF'
touch "$TMPDIR/planted-mcp-leak"
EOF
cat > "$WORK/slow.test.mjs" <<'EOF'
import { test } from 'node:test';
test('slow pass', async () => { await new Promise((r) => setTimeout(r, 2500)); });
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

test_case "mcp runner: a concurrent foreign entry is a warning, a TMPDIR leak still fails"
rc=0
L3_MCP_TEST_FILES="$WORK/slow.test.mjs" L3_MCP_TEST_SCRIPTS="$WORK/leak.test.sh" bash "$MCP_RUNNER" > "$WORK/mcp-concurrent.out" 2>&1 &
runner=$!
sleep 1
mkdir "$FOREIGN"
wait "$runner" || rc=$?
out=$(cat "$WORK/mcp-concurrent.out")
cleanup_foreign
assert_eq "1" "$rc" "the TMPDIR leak still fails the run"
assert_contains "$out" "FAIL footprint: the L3 MCP suite left files in TMPDIR:" "TMPDIR leak reported"
assert_contains "$out" "warning: /tmp gained entries not named for this run" "foreign growth is a warning"
assert_contains "$out" "footprint: /tmp gained no entries from this run" "no own /tmp leak"

test_case "mcp runner: the sqlite3 shim refuses the real project DB dir and fails the run"
rc=0
out=$(L3_MCP_TEST_FILES="$WORK/slow.test.mjs" L3_MCP_TEST_SCRIPTS="$SHIM_DIR/probe.test.sh" bash "$MCP_RUNNER" 2>&1) || rc=$?
assert_eq "1" "$rc" "a refused sqlite3 call exits 1"
assert_contains "$out" "FAIL live DB: the L3 MCP suite ran sqlite3 against the real project DB (1 refusals" "the runner fails with the refusal list"

summarize
