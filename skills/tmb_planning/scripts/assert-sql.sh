#!/usr/bin/env bash
# Dry-run / smoke assertion as a verification[] command.
#
#   bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/assert-sql.sh" <db> "<sql>" <expected> [--op eq|ge|le]
#   bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/assert-sql.sh" --self-test
#
# Runs <sql> read-only against a private snapshot of <db> (and its -wal, folded
# in), so <db> itself is never opened; point it at a cp of the reference data.
# compares the single value it returns to <expected> and prints one line.
#   eq  string equality (default)
#   ge  numeric: result >= expected
#   le  numeric: result <= expected
# A NULL result or no rows fails under every op ("got NULL or no rows").
# The snapshot is removed on exit, including on INT or TERM.
# Exit 0 = pass, 1 = mismatch, 2 = usage error, missing DB, or SQL error.
set -uo pipefail

usage() {
  echo 'usage: assert-sql.sh <db> "<sql>" <expected> [--op eq|ge|le] | --self-test' >&2
  exit 2
}

is_number() {
  [[ "${1:-}" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]
}

assert_sql() {
  local db="" sql="" expected="" op="eq" positional=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --op) [ "$#" -ge 2 ] || usage; op="$2"; shift 2 ;;
      --op=*) op="${1#--op=}"; shift ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  [ "${#positional[@]}" -eq 3 ] || usage
  db="${positional[0]}" sql="${positional[1]}" expected="${positional[2]}"
  case "$op" in eq|ge|le) ;; *) usage ;; esac

  if [ ! -f "$db" ]; then
    echo "assert-sql: ERROR database not found: $db"
    return 2
  fi
  command -v sqlite3 >/dev/null 2>&1 || { echo "assert-sql: ERROR sqlite3 not on PATH"; return 2; }

  local out rc=0
  snap=$(mktemp -d "${TMPDIR:-/tmp}/assert-sql.XXXXXX")
  cp "$db" "$snap/ref.db" && { [ ! -f "$db-wal" ] || cp "$db-wal" "$snap/ref.db-wal"; } \
    && sqlite3 "$snap/ref.db" "PRAGMA journal_mode=DELETE;" >/dev/null 2>"$snap/err" \
    && out=$(sqlite3 -readonly -bail "$snap/ref.db" "$sql" 2>"$snap/err") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "assert-sql: ERROR query failed: $(head -1 "$snap/err" 2>/dev/null)"
    return 2
  fi

  if [ -z "$out" ]; then
    echo "assert-sql: FAIL got NULL or no rows, want $op '$expected': $sql"
    return 1
  fi

  if [ "$(printf '%s' "$out" | grep -c '')" -gt 1 ]; then
    echo "assert-sql: FAIL expected a single value, got $(printf '%s\n' "$out" | grep -c '') rows: $sql"
    return 1
  fi

  local ok=1
  case "$op" in
    eq) [ "$out" = "$expected" ] && ok=0 ;;
    ge|le)
      if ! is_number "$out" || ! is_number "$expected"; then
        echo "assert-sql: FAIL --op $op needs numbers, got '$out' vs '$expected': $sql"
        return 1
      fi
      if awk -v a="$out" -v b="$expected" -v o="$op" 'BEGIN { exit !((o == "ge" && a + 0 >= b + 0) || (o == "le" && a + 0 <= b + 0)) }'; then
        ok=0
      fi
      ;;
  esac

  if [ "$ok" -eq 0 ]; then
    echo "assert-sql: PASS '$out' $op '$expected': $sql"
    return 0
  fi
  echo "assert-sql: FAIL got '$out', want $op '$expected': $sql"
  return 1
}

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

