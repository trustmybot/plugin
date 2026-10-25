#!/usr/bin/env bash
# Smoke test: seed a temp trajectory DB from schema.sql (with world-model rows),
# start the built dashboard server on a free port against it, check the page and
# the JSON API, and check the server left the DB file unchanged. Then repeat the
# world-model checks against a DB without the wm_* tables (below v42).
set -euo pipefail

DASH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$DASH/../mcp/trajectory-server/src/schema.sql"
SERVER="$DASH/dist/server.mjs"
TITLE="Dashboard smoke seeded issue"

[ -f "$SERVER" ] || { echo "✗ $SERVER missing; run bun run build in dashboard/" >&2; exit 1; }

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-dashboard-smoke.XXXXXX")
DB="$TMP/trajectory.db"
OLD_DB="$TMP/trajectory-v41.db"
LOG="$TMP/server.log"
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

ISSUE_ID=$(node - "$SCHEMA" "$DB" "$TITLE" <<'JS'
const { readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [schema, path, title] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec(readFileSync(schema, 'utf8'));
const now = new Date().toISOString();
const { lastInsertRowid: issue } = db
  .prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)')
  .run(title, now, now);
db.prepare(
  "INSERT INTO tasks (issue_id, branch_id, title, description, created_at, updated_at) VALUES (?, 'feat/smoke', 'Smoke task', 'd', ?, ?)",
).run(issue, now, now);
db.prepare("INSERT INTO discussions (issue_id, author, body, created_at) VALUES (?, 'bro', 'Smoke discussion', ?)")
  .run(issue, now);
db.prepare("INSERT INTO audit (issue_id, event_type, summary, created_at) VALUES (?, 'smoke', 'Smoke audit row', ?)")
  .run(issue, now);
const dir = db.prepare(
  "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', ?, ?, ?, 'readme', ?)",
);
dir.run('', null, 'Plugin root', 3);
dir.run('dashboard', '', 'Smokemap dashboard module', 2);
dir.run('dashboard/server', 'dashboard', 'HTTP server', 1);
db.prepare(
  "INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'dashboard/server/main.ts', 'dashboard/server', 'Smokemap server entry', ?)",
).run(now);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(Number(issue));
JS
)

node - "$SCHEMA" "$OLD_DB" <<'JS'
const { readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [schema, path] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec(readFileSync(schema, 'utf8'));
for (const t of ['wm_directories_embeddings', 'wm_files_embeddings', 'wm_directories_fts', 'wm_files_fts', 'wm_directories', 'wm_files']) {
  db.exec(`DROP TABLE ${t}`);
}
db.exec('UPDATE plugin_meta SET schema_version = 41');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
JS

URL=""
start_server() {
  : >"$LOG"
  TRAJECTORY_DB_PATH="$1" TMB_DASHBOARD_PORT=0 node "$SERVER" >"$LOG" 2>&1 &
  PID=$!
  URL=""
  for _ in $(seq 1 50); do
    URL=$(grep -m 1 -o 'http://127\.0\.0\.1:[0-9]*/' "$LOG" || true)
    [ -n "$URL" ] && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  [ -n "$URL" ] || { echo "✗ server did not start:" >&2; cat "$LOG" >&2; exit 1; }
}

stop_server() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=""
}

BEFORE=$(cksum < "$DB")
start_server "$DB"

failed=0
check() {
  local path="$1" expect="$2" body status
  body=$(curl -sS --max-time 5 -w '\n%{http_code}' "$URL$path")
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$status" != 200 ]; then
    echo "  ✗ GET /$path → HTTP $status" >&2; failed=1; return
  fi
  if [ -n "$expect" ] && ! printf '%s' "$body" | grep -F -- "$expect" >/dev/null; then
    echo "  ✗ GET /$path: body lacks \"$expect\"" >&2; failed=1; return
  fi
  echo "  ✓ GET /$path"
}

check "" '<div id="root">'
check "api/summary" '"open":1'
check "api/issues" "$TITLE"
check "api/issues/$ISSUE_ID" "$TITLE"
check "api/version" '"data_version"'
check "api/tasks" 'Smoke task'
check "api/agent-runs" ''
check "api/gates" '"verifications"'
check "api/audit?limit=5" 'Smoke audit row'
check "issues/$ISSUE_ID" '<div id="root">'
check "api/world-model" '"available":true'
check "api/world-model" '"path":"dashboard/server"'
check "api/world-model?depth=0" '"repos":["plugin"],"nodes":[{"repo":"plugin","path":"",'
check "api/world-model?repo=plugin&path=dashboard&depth=1" '"summary":"HTTP server"'
check "api/world-model/search?q=smokemap" '"path":"dashboard"'
check "api/world-model/search?q=smokemap" '"path":"dashboard/server/main.ts"'
check "api/world-model/search?q=foo%22(" '"available":true'
check "api/world-model/search?q=%22%20OR%20*%20NEAR(" '"hits":[]'
check "api/world-model/search?q=((" '"hits":[]'
check "api/world-model/search?q=smokemap&limit=1" '"kind"'
check "api/world-model?depth=99&path=nowhere" '"nodes":[]'
check "api/world-model/graph" '"available":true,"repo":"plugin"'

stop_server

if [ "$(cksum < "$DB")" != "$BEFORE" ]; then
  echo "  ✗ the server changed the DB file" >&2; failed=1
else
  echo "  ✓ DB file unchanged"
fi

echo "  without world-model tables:"
start_server "$OLD_DB"
check "api/world-model" '{"available":false,"repos":[],"nodes":[]}'
check "api/world-model/search?q=smokemap" '{"available":false,"hits":[]}'
check "api/world-model/graph" '{"available":false,"repo":null,"repos":[],"files":[],"edges":[]}'
check "api/summary" '"open_runs"'
stop_server

[ "$failed" = 0 ] && echo "✓ dashboard smoke passed" || { echo "✗ dashboard smoke failed" >&2; exit 1; }
