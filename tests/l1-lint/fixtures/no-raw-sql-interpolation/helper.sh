#!/usr/bin/env bash
# Self-test fixture for no-raw-sql-interpolation.sh: a read helper whose $sql
# parameter is a whole statement, allowlisted by function name.

fixture_sqlite_ro() {
  local db="$1"
  local sql="$2"
  sqlite3 -readonly "$db" "$sql" 2>/dev/null || true
}