self_test() {
  local dir db self="${BASH_SOURCE[0]}" failures=0 before after
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' RETURN
  db="$dir/ref.db"
  sqlite3 "$db" "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b'), (NULL);"

  expect() {
    local want="$1" name="$2" got
    shift 2
    bash "$self" "$@" >/dev/null 2>&1
    got=$?
    if [ "$got" -eq "$want" ]; then
      echo "PASS $name"
    else
      echo "FAIL $name (exit $got, want $want)"
      failures=$((failures + 1))
    fi
  }

  expect 0 "eq match" "$db" "SELECT count(*) FROM t" 3
  expect 0 "eq on text" "$db" "SELECT v FROM t WHERE id = 1" a
  expect 0 "ge match" "$db" "SELECT count(*) FROM t WHERE v IS NOT NULL" 1 --op ge
  expect 0 "le match" "$db" "SELECT count(*) FROM t WHERE v IS NULL" 1 --op le
  expect 1 "eq mismatch" "$db" "SELECT count(*) FROM t" 4
  expect 1 "ge mismatch" "$db" "SELECT count(*) FROM t" 5 --op ge
  expect 1 "le mismatch" "$db" "SELECT count(*) FROM t" 2 --op le
  expect 1 "more than one row" "$db" "SELECT id FROM t" 1
  local op
  for op in eq ge le; do
    expect 1 "NULL result fails ($op)" "$db" "SELECT v FROM t WHERE id = 3" 0 --op "$op"
    expect 1 "no rows fails ($op)" "$db" "SELECT v FROM t WHERE id = 99" 0 --op "$op"
  done
  expect 1 "NULL result fails against an empty expectation" "$db" "SELECT v FROM t WHERE id = 3" ""
  if [[ "$(bash "$self" "$db" "SELECT v FROM t WHERE id = 3" 0 2>&1)" == *"got NULL or no rows"* ]]; then
    echo "PASS NULL result is named"
  else
    echo "FAIL NULL result is not named"
    failures=$((failures + 1))
  fi
  if [[ "$(bash "$self" "$db" "SELECT v FROM t WHERE id = 99" 0 --op ge 2>&1)" == *"got NULL or no rows"* ]]; then
    echo "PASS no-row result is named"
  else
    echo "FAIL no-row result is not named"
    failures=$((failures + 1))
  fi
  expect 2 "missing DB" "$dir/absent.db" "SELECT 1" 1
  expect 2 "bad op" "$db" "SELECT 1" 1 --op gt

  local wal="$dir/wal.db"
  sqlite3 "$wal" "PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('w');" >/dev/null
  rm -f "$wal-shm" "$wal-wal"
  expect 0 "WAL-mode copy without -shm is readable" "$wal" "SELECT v FROM t" w
  if [ ! -e "$wal-shm" ] && [ ! -e "$wal-wal" ]; then
    echo "PASS WAL-mode copy left without -shm/-wal"
  else
    echo "FAIL WAL-mode copy grew a -shm/-wal"
    failures=$((failures + 1))
  fi

  touch -t 202001010000 "$db"
  before=$(mtime "$db")
  expect 2 "write is refused" "$db" "INSERT INTO t (v) VALUES ('c')" 0
  expect 0 "read leaves the DB as it was" "$db" "SELECT count(*) FROM t" 3
  after=$(mtime "$db")
  if [ "$before" = "$after" ]; then
    echo "PASS DB mtime unchanged"
  else
    echo "FAIL DB mtime changed ($before -> $after)"
    failures=$((failures + 1))
  fi

  local tmp="$dir/tmp" slow pid waited=0
  mkdir "$tmp"
  slow="WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000000) SELECT count(*) FROM c"
  set -m
  TMPDIR="$tmp" bash "$self" "$db" "$slow" 0 >/dev/null 2>&1 &
  pid=$!
  set +m
  while [ "$waited" -lt 100 ] && ! compgen -G "$tmp/*/ref.db" >/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
  done
  sleep 0.3
  kill -INT -- "-$pid" 2>/dev/null
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null
    echo "FAIL SIGINT did not stop the run"
    failures=$((failures + 1))
  elif [ -z "$(ls -A "$tmp")" ]; then
    echo "PASS SIGINT leaves no temp copy"
  else
    echo "FAIL SIGINT left a temp copy: $(ls -A "$tmp")"
    failures=$((failures + 1))
  fi
  wait "$pid" 2>/dev/null

  if [ "$failures" -eq 0 ]; then
    echo "assert-sql self-test: all passed"
    return 0
  fi
  echo "assert-sql self-test: $failures failed"
  return 1
}

snap=""
trap 'rm -rf "$snap"' EXIT
trap 'rm -rf "$snap"; exit 130' INT
trap 'rm -rf "$snap"; exit 143' TERM

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi
assert_sql "$@"
exit $?
