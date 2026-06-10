#!/usr/bin/env bash
# Library: SQLite query helpers for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.

# _TMB_DB_PATH_CACHE: process-level memoization of the resolved DB path.
# Set on first successful resolution; read on subsequent calls.
_TMB_DB_PATH_CACHE=""

# tmb_db_path
# Resolve the trajectory DB path:
#   1. TRAJECTORY_DB_PATH env override wins (tests + advanced setups).
#   2. Walk up from cwd to filesystem root, collecting all ancestor levels
#      that contain <dir>/.claude/<plugin-name>/trajectory.db.
#      Outermost match wins. Walking up from cwd, we collect all ancestor
#      matches and return the topmost. Inner sibling DBs (e.g. stale leftovers
#      from a previous workspace layout) won't shadow the active launch-dir DB.
#      This handles uniformly:
#        - single-repo CC (CC inside a git repo): DB at git-root.
#        - workspace pattern (CC outside a git repo, with one or more product
#          repos as siblings): DB at workspace launch dir, above git-root.
#        - submodule monorepo (root + nested submodule repos): DB at parent
#          repo, found via walk-up from inside any submodule.
#        - SWE worktrees (.claude/worktrees/<slug>/): walks past the worktree
#          to find the DB at the repo or workspace level.
#   3. Sentinel file ($HOME/.claude/<plugin-name>-active-workspace) as fallback
#      when walk-up finds nothing — covers subagents that inherit cwd=~ and
#      lack env vars.
#   4. Tests with per-worktree DB fixtures should set TRAJECTORY_DB_PATH
#      explicitly to pin the resolution.
# Prints the path only if the file exists; non-zero exit if no DB found.
# Memoizes the result in _TMB_DB_PATH_CACHE for the lifetime of the process.
tmb_db_path() {
  if [ -n "$_TMB_DB_PATH_CACHE" ]; then
    echo "$_TMB_DB_PATH_CACHE"
    return 0
  fi
  local plugin_name="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    plugin_name=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  if [ -n "${TRAJECTORY_DB_PATH:-}" ]; then
    if [ -f "$TRAJECTORY_DB_PATH" ]; then
      _TMB_DB_PATH_CACHE="$TRAJECTORY_DB_PATH"
      echo "$_TMB_DB_PATH_CACHE"
    fi
    return 0
  fi
  # P0 guard: do NOT walk into the user's HOME from a descendant cwd.
  # A stale ~/.claude/<plugin>/trajectory.db (from a prior buggy session or a
  # test artifact) used to be silently adopted as the live DB on every launch.
  # Project state belongs to a project. Mirrors db.ts findExistingDbUp.
  local start
  start="$(pwd)"
  local candidates=()
  local dir
  dir="$start"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ "$dir" = "$HOME" ] && [ "$start" != "$HOME" ]; then
      break
    fi
    local candidate="$dir/.claude/$plugin_name/trajectory.db"
    [ -f "$candidate" ] && candidates+=("$candidate")
    dir="$(dirname "$dir")"
  done
  if [ ${#candidates[@]} -gt 0 ]; then
    _TMB_DB_PATH_CACHE="${candidates[${#candidates[@]}-1]}"
    echo "$_TMB_DB_PATH_CACHE"
    return 0
  fi
  # Sentinel fallback: subagents inherit cwd=~ and lack env vars.
  local sentinel="$HOME/.claude/${plugin_name}-active-workspace"
  if [ -f "$sentinel" ]; then
    local ws
    ws=$(head -1 "$sentinel" 2>/dev/null)
    if [ -n "$ws" ]; then
      local sentinel_db="$ws/.claude/$plugin_name/trajectory.db"
      if [ -f "$sentinel_db" ]; then
        _TMB_DB_PATH_CACHE="$sentinel_db"
        echo "$_TMB_DB_PATH_CACHE"
        return 0
      fi
    fi
  fi
  return 1
}

tmb_have_sqlite() {
  command -v sqlite3 >/dev/null 2>&1
}

# tmb_sqlite_ro <db> <sql>
# Read-only sqlite3 with a 500ms busy timeout.
# Returns the query output, or empty string on error.
# Never fails the caller.
tmb_sqlite_ro() {
  local db="$1"
  local sql="$2"
  sqlite3 -readonly -cmd '.timeout 500' "$db" "$sql" 2>/dev/null || true
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
  tmb_sqlite_ro "$db" "
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

# tmb_config_get <key> [<db>]
# Prints the scalar value stored in plugin_config for <key>, unquoted.
# Prints empty string when: key missing, DB absent, sqlite3 unavailable, DB busy.
# Optional <db> arg skips re-resolving the path (perf).
# Never fails the caller.
tmb_config_get() {
  local key="$1"
  local db="${2:-}"
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  tmb_sqlite_ro "$db" "
    SELECT json_extract(value_json, '$')
      FROM plugin_config
     WHERE key = '${key}';
  "
}

# tmb_config_raw <key> [<db>]
# Prints the raw value_json column for <key> without JSON extraction.
# Prints empty string when: key missing, DB absent, sqlite3 unavailable, DB busy.
# Optional <db> arg skips re-resolving the path (perf).
# Never fails the caller.
tmb_config_raw() {
  local key="$1"
  local db="${2:-}"
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  tmb_sqlite_ro "$db" "
    SELECT value_json
      FROM plugin_config
     WHERE key = '${key}';
  "
}

# tmb_config_array <key> [<db>]
# Prints one element per line from a JSON-array-valued plugin_config key.
# Prints nothing when: key missing, DB absent, sqlite3 unavailable, DB busy.
# Optional <db> arg skips re-resolving the path (perf).
# Never fails the caller.
tmb_config_array() {
  local key="$1"
  local db="${2:-}"
  local raw
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  raw=$(tmb_sqlite_ro "$db" "
    SELECT value_json
      FROM plugin_config
     WHERE key = '${key}';
  ")
  [ -z "$raw" ] && return 0
  echo "$raw" | jq -r '.[]' 2>/dev/null || true
}

# tmb_swe_context [<agent_type>]
# Returns "yes" when the calling context is a SWE subagent; "no" otherwise.
# Three deterministic signals, priority order:
#   1. <agent_type> == 'swe' → yes (most reliable when CC populates the field).
#   2. <agent_type> is a known non-SWE role → no (explicit identity wins; no PWD fallback).
#      Known non-SWE roles: bro, pr-reviewer, architect, cto, ceo, pm, consultant.
#   3. <agent_type> absent/empty + $PWD inside .claude/worktrees/* → yes.
#      Structural fallback for cases where CC quirk #97 strips the agent_type field.
# Callers must normalize <agent_type> via tmb_normalize_role before passing.
# Never fails the caller.
tmb_swe_context() {
  local agent_type="${1:-}"
  if [ "$agent_type" = "swe" ]; then
    echo "yes"
    return 0
  fi
  case "$agent_type" in
    bro|pr-reviewer|architect|cto|ceo|pm|consultant)
      echo "no"
      return 0
      ;;
  esac
  case "$PWD" in
    */.claude/worktrees/*)
      echo "yes"
      return 0
      ;;
  esac
  echo "no"
}

# tmb_task_spec_status <task_id> [<db>]
# Prints two lines: <status>\n<body_len> for the given tasks row.
# Prints nothing when the row does not exist, DB is absent, sqlite3 is unavailable,
# or the DB is busy (caller gets empty — treat same as "row missing").
# Optional <db> arg skips re-resolving the path (perf).
# Callers must check tmb_db_path / tmb_have_sqlite before calling if they need
# to distinguish "DB missing" from "row missing".
tmb_task_spec_status() {
  local task_id="$1"
  local db="${2:-}"
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  tmb_sqlite_ro "$db" "
    SELECT status, LENGTH(COALESCE(spec_body, ''))
      FROM tasks
     WHERE id = ${task_id};
  " | tr '|' '\n'
}
