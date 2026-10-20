#!/usr/bin/env bash
# L3: scan_run repo discovery skips scratch, ignored and commit-less repos (GH 1551).
# A temp session holds a real repo (the session root, which ignores
# build-cache/), .tmp-x/proj with a commit, build-cache/repo with a commit and
# a commit-less empty/. scan_run (the server handler forking scripts/scan.sh)
# must give only the session root a repos row, and scan.sh must write one
# scan_skipped audit row per skipped repo, with reasons dot_dir, git_ignored
# and no_commits; a re-scan writes no further scan_skipped row.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist"

command -v node >/dev/null 2>&1 || { echo "SKIP: node not available"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not found"; exit 0; }
[ -f "$DIST/tools/scan.js" ] || { echo "SKIP: dist not built ($DIST/tools/scan.js missing)"; exit 0; }

TMPDIR=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-scan-discovery-skips.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

export HOME="$TMPDIR/home"
export TMB_FORBID_LIVE_SYNC=1
unset TMB_SCAN_PLUGIN_JSON TMB_SCAN_MCP_JSON CLAUDE_PROJECT_DIR
mkdir -p "$HOME"

mk_repo() {
  mkdir -p "$1"
  git -C "$1" init -q -b main
  git -C "$1" config user.email t@t.io
  git -C "$1" config user.name t
  if [ "${2:-}" = commit ]; then
    printf 'x\n' > "$1/f.txt"
    git -C "$1" add .
    git -C "$1" commit -qm init
  fi
}

WS="$TMPDIR/ws"
mk_repo "$WS"
printf 'build-cache/\n' > "$WS/.gitignore"
printf 'real\n' > "$WS/README.md"
git -C "$WS" add .
git -C "$WS" commit -qm init
mk_repo "$WS/.tmp-x/proj" commit
mk_repo "$WS/build-cache/repo" commit
mk_repo "$WS/empty"

DB="$TMPDIR/db/trajectory.db"
mkdir -p "$(dirname "$DB")"
export TRAJECTORY_DB_PATH="$DB"

run_scan() {
  node --experimental-sqlite --no-warnings --input-type=module -e "
    const { TrajectoryDB } = await import('$DIST/db.js');
    const { scanTools } = await import('$DIST/tools/scan.js');
    const db = new TrajectoryDB(process.env.TRAJECTORY_DB_PATH);
    const r = await scanTools(db, null).handlers.scan_run({ agent: 'bro', session_dir: process.argv[1] });
    db.close();
    if (r.isError) { console.error(r.content[0].text); process.exit(1); }
  " "$WS"
}

skipped() {
  sqlite3 "$DB" "SELECT json_extract(content_json, '$.reason') || ' ' || json_extract(content_json, '$.path')
                   FROM audit WHERE event_type = 'scan_skipped' AND from_node = 'hook:scan' AND issue_id = -1
                  ORDER BY 1;"
}

test_case "scan_run succeeds"
rc=0
run_scan || rc=$?
assert_exit_code 0 "$rc" "scan_run exit"

test_case "only the real repo gets a repos row"
assert_eq "$WS" "$(sqlite3 "$DB" "SELECT group_concat(path, ',') FROM repos;")" "repos paths"

test_case "one scan_skipped row per skipped repo, with its reason"
expected="dot_dir $WS/.tmp-x/proj
git_ignored $WS/build-cache/repo
no_commits $WS/empty"
assert_eq "$expected" "$(skipped)" "scan_skipped rows"

test_case "a re-scan writes no further scan_skipped row"
rc=0
run_scan || rc=$?
assert_exit_code 0 "$rc" "second scan_run exit"
assert_eq "3" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type = 'scan_skipped';")" "scan_skipped count"

summarize
