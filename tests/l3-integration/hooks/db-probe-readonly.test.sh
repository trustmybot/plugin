#!/usr/bin/env bash
# Tests for _tmb_db_probe (scripts/hooks/lib/query-task.sh) on the
# CLAUDE_PROJECT_DIR walk-up (GH 1636): resolving the trajectory DB never
# writes it. A WAL DB whose rows sit only in a non-empty -wal and whose -shm is
# gone, a detached WAL DB (no -wal, no -shm), and a WAL DB held open with its
# -shm all resolve, every sqlite3 open is -readonly, and the main file's size
# and mtime and the -wal's size and checksum stay as they were: no checkpoint
# runs before bro-sqlite-readonly.sh snapshots the DB.
#
# Everything lives under a temp HOME and each state dir holds a `standalone`
# file, so the walk stops at the planted DB and never reaches a live one. The
# test flags are unset — under them the hooks never walk.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/lib/tmpdir-cleanup.sh
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not installed"; exit 0; }
REAL_SQLITE3="$(command -v sqlite3)"

TMP=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-db-probe-readonly.XXXXXX")" && pwd -P)
trap 'tmpdir_cleanup "$TMP"' EXIT

FAKE_HOME="$TMP/home" BIN="$TMP/bin" LOG="$TMP/sqlite3.log"
mkdir -p "$FAKE_HOME" "$BIN"
cat > "$BIN/sqlite3" <<WRAP
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
exec "$REAL_SQLITE3" "\$@"
WRAP
chmod +x "$BIN/sqlite3"

SCHEMA="CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);"
ROWS="INSERT INTO tasks (id, prompt_bearing) VALUES (1, 0); CREATE TABLE wal_only (x);"

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

# fingerprint <file> — size, mtime and checksum, or "absent".
fingerprint() {
  [ -e "$1" ] || { echo absent; return; }
  printf '%s %s %s\n' "$(wc -c <"$1" | tr -d ' ')" "$(mtime "$1")" "$(cksum <"$1" | cut -d' ' -f1)"
}

# project <name> — prints the DB path of a new project under the temp HOME.
project() {
  local db="$FAKE_HOME/$1/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  touch "$(dirname "$db")/standalone"
  printf '%s\n' "$db"
}

# resolve <project dir> — tmb_db_path as a hook sees it; sets OUT and RC.
resolve() {
  : > "$LOG"
  RC=0
  OUT=$(cd / && env -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT \
    HOME="$FAKE_HOME" PATH="$BIN:$PATH" CLAUDE_PROJECT_DIR="$1" \
    bash -c '. "$1"; tmb_db_path' _ "$LIB" 2>/dev/null) || RC=$?
}

assert_readonly_opens() {
  if [ -s "$LOG" ]; then _pass; else _fail "no sqlite3 invocation was logged"; fi
  assert_eq "" "$(grep -v '^-readonly ' "$LOG")" "every sqlite3 invocation starts -readonly"
}

