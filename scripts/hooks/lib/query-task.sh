#!/usr/bin/env bash
# Library: SQLite query helpers for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
set -euo pipefail

tmb_db_path() {
  local p="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/tmb}/trajectory.db"
  [ -f "$p" ] && echo "$p"
}

tmb_have_sqlite() {
  command -v sqlite3 >/dev/null 2>&1
}

# Print branch_ids of tasks that are completed in DB but missing
# validation_attempts row with verdict=pass.
tmb_unsigned_tasks() {
  local db
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT t.branch_id
      FROM tasks t
     WHERE t.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM validation_attempts v
          WHERE v.task_id = CAST(t.id AS TEXT)
            AND v.verdict = 'pass'
       );
  "
}

# tmb_config_get <key>
# Prints the scalar value stored in plugin_config for <key>, unquoted.
# Prints empty string when: key missing, DB absent, sqlite3 unavailable.
# Never fails the caller.
tmb_config_get() {
  local key="$1"
  local db
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT json_extract(value_json, '$')
      FROM plugin_config
     WHERE key = '${key}';
  " 2>/dev/null || true
}

# tmb_config_raw <key>
# Prints the raw value_json column for <key> without JSON extraction.
# Prints empty string when: key missing, DB absent, sqlite3 unavailable.
# Never fails the caller.
tmb_config_raw() {
  local key="$1"
  local db
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT value_json
      FROM plugin_config
     WHERE key = '${key}';
  " 2>/dev/null || true
}

# tmb_config_array <key>
# Prints one element per line from a JSON-array-valued plugin_config key.
# Prints nothing when: key missing, DB absent, sqlite3 unavailable.
# Never fails the caller.
tmb_config_array() {
  local key="$1"
  local db raw
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  raw=$(sqlite3 "$db" "
    SELECT value_json
      FROM plugin_config
     WHERE key = '${key}';
  " 2>/dev/null || true)
  [ -z "$raw" ] && return 0
  echo "$raw" | jq -r '.[]' 2>/dev/null || true
}

# tmb_task_spec_status <task_id>
# Prints two lines: <status>\n<body_len> for the given tasks row.
# Prints nothing when the row does not exist, DB is absent, or sqlite3 is unavailable.
# Callers must check tmb_db_path / tmb_have_sqlite before calling if they need
# to distinguish "DB missing" from "row missing".
tmb_task_spec_status() {
  local task_id="$1"
  local db
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT status, LENGTH(COALESCE(spec_body_md, ''))
      FROM tasks
     WHERE id = ${task_id};
  " 2>/dev/null | tr '|' '\n' || true
}
