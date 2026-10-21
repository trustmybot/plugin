#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154
A=$(tmb_gate_read "$DB" "UPDATE tasks SET status = 'done';")
B=$(tmb_gate_read "$DB" \
  "DELETE FROM audit;")
C=$(tmb_gate_read "$DB" "SELECT 1; INSERT INTO audit VALUES (1);")
D=$(tmb_gate_read "$DB" "PRAGMA journal_mode=DELETE;")
E=$(tmb_gate_read "$DB" "PRAGMA user_version = 3;")
F=$(tmb_gate_read "$DB" "$SQL")
G=$(tmb_gate_read "$DB" "WITH t AS (SELECT 1) DELETE FROM tasks;")
H=$(tmb_gate_read "$DB" ".shell touch x")
I=$(tmb_gate_read "$DB" "PRAGMA writable_schema;")
J=$(tmb_sqlite_ro "$DB" "DELETE FROM repos;")
K=$(tmb_sqlite_ro "$DB" "$select LIMIT 1;")
L=$(tmb_gate_read "$DB" "WITH t AS (SELECT 1) REPLACE INTO tasks (id) SELECT 1 FROM t;")
