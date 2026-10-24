#!/usr/bin/env bash
# Tests for skills/tmb_recovery/scripts/bro-sqlite-readonly.sh on a WAL DB
# whose -shm is missing (GH 1629): a copy of db+wal whose rows sit only in the
# -wal, and a detached WAL DB (no -wal, no -shm, as a clean shutdown leaves it),
# are read from a VACUUM INTO snapshot. The rows come back, the main file's
# size and mtime and the -wal stay as they were, and the scratch snapshot is
# removed. A snapshot that cannot be taken fails loudly; a DB with its -shm, or
# not in WAL mode, keeps the direct read-only path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/lib/tmpdir-cleanup.sh
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
READONLY="$PLUGIN_ROOT/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh"
REAL_SQLITE3="$(command -v sqlite3)"

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-readonly-wal-no-shm.XXXXXX")
trap 'tmpdir_cleanup "$TMP"' EXIT

BIN="$TMP/bin" LOG="$TMP/sqlite3.log" SCRATCH="$TMP/scratch"
mkdir -p "$BIN" "$SCRATCH"
cat > "$BIN/sqlite3" <<WRAP
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
exec "$REAL_SQLITE3" "\$@"
WRAP
chmod +x "$BIN/sqlite3"

# shellcheck source=tests/l3-integration/hooks/fixtures/migrated-db.sh
. "$HERE/fixtures/migrated-db.sh"
ROWS="INSERT INTO plugin_config (key, value_json) VALUES ('sentinel', '\"wal-only\"');
  INSERT INTO issues (id, objective, status, created_at, updated_at, remote_kind, gh_iid)
    VALUES (1, 'row in the wal', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'github', 1629);"

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

fingerprint() {
  [ -e "$1" ] || { echo absent; return; }
  printf '%s %s %s\n' "$(wc -c <"$1" | tr -d ' ')" "$(mtime "$1")" "$(cksum <"$1" | cut -d' ' -f1)"
}

db_in() {
  printf '%s/.claude/tmb/trajectory.db' "$1"
}

# run_helper <project> <args>... — sets OUT, ERR, RC. The DB is named by
# TRAJECTORY_DB_PATH, so no CLAUDE_PROJECT_DIR walk-up runs; the walk-up's
# probe is covered by db-probe-readonly.test.sh.
run_helper() {
  local proj="$1"
  shift
  : > "$LOG"
  RC=0
  OUT=$(cd / && env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_ROOT PATH="$BIN:$PATH" TMPDIR="$SCRATCH" \
    TRAJECTORY_DB_PATH="$(db_in "$proj")" bash "$READONLY" "$@" 2>"$TMP/stderr") || RC=$?
  ERR=$(cat "$TMP/stderr")
}

assert_snapshot_only() {
  assert_not_contains "$(grep -v -e 'VACUUM INTO' -e 'snap.db' "$LOG")" "trajectory.db" "the DB is opened only to take the snapshot"
}

assert_scratch_clean() {
  assert_eq "" "$(find "$SCRATCH" -mindepth 1)" "scratch snapshot removed on exit"
}

