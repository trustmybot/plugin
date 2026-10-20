#!/usr/bin/env bash
# GH 1553: a session opened in a subdirectory of a TMB workspace resolves the
# workspace DB. The hooks' tmb_db_path and the server's resolveClaudeDbPath
# both walk up from CLAUDE_PROJECT_DIR (<ws>/a/b) to <ws>/.claude/tmb, the
# project root is <ws>, and nothing is created under <ws>/a/b/.claude.
#
# A DB whose state dir holds a `standalone` file ends the walk and wins. A DB
# in $HOME itself is never picked from a start below it.
#
# Everything lives under a temp HOME, so no walk can reach a live TMB DB: the
# walk stops before entering HOME. The test flags are unset — under them the
# hooks never walk.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"
PLATFORM_JS="$PLUGIN_ROOT/mcp/trajectory-server/dist/platform.js"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not installed"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not installed"; exit 0; }
[ -f "$PLATFORM_JS" ] || { echo "FAIL: $PLATFORM_JS missing — run bun run build"; exit 1; }

BASE=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-db-walkup-nest.XXXXXX")" && pwd -P)
trap 'rm -rf "$BASE"' EXIT
FAKE_HOME="$BASE/home"
WS="$FAKE_HOME/ws"
SESSION="$WS/a/b"
mkdir -p "$SESSION"

plant() {
  mkdir -p "$1/.claude/tmb"
  sqlite3 "$1/.claude/tmb/trajectory.db" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);" >/dev/null
}

# hook_eval <cpd> <fn>: runs a query-task.sh function as a hook would see it.
hook_eval() {
  (cd / && env -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT \
    HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$1" bash -c '. "$1"; '"$2" _ "$LIB" 2>/dev/null)
}

# server_db <cpd>: the server's resolveClaudeDbPath for that session.
server_db() {
  (cd / && env -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT \
    HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$1" node --experimental-sqlite --no-warnings --input-type=module \
    -e "const m = await import(process.argv[1]); console.log(m.resolveClaudeDbPath());" "$PLATFORM_JS" 2>/dev/null)
}

plant "$WS"
WS_DB="$WS/.claude/tmb/trajectory.db"

test_case "hooks: CLAUDE_PROJECT_DIR=<ws>/a/b resolves the workspace DB"
assert_eq "$WS_DB" "$(hook_eval "$SESSION" tmb_db_path)" "tmb_db_path"

test_case "server: CLAUDE_PROJECT_DIR=<ws>/a/b resolves the workspace DB"
assert_eq "$WS_DB" "$(server_db "$SESSION")" "resolveClaudeDbPath"

test_case "hooks: the project root is the workspace"
assert_eq "$WS" "$(hook_eval "$SESSION" tmb_project_root)" "tmb_project_root"
assert_eq "$WS/.claude/tmb" "$(hook_eval "$SESSION" tmb_state_dir)" "tmb_state_dir"

test_case "hooks: a relative repos.path joins the project root, not the DB dir"
assert_eq "$WS/svc" "$(hook_eval "$SESSION" "tmb_repo_path_abs '$WS_DB' svc")" "tmb_repo_path_abs relative"
assert_eq "/abs/svc" "$(hook_eval "$SESSION" "tmb_repo_path_abs '$WS_DB' /abs/svc")" "tmb_repo_path_abs absolute"

test_case "nothing is created under <ws>/a/b/.claude"
if [ -e "$SESSION/.claude" ]; then
  _fail "found $(find "$SESSION/.claude" | head -5 | tr '\n' ' ')"
else
  _pass
fi

test_case "a standalone DB at <ws>/a/b wins on both sides"
plant "$SESSION"
: > "$SESSION/.claude/tmb/standalone"
INNER_DB="$SESSION/.claude/tmb/trajectory.db"
assert_eq "$INNER_DB" "$(hook_eval "$SESSION" tmb_db_path)" "tmb_db_path"
assert_eq "$INNER_DB" "$(server_db "$SESSION")" "resolveClaudeDbPath"
assert_eq "$SESSION" "$(hook_eval "$SESSION" tmb_project_root)" "tmb_project_root"

test_case "without the marker the outermost DB wins again"
rm -f "$SESSION/.claude/tmb/standalone"
assert_eq "$WS_DB" "$(hook_eval "$SESSION" tmb_db_path)" "tmb_db_path"
assert_eq "$WS_DB" "$(server_db "$SESSION")" "resolveClaudeDbPath"

test_case "a DB in \$HOME itself is never picked from a start below it"
plant "$FAKE_HOME"
OUTSIDE="$FAKE_HOME/elsewhere/x"
mkdir -p "$OUTSIDE"
assert_eq "" "$(hook_eval "$OUTSIDE" tmb_db_path)" "tmb_db_path unresolved"
assert_eq "$OUTSIDE/.claude/tmb/trajectory.db" "$(server_db "$OUTSIDE")" "server falls back to the fresh-init path"
assert_eq "$OUTSIDE" "$(hook_eval "$OUTSIDE" tmb_project_root)" "tmb_project_root falls back to CLAUDE_PROJECT_DIR"

summarize
