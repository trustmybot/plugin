#!/usr/bin/env bash
# The hook DB resolver (scripts/hooks/lib/query-task.sh tmb_db_path) never
# walks up under a test flag.
#
# Fixture: a current-schema DB at <ws>/.claude/tmb/trajectory.db, the resolver
# run from <ws>/a/b — exactly where a walk-up would find it.
#   - TMB_FORBID_LIVE_SYNC=1 or a set TMB_TEST_RUN_ID, no TRAJECTORY_DB_PATH or
#     CLAUDE_PROJECT_DIR → unresolved, one stderr line naming the flag
#   - the same flag with CLAUDE_PROJECT_DIR=<ws> or TRAJECTORY_DB_PATH → resolves
#   - no flag → walks up to the fixture DB (unchanged)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not installed"; exit 0; }

BASE=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/tmb-db-lookup-no-walkup.XXXXXX")" && pwd -P)
trap 'rm -rf "$BASE"' EXIT
WS="$BASE/ws"
DB="$WS/.claude/tmb/trajectory.db"
mkdir -p "$WS/.claude/tmb" "$WS/a/b" "$BASE/home"
sqlite3 "$DB" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);"

# resolve [env...] — prints "<rc>|<stdout>|<stderr>" of tmb_db_path run from
# <ws>/a/b with only the given variables (plus HOME and PATH) set.
resolve() {
  local err out rc=0
  err=$(mktemp "$BASE/err.XXXXXX")
  out=$(cd "$WS/a/b" && env -i HOME="$BASE/home" PATH="$PATH" "$@" \
    bash -c '. "$1"; tmb_db_path' _ "$LIB" 2>"$err") || rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
}

for flag in TMB_FORBID_LIVE_SYNC=1 TMB_TEST_RUN_ID=tmb-l3-walkup; do
  name="${flag%%=*}"

  test_case "$name set, no path: unresolved, no walk-up, one stderr line naming the flag"
  got=$(resolve "$flag")
  assert_eq "1|" "${got%|*}" "unresolved ($name)"
  assert_contains "${got##*|}" "tmb: trajectory DB unresolved: $name is set" "stderr names the flag ($name)"
  assert_eq "1" "$(printf '%s\n' "${got##*|}" | wc -l | tr -d ' ')" "exactly one stderr line ($name)"

  test_case "$name set, CLAUDE_PROJECT_DIR=<ws>: resolves the fixture DB"
  assert_eq "0|$DB|" "$(resolve "$flag" CLAUDE_PROJECT_DIR="$WS")" "project dir resolves ($name)"

  test_case "$name set, TRAJECTORY_DB_PATH: resolves the fixture DB"
  assert_eq "0|$DB|" "$(resolve "$flag" TRAJECTORY_DB_PATH="$DB")" "explicit path resolves ($name)"
done

test_case "TMB_FORBID_LIVE_SYNC=0 is not a test flag: walks up"
assert_eq "0|$DB|" "$(resolve TMB_FORBID_LIVE_SYNC=0)" "FORBID=0 walks up"

test_case "no flag, no path: walks up to the fixture DB (unchanged)"
assert_eq "0|$DB|" "$(resolve)" "walk-up resolves"

test_case "a hook under a test flag reports the DB unresolved"
state=$(cd "$WS/a/b" && env -i HOME="$BASE/home" PATH="$PATH" TMB_TEST_RUN_ID=tmb-l3-walkup \
  bash -c '. "$1"; tmb_db_state' _ "$LIB" 2>/dev/null)
assert_eq "unresolved" "$state" "tmb_db_state unresolved under the flag"

summarize