# --- a WAL DB held open, rows committed only to its -wal -------------------
HELD_PROJ="$TMP/held"
HELD=$(db_in "$HELD_PROJ")
mkdir -p "$(dirname "$HELD")"
migrated_db "$HELD"
mkfifo "$TMP/holder.fifo"
"$REAL_SQLITE3" "$HELD" < "$TMP/holder.fifo" >/dev/null 2>&1 &
HOLDER=$!
exec 9>"$TMP/holder.fifo"
printf 'SELECT count(*) FROM sqlite_master;\n' >&9
i=0
while [ ! -e "$HELD-shm" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
"$REAL_SQLITE3" "$HELD" ".timeout 5000" "$ROWS"
PRISTINE="$TMP/pristine"
mkdir -p "$PRISTINE"
cp "$HELD" "$PRISTINE/trajectory.db"
cp "$HELD-wal" "$PRISTINE/trajectory.db-wal"

test_case "a WAL DB with its -shm (holder open) keeps the direct read-only path"
run_helper "$HELD_PROJ" config_get '{"key":"sentinel"}'
assert_contains "$OUT" "wal-only" "row read"
assert_not_contains "$(cat "$LOG")" "VACUUM INTO" "no snapshot taken"

exec 9>&-
wait "$HOLDER" 2>/dev/null || true

# wal_copy <project> — the held DB's main file and -wal, without its -shm.
wal_copy() {
  local db
  db=$(db_in "$1")
  mkdir -p "$(dirname "$db")"
  cp "$PRISTINE/trajectory.db" "$db"
  cp "$PRISTINE/trajectory.db-wal" "$db-wal"
  touch -t 202001010000 "$db" "$db-wal"
}

test_case "setup: the copy's rows are only in its -wal, and it has no -shm"
mkdir -p "$TMP/mainonly"
cp "$PRISTINE/trajectory.db" "$TMP/mainonly/main.db"
assert_eq "0 0" "$("$REAL_SQLITE3" "file:$TMP/mainonly/main.db?immutable=1" "SELECT (SELECT count(*) FROM plugin_config WHERE key = 'sentinel') || ' ' || (SELECT count(*) FROM issues WHERE id = 1);")" "main file holds no seeded rows"
MAIN_ISSUES=$("$REAL_SQLITE3" "file:$TMP/mainonly/main.db?immutable=1" "SELECT count(*) FROM issues;")
if [ -s "$PRISTINE/trajectory.db-wal" ]; then _pass; else _fail "the -wal is empty"; fi

COPY_PROJ="$TMP/copy"
COPY=$(db_in "$COPY_PROJ")
wal_copy "$COPY_PROJ"
if [ ! -e "$COPY-shm" ]; then _pass; else _fail "the copy has a -shm"; fi

test_case "WAL copy without -shm: the rows in its -wal come back, the DB is unchanged"
main_before=$(fingerprint "$COPY")
wal_before=$(fingerprint "$COPY-wal")
run_helper "$COPY_PROJ" config_get '{"key":"sentinel"}'
assert_eq "0" "$RC" "exit 0"
assert_eq '"wal-only"' "$OUT" "sentinel row read from the -wal"
assert_contains "$(cat "$LOG")" "VACUUM INTO" "read through a snapshot"
assert_snapshot_only
assert_eq "$main_before" "$(fingerprint "$COPY")" "main file size, mtime and content unchanged"
assert_eq "$wal_before" "$(fingerprint "$COPY-wal")" "-wal size, mtime and content unchanged"
assert_scratch_clean

test_case "WAL copy without -shm: issue_get and --dry-run read the -wal rows"
COPY2_PROJ="$TMP/copy2"
wal_copy "$COPY2_PROJ"
run_helper "$COPY2_PROJ" issue_get '{"issue_id":1}'
assert_contains "$OUT" "row in the wal" "issue row read"
COPY3_PROJ="$TMP/copy3"
wal_copy "$COPY3_PROJ"
run_helper "$COPY3_PROJ" --dry-run
assert_contains "$OUT" "\"db_path\":\"$(db_in "$COPY3_PROJ")\"" "dry-run names the DB, not the snapshot"
assert_contains "$OUT" "\"issues_count\":$((MAIN_ISSUES + 1))" "dry-run counts the -wal row"
assert_scratch_clean

test_case "detached WAL DB (no -wal, no -shm): rows come back, nothing appears beside it"
DET_PROJ="$TMP/detached"
DET=$(db_in "$DET_PROJ")
mkdir -p "$(dirname "$DET")"
migrated_db "$DET"
"$REAL_SQLITE3" "$DET" "$ROWS PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f "$DET-wal" "$DET-shm"
touch -t 202001010000 "$DET"
main_before=$(fingerprint "$DET")
run_helper "$DET_PROJ" config_get '{"key":"sentinel"}'
assert_eq "0" "$RC" "exit 0"
assert_eq '"wal-only"' "$OUT" "sentinel row read"
assert_contains "$(cat "$LOG")" "immutable=1" "snapshot taken from an immutable open"
assert_snapshot_only
assert_eq "$main_before" "$(fingerprint "$DET")" "main file size, mtime and content unchanged"
assert_eq "absent absent" "$(fingerprint "$DET-wal") $(fingerprint "$DET-shm")" "no -wal or -shm created"
assert_scratch_clean

test_case "a snapshot that cannot be taken prints the sqlite error and exits non-zero"
RO_PROJ="$TMP/ro"
RO=$(db_in "$RO_PROJ")
wal_copy "$RO_PROJ"
chmod 555 "$(dirname "$RO")"
if [ -w "$(dirname "$RO")" ]; then
  chmod 755 "$(dirname "$RO")"
  _pass
  echo "  note: running as a user who can write a 555 directory; read-only directory case skipped"
else
  run_helper "$RO_PROJ" config_get '{"key":"sentinel"}'
  chmod 755 "$(dirname "$RO")"
  if [ "$RC" -ne 0 ]; then _pass; else _fail "exit 0 on a failed snapshot"; fi
  assert_contains "$ERR" "snapshot of $RO failed" "stderr names the failed snapshot"
  assert_contains "$ERR" "unable to open database file" "stderr carries the sqlite error"
  assert_eq "" "$OUT" "no result printed"
  assert_scratch_clean
fi

test_case "a rollback-journal DB keeps the direct read-only path"
DEL_PROJ="$TMP/delete"
DEL=$(db_in "$DEL_PROJ")
mkdir -p "$(dirname "$DEL")"
migrated_db "$DEL"
"$REAL_SQLITE3" "$DEL" "PRAGMA journal_mode=DELETE; $ROWS" >/dev/null
run_helper "$DEL_PROJ" config_get '{"key":"sentinel"}'
assert_eq '"wal-only"' "$OUT" "sentinel row read"
assert_not_contains "$(cat "$LOG")" "VACUUM INTO" "no snapshot taken"

summarize
