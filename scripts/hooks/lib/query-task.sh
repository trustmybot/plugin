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
