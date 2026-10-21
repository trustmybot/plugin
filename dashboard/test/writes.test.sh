#!/usr/bin/env bash
# Write-path test: create a temp trajectory DB with the trajectory server's own
# TrajectoryDB (schema.sql), start the built dashboard server on a free port
# with a fake HOME, and check every Human write — edits, a comment, a close and
# a refused close — lands through the trajectory-server handlers with a
# source=dashboard audit row, and that the token, Origin, Host, body-size,
# stale updated_at and schema-version guards refuse what they should.
set -euo pipefail

DASH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_MODULE="$DASH/../mcp/trajectory-server/dist/db.js"
SERVER="$DASH/dist/server.mjs"

[ -f "$SERVER" ] || { echo "✗ $SERVER missing; run bun run build in dashboard/" >&2; exit 1; }
[ -f "$DB_MODULE" ] || { echo "✗ $DB_MODULE missing; build mcp/trajectory-server" >&2; exit 1; }

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-dashboard-writes.XXXXXX")
DB="$TMP/trajectory.db"
LOG="$TMP/server.log"
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

export HOME="$TMP/home"
export TMB_DISABLE_REMOTE_SYNC=1
mkdir -p "$HOME"
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT

IDS=$(node --input-type=module - "$DB_MODULE" "$DB" <<'JS'
const [dbModule, path] = process.argv.slice(2);
const { TrajectoryDB } = await import(dbModule);
const noop = () => {};
const db = new TrajectoryDB(path, { pluginVersion: null, serverLog: noop, sqlLog: noop });
const now = new Date().toISOString();
const issue = (objective) =>
  Number(db.run(
    `INSERT INTO issues (objective, labels, created_at, updated_at) VALUES (?, '["Feature","Priority: Low"]', ?, ?)`,
    [objective, now, now],
  ).lastInsertRowid);
const edit = issue('Writes test issue');
const live = issue('Issue with a live task');
const empty = issue('Issue with no tasks');
db.run(
  `INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at)
   VALUES (?, 'feat/writes', 'Live task', 'd', 'running', ?, ?)`,
  [live, now, now],
);
db.close();
console.log(`${edit} ${live} ${empty}`);
JS
)
read -r EDIT_ID LIVE_ID EMPTY_ID <<<"$IDS"

sql() {
  node - "$DB" "$1" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const [path, query] = process.argv.slice(2);
const db = new DatabaseSync(path, { readOnly: true });
console.log(JSON.stringify(db.prepare(query).all()));
db.close();
JS
}

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
ORIGIN="${URL%/}"
TOKEN=$(curl -sS --max-time 5 "$URL" | grep -o 'name="tmb-token" content="[0-9a-f]*"' | sed 's/.*content="//; s/"$//')
[ -n "$TOKEN" ] || { echo "✗ index.html carries no tmb-token meta tag" >&2; exit 1; }

failed=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; failed=1; }

