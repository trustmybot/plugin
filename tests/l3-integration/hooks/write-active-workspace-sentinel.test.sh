#!/usr/bin/env bash
# Tests for scripts/hooks/write-active-workspace-sentinel.sh and the
# sentinel-resolver path in lib/query-task.sh::tmb_db_path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/write-active-workspace-sentinel.sh"
QUERY_LIB="$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

run_hook() {
  echo '{}' | bash "$HOOK" 2>&1 || true
}

# ---- sentinel writer hook tests --------------------------------------------

test_case "no DB found: hook exits silently"
unset TRAJECTORY_DB_PATH
ORIG_HOME="$HOME"
export HOME="$TMPDIR/fakehome1"
mkdir -p "$HOME/.claude"
out=$(cd "$TMPDIR" && run_hook)
assert_eq "" "$out" "silent when no DB"
HOME="$ORIG_HOME"

test_case "DB found: sentinel written at \$HOME/.claude/tmb-active-workspace"
WS="$TMPDIR/workspace"
DB_DIR="$WS/.claude/tmb"
mkdir -p "$DB_DIR"
touch "$DB_DIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB_DIR/trajectory.db"
export HOME="$TMPDIR/fakehome2"
mkdir -p "$HOME/.claude"
out=$(run_hook)
assert_eq "" "$out" "silent when DB found"
SENTINEL="$HOME/.claude/tmb-active-workspace"
[ -f "$SENTINEL" ] || { printf "FAIL: sentinel not created\n"; exit 1; }
SENTINEL_CONTENT=$(cat "$SENTINEL")
assert_eq "$WS" "$SENTINEL_CONTENT" "sentinel contains workspace path"
HOME="$ORIG_HOME"
unset TRAJECTORY_DB_PATH

test_case "sentinel written: hook is idempotent (rewrite on each call)"
WS="$TMPDIR/workspace2"
DB_DIR="$WS/.claude/tmb"
mkdir -p "$DB_DIR"
touch "$DB_DIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB_DIR/trajectory.db"
export HOME="$TMPDIR/fakehome3"
mkdir -p "$HOME/.claude"
run_hook >/dev/null
run_hook >/dev/null
SENTINEL="$HOME/.claude/tmb-active-workspace"
SENTINEL_CONTENT=$(cat "$SENTINEL")
assert_eq "$WS" "$SENTINEL_CONTENT" "sentinel content stable after two runs"
HOME="$ORIG_HOME"
unset TRAJECTORY_DB_PATH

# ---- tmb_db_path sentinel-resolver tests ----------------------------------

test_case "tmb_db_path: sentinel resolver finds DB (cwd unrelated)"
WS="$TMPDIR/sentws"
DB_DIR="$WS/.claude/tmb"
mkdir -p "$DB_DIR"
touch "$DB_DIR/trajectory.db"
FAKE_HOME="$TMPDIR/fakehome4"
mkdir -p "$FAKE_HOME/.claude"
printf '%s\n' "$WS" > "$FAKE_HOME/.claude/tmb-active-workspace"
result=$(cd "/" && HOME="$FAKE_HOME" bash -c ". '$QUERY_LIB'; tmb_db_path" 2>/dev/null)
assert_eq "$DB_DIR/trajectory.db" "$result" "sentinel-resolved DB path"

test_case "tmb_db_path: sentinel-resolved path doesn't exist, falls through to walk-up"
WS2="$TMPDIR/missingws"
FAKE_HOME2="$TMPDIR/fakehome5"
mkdir -p "$FAKE_HOME2/.claude"
printf '%s\n' "$WS2" > "$FAKE_HOME2/.claude/tmb-active-workspace"
WALK_DIR="$TMPDIR/walkdir"
DB_WALK="$WALK_DIR/.claude/tmb"
mkdir -p "$DB_WALK"
touch "$DB_WALK/trajectory.db"
result=$(cd "$WALK_DIR" && HOME="$FAKE_HOME2" bash -c ". '$QUERY_LIB'; tmb_db_path" 2>/dev/null)
assert_eq "$DB_WALK/trajectory.db" "$result" "walk-up fallback when sentinel DB absent"

test_case "tmb_db_path: no sentinel, walk-up still works"
WALK_DIR2="$TMPDIR/walkdir2"
DB_WALK2="$WALK_DIR2/.claude/tmb"
mkdir -p "$DB_WALK2"
touch "$DB_WALK2/trajectory.db"
FAKE_HOME3="$TMPDIR/fakehome6"
mkdir -p "$FAKE_HOME3/.claude"
result=$(cd "$WALK_DIR2" && HOME="$FAKE_HOME3" bash -c ". '$QUERY_LIB'; tmb_db_path" 2>/dev/null)
assert_eq "$DB_WALK2/trajectory.db" "$result" "walk-up without sentinel"

test_case "tmb_db_path: TRAJECTORY_DB_PATH env wins over sentinel"
WS3="$TMPDIR/envws"
DB_DIR3="$WS3/.claude/tmb"
mkdir -p "$DB_DIR3"
touch "$DB_DIR3/trajectory.db"
OVERRIDE_DB="$TMPDIR/override.db"
touch "$OVERRIDE_DB"
FAKE_HOME4="$TMPDIR/fakehome7"
mkdir -p "$FAKE_HOME4/.claude"
printf '%s\n' "$WS3" > "$FAKE_HOME4/.claude/tmb-active-workspace"
result=$(cd "/" && HOME="$FAKE_HOME4" TRAJECTORY_DB_PATH="$OVERRIDE_DB" bash -c ". '$QUERY_LIB'; tmb_db_path" 2>/dev/null)
assert_eq "$OVERRIDE_DB" "$result" "TRAJECTORY_DB_PATH takes precedence over sentinel"

test_case "tmb_db_path: walk-up returns outermost when sibling DBs exist (#134)"
OUTER_ROOT=$(mktemp -d)
trap 'rm -rf "$OUTER_ROOT"' EXIT
OUTER_DB_DIR="$OUTER_ROOT/outer/.claude/tmb"
INNER_DB_DIR="$OUTER_ROOT/outer/inner/.claude/tmb"
mkdir -p "$OUTER_DB_DIR" "$INNER_DB_DIR"
touch "$OUTER_DB_DIR/trajectory.db"
touch "$INNER_DB_DIR/trajectory.db"
FAKE_HOME_NOSENTINEL="$TMPDIR/fakehome_nosentinel"
mkdir -p "$FAKE_HOME_NOSENTINEL/.claude"
SUB_DIR="$OUTER_ROOT/outer/inner/some/sub/dir"
mkdir -p "$SUB_DIR"
result=$(cd "$SUB_DIR" && HOME="$FAKE_HOME_NOSENTINEL" bash -c ". '$QUERY_LIB'; tmb_db_path" 2>/dev/null)
assert_eq "$OUTER_DB_DIR/trajectory.db" "$result" "outermost DB wins over inner sibling"

summarize
