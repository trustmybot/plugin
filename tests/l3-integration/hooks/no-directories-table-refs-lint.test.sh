#!/usr/bin/env bash
# Self-test for tests/l1-lint/no-directories-table-refs.sh (GH 2134).
#
# The lint passes on the plugin tree and fails on a new file holding
# directories-table DML. Its bundle exemptions are exact paths: a listed bundle
# passes, and an unlisted bundle under the same dist/ directories fails.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LINT="$PLUGIN_ROOT/tests/l1-lint/no-directories-table-refs.sh"

SB=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-no-directories-lint.XXXXXX")" && pwd -P)
trap 'rm -rf "$SB"' EXIT

# Split so this test is not itself a hit for the lint it exercises.
DML="INSERT INTO ""directories (path) VALUES ('x');"

# fixture <name> [rel path...] — a root holding the lint and each path with the
# DML; prints the lint's path inside that root.
fixture() {
  local root="$SB/$1" rel
  shift
  mkdir -p "$root/tests/l1-lint"
  cp "$LINT" "$root/tests/l1-lint/no-directories-table-refs.sh"
  for rel in "$@"; do
    mkdir -p "$root/$(dirname "$rel")"
    printf '%s\n' "$DML" > "$root/$rel"
  done
  printf '%s' "$root/tests/l1-lint/no-directories-table-refs.sh"
}

RC=0
OUT=""
lint() {
  RC=0
  OUT=$(bash "$1" 2>&1) || RC=$?
}

test_case "the plugin tree passes"
lint "$LINT"
assert_exit_code 0 "$RC" "no-directories-table-refs passes on the plugin"

test_case "a tree with no DML passes"
lint "$(fixture clean)"
assert_exit_code 0 "$RC" "the fixture alone is clean"

test_case "a new file holding the DML fails"
lint "$(fixture new-file scripts/new-migration.sh)"
assert_exit_code 1 "$RC" "a new source file is a hit"
assert_contains "$OUT" "scripts/new-migration.sh contains SQLite directories-table DML/DDL" "the failure names the file"

test_case "the listed bundles pass"
lint "$(fixture listed dashboard/dist/server.mjs mcp/trajectory-server/dist/run-scan.js)"
assert_exit_code 0 "$RC" "both exact paths are exempt"

test_case "an unlisted bundle in the trajectory-server dist fails"
lint "$(fixture unlisted-server mcp/trajectory-server/dist/new-bundle.js)"
assert_exit_code 1 "$RC" "dist/ is not a blanket exemption"
assert_contains "$OUT" "mcp/trajectory-server/dist/new-bundle.js contains" "the failure names the bundle"

test_case "an unlisted bundle in the dashboard dist fails"
lint "$(fixture unlisted-dashboard dashboard/dist/client.mjs)"
assert_exit_code 1 "$RC" "dashboard/dist/ is not a blanket exemption"
assert_contains "$OUT" "dashboard/dist/client.mjs contains" "the failure names the bundle"

test_case "a listed basename under another directory fails"
lint "$(fixture wrong-dir dashboard/dist/run-scan.js)"
assert_exit_code 1 "$RC" "the exemption matches the full path"
assert_contains "$OUT" "dashboard/dist/run-scan.js contains" "the failure names the bundle"

summarize