STATUS=""
BODY=""
# post <path> <json> [origin] [token]
post() {
  local out
  out=$(curl -sS --max-time 10 -X POST -w '\n%{http_code}' \
    -H 'content-type: application/json' \
    -H "origin: ${3-$ORIGIN}" \
    -H "x-tmb-token: ${4-$TOKEN}" \
    --data "$2" "$URL$1")
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

expect() {
  local label="$1" want_status="$2" want_body="${3:-}"
  if [ "$STATUS" != "$want_status" ]; then
    fail "$label: HTTP $STATUS, want $want_status ($BODY)"; return
  fi
  if [ -n "$want_body" ] && ! printf '%s' "$BODY" | grep -F -- "$want_body" >/dev/null; then
    fail "$label: body lacks $want_body ($BODY)"; return
  fi
  pass "$label"
}

expect_sql() {
  local label="$1" query="$2" want="$3" got
  got=$(sql "$query")
  if printf '%s' "$got" | grep -F -- "$want" >/dev/null; then pass "$label"; else fail "$label: $got lacks $want"; fi
}

updated_at() {
  curl -sS --max-time 5 "${URL}api/issues/$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).issue.updated_at))'
}

audit_for() {
  sql "SELECT json_extract(content_json, '\$.tool') AS tool FROM audit
        WHERE issue_id = $1 AND from_node = 'dashboard'
          AND json_extract(content_json, '\$.source') = 'dashboard'
          AND json_extract(content_json, '\$.actor') = 'human'
        ORDER BY id"
}

echo "  edits:"
post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"objective\":\"Edited objective\"}"
expect "objective edit" 200 '"tools":["issue_update"]'
expect_sql "objective landed" "SELECT objective FROM issues WHERE id = $EDIT_ID" '"Edited objective"'

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"description\":\"Edited description\"}"
expect "description edit" 200 '"tools":["issue_update_description"]'
expect_sql "description landed" "SELECT description FROM issues WHERE id = $EDIT_ID" '"Edited description"'

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"labels\":[\"Feature\",\"Priority: High\"]}"
expect "priority edit" 200
expect_sql "priority landed" "SELECT labels FROM issues WHERE id = $EDIT_ID" 'Priority: High'

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"labels\":[\"Bug\",\"Priority: High\",\"ux\"]}"
expect "labels edit" 200
expect_sql "labels landed" "SELECT labels FROM issues WHERE id = $EDIT_ID" '[\"Bug\",\"Priority: High\",\"ux\"]'

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"milestone\":\"v9.9.9\"}"
expect "milestone edit" 200
expect_sql "milestone landed" "SELECT milestone FROM issues WHERE id = $EDIT_ID" '"milestone":"v9.9.9"'

expect_sql "an audit row with source=dashboard per edit" \
  "SELECT COUNT(*) AS n FROM audit WHERE issue_id = $EDIT_ID AND json_extract(content_json, '\$.source') = 'dashboard'" '"n":5'
AUDIT=$(audit_for "$EDIT_ID")
[ "$AUDIT" = '[{"tool":"issue_update"},{"tool":"issue_update_description"},{"tool":"issue_update"},{"tool":"issue_update"},{"tool":"issue_update"}]' ] \
  && pass "audit rows name the handler, actor=human" || fail "audit rows: $AUDIT"

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"labels\":[\"Bug\"]}"
expect "handler validation error is returned" 422 'missing_required_labels'

post "api/issues/$EDIT_ID/edit" '{"updated_at":"2000-01-01T00:00:00.000Z","objective":"Stale write"}'
expect "stale updated_at" 409 '"error":"stale"'
expect_sql "stale edit did not land" "SELECT objective FROM issues WHERE id = $EDIT_ID" '"Edited objective"'

post "api/issues/$EDIT_ID/edit" '{"objective":"No version"}'
expect "edit without updated_at" 400 'updated_at_required'

post "api/issues/$EDIT_ID/edit" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"objective\":\"Both fields\",\"description\":\"Both description\"}"
expect "objective and description in one edit" 200 '"tools":["issue_update","issue_update_description"]'
expect_sql "both fields landed" "SELECT objective, description FROM issues WHERE id = $EDIT_ID" '"objective":"Both fields","description":"Both description"'

post "api/issues/$EDIT_ID/close" "{\"updated_at\":\"$(updated_at "$EDIT_ID")\",\"cascade\":true}"
expect "close refuses a cascade field" 400 'unknown_fields'

echo "  comment:"
post "api/issues/$EDIT_ID/comment" '{"body":"A Human comment from the dashboard"}'
expect "comment" 200 '"tools":["discussion_append"]'
expect_sql "comment landed as author=human kind=note" \
  "SELECT author, kind FROM discussions WHERE issue_id = $EDIT_ID AND body = 'A Human comment from the dashboard'" \
  '[{"author":"human","kind":"note"}]'
expect_sql "comment audit row" \
  "SELECT COUNT(*) AS n FROM audit WHERE issue_id = $EDIT_ID AND json_extract(content_json, '\$.tool') = 'discussion_append' AND json_extract(content_json, '\$.source') = 'dashboard'" '"n":1'

echo "  close:"
post "api/issues/$LIVE_ID/close" "{\"updated_at\":\"$(updated_at "$LIVE_ID")\"}"
expect "close with a live task is refused" 422 '"error":"issue_has_open_tasks"'
printf '%s' "$BODY" | grep -F '"status":"running"' >/dev/null && pass "refusal lists the blocking task" || fail "refusal lacks the task: $BODY"
expect_sql "refused issue stays open" "SELECT status FROM issues WHERE id = $LIVE_ID" '"open"'
expect_sql "refused close left the task alone" "SELECT status FROM tasks WHERE issue_id = $LIVE_ID" '"running"'

post "api/issues/$EMPTY_ID/close" "{\"updated_at\":\"$(updated_at "$EMPTY_ID")\"}"
expect "close with no tasks" 200 '"issue_status":"closed"'
expect_sql "issue closed" "SELECT status FROM issues WHERE id = $EMPTY_ID" '"closed"'
[ "$(audit_for "$EMPTY_ID")" = '[{"tool":"issue_close"}]' ] && pass "close audit row" || fail "close audit: $(audit_for "$EMPTY_ID")"

echo "  guards:"
post "api/issues/$EDIT_ID/comment" '{"body":"no token"}' "$ORIGIN" ""
expect "POST without token" 403 'bad_token'
post "api/issues/$EDIT_ID/comment" '{"body":"wrong token"}' "$ORIGIN" "deadbeef"
expect "POST with a wrong token" 403 'bad_token'
post "api/issues/$EDIT_ID/comment" '{"body":"foreign"}' "http://evil.example"
expect "POST with a foreign Origin" 403 'forbidden_origin'
post "api/issues/$EDIT_ID/comment" '{"body":"localhost"}' "http://localhost:${ORIGIN##*:}"
expect "POST with another loopback Origin" 403 'forbidden_origin'
out=$(curl -sS --max-time 5 -X POST -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -H "x-tmb-token: $TOKEN" --data '{"body":"no origin"}' "${URL}api/issues/$EDIT_ID/comment")
[ "$out" = 403 ] && pass "POST without Origin" || fail "POST without Origin: HTTP $out"
expect_sql "guarded comments did not land" \
  "SELECT COUNT(*) AS n FROM discussions WHERE issue_id = $EDIT_ID AND author = 'human'" '"n":1'

for path in "api/tasks" "api/tasks/1" "api/tasks/1/edit" "api/plugin_config" "api/config" \
  "api/issues" "api/issues/create" "api/issues/$EDIT_ID/create" "api/issues/$EDIT_ID/reopen" \
  "api/issues/$EDIT_ID/delete" "api/issues/$EDIT_ID/force_close" "api/issues/-1/comment"; do
  post "$path" '{}'
  expect "no write endpoint: POST /$path" 404
done
out=$(curl -sS --max-time 5 -X PUT -o /dev/null -w '%{http_code}' "${URL}api/issues/$EDIT_ID")
[ "$out" = 405 ] && pass "PUT is 405" || fail "PUT: HTTP $out"

for path in "" "api/issues/$EDIT_ID"; do
  out=$(curl -sS --max-time 5 -w '\n%{http_code}' -H "host: evil.example:${ORIGIN##*:}" "$URL$path")
  code="${out##*$'\n'}"
  if [ "$code" = 403 ] && ! printf '%s' "$out" | grep -F "$TOKEN" >/dev/null; then
    pass "GET /$path with a foreign Host is 403 and leaks no token"
  else
    fail "GET /$path with a foreign Host: HTTP $code"
  fi
done

head -c $((3 * 1024 * 1024)) /dev/zero | tr '\0' 'a' | sed 's/^/{"body":"/; s/$/"}/' >"$TMP/big.json"
if out=$(curl -sS --max-time 10 -X POST -w '\n%{http_code}' -H 'content-type: application/json' \
  -H "origin: $ORIGIN" -H "x-tmb-token: $TOKEN" --data-binary "@$TMP/big.json" "${URL}api/issues/$EDIT_ID/comment"); then
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
  expect "oversized POST receives the 413" 413 'body_too_large'
else
  fail "oversized POST: curl exited $? before receiving a response"
fi

echo "  schema version:"
node - "$DB" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('UPDATE plugin_meta SET schema_version = schema_version - 1 WHERE id = 1').run();
db.close();
JS
post "api/issues/$EDIT_ID/comment" '{"body":"after a schema change"}'
expect "schema-version mismatch" 409 'schema_version_mismatch'
expect_sql "mismatched write did not land" \
  "SELECT COUNT(*) AS n FROM discussions WHERE body = 'after a schema change'" '"n":0'

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""
OPENED=$(node --input-type=module - "$DB_MODULE" "$DB" <<'JS'
const [dbModule, path] = process.argv.slice(2);
const { TrajectoryDB, TARGET_SCHEMA_VERSION } = await import(dbModule);
const { DatabaseSync } = await import('node:sqlite');
const noop = () => {};
let refused = false;
try {
  new TrajectoryDB(path, { pluginVersion: null, serverLog: noop, sqlLog: noop }).close();
} catch (error) {
  refused = /only the trajectory-server migrates/.test(String(error));
}
const raw = new DatabaseSync(path, { readOnly: true });
const { schema_version } = raw.prepare('SELECT schema_version FROM plugin_meta WHERE id = 1').get();
raw.close();
if (!refused) console.log('opened without refusing');
else console.log(schema_version === TARGET_SCHEMA_VERSION - 1 ? 'unmigrated' : `migrated to ${schema_version}`);
JS
)
[ "$OPENED" = unmigrated ] && pass "the dashboard's TrajectoryDB open refuses an older DB and leaves it unmigrated" || fail "older DB open: $OPENED"
ls "$TMP" | grep -q '\.bak$' && fail "opening an older DB wrote a pre-migration backup" || pass "no pre-migration backup"

if grep -E 'INSERT|UPDATE|DELETE' "$DASH"/server/*.ts | grep -v '^[^:]*queries\.ts:\s*//' >/dev/null; then
  fail "dashboard/server/*.ts carries write SQL"
else
  pass "dashboard/server/*.ts carries no write SQL"
fi

[ "$failed" = 0 ] && echo "✓ dashboard writes passed" || { echo "✗ dashboard writes failed" >&2; exit 1; }
