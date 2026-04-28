#!/usr/bin/env bash
# Library: SQLite query helpers for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
set -euo pipefail

# tmb_db_path
# Resolve the trajectory DB path:
#   1. TRAJECTORY_DB_PATH env override wins (tests + advanced setups).
#   2. Otherwise: walk up from cwd to filesystem root, looking for
#      <dir>/.claude/<plugin-name>/trajectory.db at each level. First hit wins.
#      This handles uniformly:
#        - single-repo CC (CC inside a git repo): DB at git-root, found early.
#        - workspace pattern (CC outside a git repo, with one or more product
#          repos as siblings): DB at workspace launch dir, found above git-root.
#        - submodule monorepo (root + nested submodule repos): DB at parent
#          repo, found via walk-up from inside any submodule.
#        - SWE worktrees (.claude/worktrees/<slug>/): walks past the worktree
#          to find the DB at the repo or workspace level.
#   3. Tests with per-worktree DB fixtures should set TRAJECTORY_DB_PATH
#      explicitly to pin the resolution.
# Prints the path only if the file exists; non-zero exit if no DB found.
tmb_db_path() {
  local plugin_name="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    plugin_name=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  if [ -n "${TRAJECTORY_DB_PATH:-}" ]; then
    [ -f "$TRAJECTORY_DB_PATH" ] && echo "$TRAJECTORY_DB_PATH"
    return 0
  fi
  local dir
  dir="$(pwd)"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    local candidate="$dir/.claude/$plugin_name/trajectory.db"
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

tmb_have_sqlite() {
  command -v sqlite3 >/dev/null 2>&1
}

# Print branch_ids of tasks that are closed and have a commit_sha but
# lack a passing validation_attempts row. Under the bro-as-task-gate
# doctrine, bro auto-flips tasks to 'closed' immediately after SWE
# returns; pr-reviewer fires only at push time. Unsigned == closed
# tasks whose commits haven't been reviewed yet.
tmb_unsigned_tasks() {
  local db
  db=$(tmb_db_path) || true
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT t.branch_id
      FROM tasks t
     WHERE t.status = 'closed'
       AND t.commit_sha IS NOT NULL
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
    SELECT status, LENGTH(COALESCE(spec_body, ''))
      FROM tasks
     WHERE id = ${task_id};
  " 2>/dev/null | tr '|' '\n' || true
}
