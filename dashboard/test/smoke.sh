#!/usr/bin/env bash
# Smoke test: seed a temp trajectory DB from schema.sql, start the built
# dashboard server on a free port against it, check the page and the JSON API,
# and check the server left the DB file unchanged.
set -euo pipefail

DASH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$DASH/../mcp/trajectory-server/src/schema.sql"
SERVER="$DASH/dist/server.mjs"
TITLE="Dashboard smoke seeded issue"

[ -f "$SERVER" ] || { echo "✗ $SERVER missing; run bun run build in dashboard/" >&2; exit 1; }

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-dashboard-smoke.XXXXXX")
DB="$TMP/trajectory.db"
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
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(Number(issue));
JS
)
BEFORE=$(cksum < "$DB")

TRAJECTORY_DB_PATH="$DB" TMB_DASHBOARD_PORT=0 node "$SERVER" >"$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 50); do
  URL=$(grep -m 1 -o 'http://127\.0\.0\.1:[0-9]*/' "$LOG" || true)
  [ -n "$URL" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
[ -n "$URL" ] || { echo "✗ server did not start:" >&2; cat "$LOG" >&2; exit 1; }

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

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""

if [ "$(cksum < "$DB")" != "$BEFORE" ]; then
  echo "  ✗ the server changed the DB file" >&2; failed=1
else
  echo "  ✓ DB file unchanged"
fi

[ "$failed" = 0 ] && echo "✓ dashboard smoke passed" || { echo "✗ dashboard smoke failed" >&2; exit 1; }
