#!/usr/bin/env bash
# shellcheck disable=SC2034
# tmb_gate_read in a comment is not a call site.
A=$(tmb_gate_read "$DB" "SELECT id FROM tasks WHERE id = ${ID};")
B=$(tmb_gate_read "$DB" \
  "WITH t AS (SELECT 1 AS x) SELECT x FROM t;")
C=$(tmb_gate_read "$DB" "
  -- leading comment
  SELECT count(*) FROM tasks;
")
D=$(tmb_gate_read "$DB" 'PRAGMA journal_mode;')
E=$(tmb_gate_read "$DB" "PRAGMA table_info(tasks);")
F=$(tmb_gate_read "$DB" "/* lead */ PRAGMA user_version;")
G=$(tmb_sqlite_ro "$DB" "SELECT path FROM repos LIMIT 1;")