holder_start() {
  local i=0
  mkfifo "$2"
  "$REAL_SQLITE3" "$1" < "$2" >/dev/null 2>&1 &
  HOLDER=$!
  exec 9>"$2"
  printf 'SELECT count(*) FROM sqlite_master;\n' >&9
  while [ ! -e "$1-shm" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}

holder_stop() {
  exec 9>&-
  wait "$HOLDER" 2>/dev/null || true
}

# --- a WAL DB held open with its -shm, rows committed only to its -wal -------
HELD=$(project held)
"$REAL_SQLITE3" "$HELD" "PRAGMA journal_mode=WAL; $SCHEMA" >/dev/null
holder_start "$HELD" "$TMP/holder.fifo"
"$REAL_SQLITE3" "$HELD" ".timeout 5000" "$ROWS"
PRISTINE="$TMP/pristine"
mkdir -p "$PRISTINE"
cp "$HELD" "$PRISTINE/trajectory.db"
cp "$HELD-wal" "$PRISTINE/trajectory.db-wal"

test_case "WAL DB with its -shm: resolves from CLAUDE_PROJECT_DIR, the DB is unchanged"
touch -t 202001010000 "$HELD"
main_before=$(fingerprint "$HELD")
wal_before=$(fingerprint "$HELD-wal")
if [ -e "$HELD-shm" ] && [ -s "$HELD-wal" ]; then _pass; else _fail "setup: no -shm or an empty -wal"; fi
resolve "$FAKE_HOME/held"
assert_eq "0" "$RC" "resolution succeeded"
assert_eq "$HELD" "$OUT" "tmb_db_path is the planted DB"
assert_readonly_opens
assert_eq "$main_before" "$(fingerprint "$HELD")" "main file size, mtime and content unchanged"
assert_eq "$wal_before" "$(fingerprint "$HELD-wal")" "-wal size, mtime and checksum unchanged"
holder_stop

# --- the same DB copied without its -shm: WAL-cold, -wal non-empty -----------
COLD=$(project cold)
cp "$PRISTINE/trajectory.db" "$COLD"
cp "$PRISTINE/trajectory.db-wal" "$COLD-wal"
touch -t 202001010000 "$COLD" "$COLD-wal"

test_case "setup: the WAL-cold copy has a non-empty -wal and no -shm"
if [ -s "$COLD-wal" ] && [ ! -e "$COLD-shm" ]; then _pass; else _fail "the copy is not WAL-cold"; fi
assert_eq "0" "$("$REAL_SQLITE3" "file:$PRISTINE/trajectory.db?immutable=1" "SELECT count(*) FROM sqlite_master WHERE name = 'wal_only';")" "the main file lacks what the -wal holds"

test_case "WAL-cold DB with a non-empty -wal: resolves, nothing is checkpointed"
main_before=$(fingerprint "$COLD")
wal_before=$(fingerprint "$COLD-wal")
resolve "$FAKE_HOME/cold"
assert_eq "0" "$RC" "resolution succeeded"
assert_eq "$COLD" "$OUT" "tmb_db_path is the planted DB"
assert_readonly_opens
assert_eq "$main_before" "$(fingerprint "$COLD")" "main file size, mtime and content unchanged"
assert_eq "$wal_before" "$(fingerprint "$COLD-wal")" "-wal size, mtime and checksum unchanged"

# --- a detached WAL DB: no -wal, no -shm -------------------------------------
DET=$(project detached)
"$REAL_SQLITE3" "$DET" "PRAGMA journal_mode=WAL; $SCHEMA $ROWS PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f "$DET-wal" "$DET-shm"
touch -t 202001010000 "$DET"
cp "$DET" "$TMP/capability.db"
readonly_opens=0
"$REAL_SQLITE3" -readonly "$TMP/capability.db" "SELECT 1;" >/dev/null 2>&1 && readonly_opens=1

test_case "detached WAL DB: resolves, the main file is unchanged, no -wal is written"
main_before=$(fingerprint "$DET")
resolve "$FAKE_HOME/detached"
assert_eq "0" "$RC" "resolution succeeded"
assert_eq "$DET" "$OUT" "tmb_db_path is the planted DB"
assert_readonly_opens
assert_eq "$main_before" "$(fingerprint "$DET")" "main file size, mtime and content unchanged"
if [ ! -s "$DET-wal" ]; then _pass; else _fail "the probe wrote a -wal"; fi
if [ "$readonly_opens" = 1 ]; then
  echo "  note: sqlite3 -readonly opens a detached WAL DB on this platform; the immutable retry is not exercised"
else
  assert_contains "$(cat "$LOG")" "immutable=1" "-readonly failed, so the probe retried immutable"
  assert_eq "absent absent" "$(fingerprint "$DET-wal") $(fingerprint "$DET-shm")" "no -wal or -shm created"
fi

summarize
