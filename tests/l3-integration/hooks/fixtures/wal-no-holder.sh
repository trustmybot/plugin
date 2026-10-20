#!/usr/bin/env bash
# Sourced by the gate suites (require-task-spec, swe-verification-gate,
# git-push-guard). A gate must read a healthy WAL trajectory DB that no process
# holds open (its -shm/-wal absent), keep the -readonly fast path while a holder
# exists, and fail closed when neither read can open the DB.
#
# wal_gate_cases <label> <hook> <db> <project_root> <input> <expect> <forbid> [<cwd>]
#   <db> sits under <project_root>. The hook's normal decision for <input>
#   contains <expect> (skipped when empty) and never <forbid>, a string a
#   failed (empty) read would produce. Asserts:
#     1. no holder: the gate decides normally (not "unavailable"). Where
#        sqlite3 -readonly cannot open a WAL DB with no -shm (macOS Apple
#        sqlite 3.51) the read runs without -readonly. Where it can (Linux
#        sqlite 3.45) the fallback is not exercised: the case asserts a read
#        ran and prints a note;
#     2. -shm/-wal from that read sit beside <db>; HOME and TMPDIR stay empty;
#     3. a holder open: the gate decides normally, sqlite3 starts -readonly
#        and no read runs without it;
#     4. the DB directory read-only with no -shm: no read opens it, so the
#        gate denies "trajectory DB unavailable".

WAL_REAL_SQLITE3="$(command -v sqlite3)"

wal_detach() {
  "$WAL_REAL_SQLITE3" "$1" "PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  rm -f "$1-shm" "$1-wal"
}

wal_wrapper() {
  mkdir -p "$1"
  cat > "$1/sqlite3" <<WRAP
#!/usr/bin/env bash
printf '%s\n' "\${1:-}" >> "$2"
exec "$WAL_REAL_SQLITE3" "\$@"
WRAP
  chmod +x "$1/sqlite3"
}

wal_holder_start() {
  local db="$1" fifo="$2" i=0
  mkfifo "$fifo"
  "$WAL_REAL_SQLITE3" "$db" < "$fifo" >/dev/null 2>&1 &
  WAL_HOLDER_PID=$!
  exec 9>"$fifo"
  printf 'SELECT count(*) FROM sqlite_master;\n' >&9
  while [ ! -f "$db-shm" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}

wal_holder_stop() {
  exec 9>&-
  wait "$WAL_HOLDER_PID" 2>/dev/null || true
}

wal_run() {
  local hook="$1" input="$2" db="$3" bin="$4" home="$5" tmp="$6" cwd="$7"
  (cd "$cwd" && printf '%s' "$input" | PATH="$bin:$PATH" HOME="$home" TMPDIR="$tmp" TRAJECTORY_DB_PATH="$db" bash "$hook" 2>&1 || true)
}

wal_gate_cases() {
  local label="$1" hook="$2" db="$3" proj="$4" input="$5" expect="$6" forbid="$7" cwd="${8:-$PWD}"
  local work bin log home tmp out strays dir readonly_opens
  work=$(mktemp -d "${TMPDIR:-/tmp}/tmb-wal-no-holder.XXXXXX")
  bin="$work/bin" log="$work/sqlite3.log" home="$work/home" tmp="$work/tmp"
  mkdir -p "$home" "$tmp"
  wal_wrapper "$bin" "$log"

  test_case "$label: WAL DB with no holder → the gate reads it and decides normally"
  wal_detach "$db"
  readonly_opens=0
  if "$WAL_REAL_SQLITE3" -readonly "$db" "SELECT 1;" >/dev/null 2>&1; then
    readonly_opens=1
  fi
  : > "$log"
  out=$(wal_run "$hook" "$input" "$db" "$bin" "$home" "$tmp" "$cwd")
  assert_not_contains "$out" "trajectory DB unavailable" "no holder is not an unavailable DB"
  [ -z "$expect" ] || assert_contains "$out" "$expect" "the gate's normal decision"
  assert_not_contains "$out" "$forbid" "no read came back empty"
  if [ "$readonly_opens" = 1 ]; then
    if [ -s "$log" ]; then _pass; else _fail "no sqlite3 invocation was logged"; fi
    echo "  note: sqlite3 -readonly opens a detached WAL DB on this platform; -cmd fallback not exercised"
  else
    assert_contains "$(cat "$log")" "-cmd" "the read ran without -readonly"
  fi

  test_case "$label: the no-holder read leaves -shm/-wal beside the DB, nothing under HOME or TMPDIR"
  strays=$(find "$proj" \( -name '*-shm' -o -name '*-wal' \) ! -path "$db-shm" ! -path "$db-wal"; find "$home" "$tmp" -mindepth 1)
  assert_eq "" "$strays" "no sidecar outside the DB's directory, HOME and TMPDIR untouched"

  test_case "$label: WAL DB with a holder open → -readonly reads only"
  wal_detach "$db"
  wal_holder_start "$db" "$work/holder.fifo"
  : > "$log"
  out=$(wal_run "$hook" "$input" "$db" "$bin" "$home" "$tmp" "$cwd")
  wal_holder_stop
  assert_not_contains "$out" "trajectory DB unavailable" "a held DB is not unavailable"
  [ -z "$expect" ] || assert_contains "$out" "$expect" "the gate's normal decision"
  assert_not_contains "$out" "$forbid" "no read came back empty"
  assert_eq "-readonly" "$(head -1 "$log")" "the first sqlite3 invocation is -readonly"
  assert_not_contains "$(cat "$log")" "-cmd" "no read ran without -readonly"

  test_case "$label: a DB no read can open → deny with the unavailable reason"
  wal_detach "$db"
  dir=$(dirname "$db")
  chmod 555 "$dir"
  out=$(wal_run "$hook" "$input" "$db" "$bin" "$home" "$tmp" "$cwd")
  chmod 755 "$dir"
  assert_contains "$out" '"permissionDecision":"deny"' "fails closed"
  assert_contains "$out" "trajectory DB unavailable" "deny names the unavailable DB"

  rm -rf "$work"
}
