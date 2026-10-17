#!/usr/bin/env bash
# Library: SQLite query helpers for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.

# Trajectory DB location — the hook half of the one resolution rule. The server
# half is findExistingClaudeDbUp in mcp/trajectory-server/src/platform.ts; the
# rule is documented once in docs/reference/TRAJECTORY_DB_LOCATION.md. This file
# is the only place under scripts/ allowed to spell the DB filename
# (tests/l1-lint/no-private-db-path.sh).
TMB_STATE_HOST_DIR=".claude"
TMB_DB_FILENAME="trajectory.db"

# _TMB_DB_PATH_CACHE: process-level memoization of the resolved DB path.
# Set on first successful resolution; read on subsequent calls.
_TMB_DB_PATH_CACHE=""

tmb_have_sqlite() {
  command -v sqlite3 >/dev/null 2>&1
}

# tmb_plugin_name
# The plugin name from CLAUDE_PLUGIN_ROOT's manifest, else "tmb".
tmb_plugin_name() {
  local manifest="${CLAUDE_PLUGIN_ROOT:-}/.claude-plugin/plugin.json"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$manifest" ]; then
    jq -r '.name // "tmb"' "$manifest" 2>/dev/null || echo "tmb"
  else
    echo "tmb"
  fi
}

# tmb_db_location <root>
# Prints where <root>'s trajectory DB lives (whether or not it exists).
tmb_db_location() {
  printf '%s/%s/%s/%s\n' "${1:-}" "$TMB_STATE_HOST_DIR" "$(tmb_plugin_name)" "$TMB_DB_FILENAME"
}

# _tmb_db_wal_cold <db>
# 0 when <db> is a WAL database (header bytes 18-19 = 2) with no -shm file
# beside it: the state of a healthy DB nobody holds open (MCP server down or
# restarting). sqlite3 -readonly cannot open it ("unable to open database
# file", SQLITE_CANTOPEN = exit 14). Costs nothing while -shm exists.
_tmb_db_wal_cold() {
  [ ! -e "${1:-}-shm" ] || return 1
  [ "$(od -An -tu1 -j18 -N2 "${1:-}" 2>/dev/null | tr -d ' \n')" = "22" ]
}

# _tmb_sqlite_once <readonly:1|0> <timeout_ms> <db> <sql>
# One sqlite3 read; prints its stdout, returns its exit code.
_tmb_sqlite_once() {
  if [ "$1" = 1 ]; then
    sqlite3 -readonly -cmd ".timeout ${2}" "$3" "$4" 2>/dev/null
  else
    sqlite3 -cmd ".timeout ${2}" "$3" "$4" 2>/dev/null
  fi
}

# tmb_gate_read <db> <sql>
# Read helper for deny-capable gates. Prints the query output, or the literal
# __ERR__ when sqlite3 fails (missing/corrupt/locked DB) so the caller can tell
# "no rows" from "DB unavailable" and fail closed. Always returns 0.
# Reads run with -readonly (the fast path while the MCP server holds the DB
# open), except on a WAL DB with no -shm (_tmb_db_wal_cold), which -readonly
# cannot open: that read, and a -readonly read failing with SQLITE_CANTOPEN
# (14), run without -readonly. Such a read may create -shm/-wal beside the DB,
# inside the project; the SQL is read-only (tests/l1-lint/gate-read-sql-readonly.sh),
# so no page is written. Busy, SQL and corruption errors are never retried.
# immutable=1 is not used: it reads stale pages while a writer is active.
tmb_gate_read() {
  local db="${1:-}" sql="${2:-}" out rc=0 ro=1 ms="${TMB_DB_WRITE_TIMEOUT_MS:-1500}"
  case "$ms" in ''|*[!0-9]*) ms=1500 ;; esac
  if [ -z "$db" ] || [ ! -f "$db" ]; then
    printf '__ERR__\n'
    return 0
  fi
  _tmb_db_wal_cold "$db" && ro=0
  out=$(_tmb_sqlite_once "$ro" "$ms" "$db" "$sql") || rc=$?
  if [ "$rc" -eq 14 ] && [ "$ro" = 1 ]; then
    rc=0
    out=$(_tmb_sqlite_once 0 "$ms" "$db" "$sql") || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    [ -n "$out" ] && printf '%s\n' "$out"
  else
    printf '__ERR__\n'
  fi
  return 0
}

# tmb_db_read_budget <db> <budget_ms>
# Read helper with a hard wall-clock budget: runs the SQL script on stdin
# through sqlite3 (busy timeout = the budget) and kills it once the budget is
# spent. -readonly unless the DB is WAL with no -shm (as tmb_gate_read); a
# -readonly run that fails while the DB is in that state runs once more
# without it. Prints whatever the script printed. Returns 0 when sqlite3
# succeeded, 124 on timeout, else non-zero (missing DB, read or SQL error —
# output already printed is kept, so a caller can tell which statements ran).
tmb_db_read_budget() {
  local db="${1:-}" ms="${2:-}" script out rc=0
  if [ -z "$db" ] || [ ! -f "$db" ]; then
    cat >/dev/null
    return 1
  fi
  case "$ms" in ''|*[!0-9]*) ms=1500 ;; esac
  [ "$ms" -gt 0 ] || ms=1
  script="$(printf '.timeout %s\n' "$ms"; cat)"
  if _tmb_db_wal_cold "$db"; then
    out=$(printf '%s\n' "$script" | _tmb_budget_run 0 "$ms" "$db") || rc=$?
  else
    out=$(printf '%s\n' "$script" | _tmb_budget_run 1 "$ms" "$db") || rc=$?
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && _tmb_db_wal_cold "$db"; then
      rc=0
      out=$(printf '%s\n' "$script" | _tmb_budget_run 0 "$ms" "$db") || rc=$?
    fi
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return "$rc"
}

# _tmb_budget_run <readonly:1|0> <budget_ms> <db>
# Runs the SQL script on stdin through sqlite3 and kills it once the budget
# is spent (exit 124).
_tmb_budget_run() {
  local kill_after_pl='
    my $ms = shift @ARGV;
    my $pid = fork();
    exit 1 unless defined $pid;
    if ($pid == 0) { exec @ARGV; exit 1; }
    local $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); exit 124 };
    alarm($ms / 1000);
    waitpid($pid, 0);
    alarm 0;
    exit(($? >> 8) & 0xff);'
  if [ "$1" = 1 ]; then
    set -- "$2" sqlite3 -readonly "$3"
  else
    set -- "$2" sqlite3 "$3"
  fi
  perl -MTime::HiRes=alarm -e "$kill_after_pl" "$@" 2>/dev/null
}

# _tmb_db_probe <db>
# 0 = current schema (tasks.prompt_bearing exists), 1 = stale legacy schema,
# 2 = the read itself failed (busy, corrupt, unreadable). With no sqlite3 the
# DB cannot be probed and counts as current.
_tmb_db_probe() {
  local db="${1:-}" cols
  [ -n "$db" ] && [ -f "$db" ] || return 1
  tmb_have_sqlite || return 0
  cols=$(tmb_gate_read "$db" "SELECT name FROM pragma_table_info('tasks');")
  case "$cols" in
    __ERR__) return 2 ;;
    *prompt_bearing*) return 0 ;;
  esac
  return 1
}

# tmb_db_schema_current <db>
# Returns 0 when <db> carries the current TMB schema, non-zero otherwise.
tmb_db_schema_current() {
  _tmb_db_probe "${1:-}"
}

# tmb_test_flag
# Prints the active test flag (TMB_FORBID_LIVE_SYNC=1, else TMB_TEST_RUN_ID)
# and returns 0; returns 1 when neither is set. Under a test flag nothing
# discovers a live resource: no DB walk-up, no live `claude` CLI.
tmb_test_flag() {
  if [ "${TMB_FORBID_LIVE_SYNC:-}" = "1" ]; then
    echo TMB_FORBID_LIVE_SYNC
  elif [ -n "${TMB_TEST_RUN_ID:-}" ]; then
    echo TMB_TEST_RUN_ID
  else
    return 1
  fi
}

# _tmb_db_resolve
# Steps 1-3 of the rule (docs/reference/TRAJECTORY_DB_LOCATION.md):
#   1. TRAJECTORY_DB_PATH, if set (must exist; no further steps).
#   2. CLAUDE_PROJECT_DIR/<host>/<plugin>/trajectory.db, if CLAUDE_PROJECT_DIR
#      is set (must exist; no walking).
#   3. Only without CLAUDE_PROJECT_DIR: walk up from cwd, never entering $HOME
#      unless started there, no .git stop; every ancestor DB that is not a
#      stale schema is a candidate; the outermost wins. Under a test flag
#      (tmb_test_flag) step 3 never runs: unresolved, one stderr line.
# A candidate whose probe read fails is kept: it is resolved, and the read
# error surfaces through tmb_db_state instead of silently resolving elsewhere.
_tmb_db_resolve() {
  local candidate flag
  if [ -n "${TRAJECTORY_DB_PATH:-}" ]; then
    [ -f "$TRAJECTORY_DB_PATH" ] || return 1
    printf '%s\n' "$TRAJECTORY_DB_PATH"
    return 0
  fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    candidate=$(tmb_db_location "$CLAUDE_PROJECT_DIR")
    [ -f "$candidate" ] || return 1
    printf '%s\n' "$candidate"
    return 0
  fi
  if flag=$(tmb_test_flag); then
    printf 'tmb: trajectory DB unresolved: %s is set and neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is (walk-up discovery disabled)\n' "$flag" >&2
    return 1
  fi
  local start dir outermost=""
  start="$(pwd)"
  dir="$start"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ "$dir" = "$HOME" ] && [ "$start" != "$HOME" ]; then
      break
    fi
    candidate=$(tmb_db_location "$dir")
    if [ -f "$candidate" ]; then
      _tmb_db_probe "$candidate"
      [ $? -ne 1 ] && outermost="$candidate"
    fi
    dir="$(dirname "$dir")"
  done
  [ -n "$outermost" ] || return 1
  printf '%s\n' "$outermost"
}

# tmb_db_path
# Prints the resolved trajectory DB path; non-zero exit when unresolved.
# Memoized in _TMB_DB_PATH_CACHE for the lifetime of the process.
tmb_db_path() {
  if [ -n "$_TMB_DB_PATH_CACHE" ]; then
    echo "$_TMB_DB_PATH_CACHE"
    return 0
  fi
  local db
  db=$(_tmb_db_resolve) || return 1
  _TMB_DB_PATH_CACHE="$db"
  echo "$db"
}

# tmb_state_dir
# Prints this project's TMB state directory (<project>/.claude/<plugin>, the
# directory holding the trajectory DB); non-zero exit when unresolved. Every
# file a hook writes lives under it — never under $HOME.
tmb_state_dir() {
  local db
  db=$(tmb_db_path) || return 1
  dirname "$db"
}

# tmb_db_state
# Prints one word:
#   unresolved — no DB (project not onboarded) or no sqlite3: gates allow
#   ok         — the DB answers a read
#   error      — the DB resolved but the read failed: deny-capable gates deny
tmb_db_state() {
  local db
  db=$(tmb_db_path) || { echo unresolved; return 0; }
  tmb_have_sqlite || { echo unresolved; return 0; }
  if [ "$(tmb_gate_read "$db" 'SELECT count(*) FROM sqlite_master;')" = "__ERR__" ]; then
    echo error
  else
    echo ok
  fi
}

# tmb_db_unavailable_reason <hook>
# The deny reason every fail-closed gate uses when the DB read errors.
tmb_db_unavailable_reason() {
  local db
  db=$(tmb_db_path 2>/dev/null) || db="<unresolved>"
  printf 'BLOCKED: trajectory DB unavailable — %s could not read %s (read error: busy, corrupt, or unreadable), so it refuses to fail open. Check the trajectory DB and retry.' "${1:-hook}" "$db"
}

# tmb_deny_db_unavailable <hook>
# Prints the PreToolUse deny for a DB read error.
tmb_deny_db_unavailable() {
  jq -nc --arg r "$(tmb_db_unavailable_reason "${1:-hook}")" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
}

# tmb_db_path_advisory <hook>
# For advisory hooks: prints the DB path when it resolves and reads cleanly.
# Unresolved → silent non-zero. Read error → one stderr line, non-zero.
tmb_db_path_advisory() {
  local db
  db=$(tmb_db_path) || return 1
  if [ "$(tmb_db_state)" = "error" ]; then
    printf '%s: trajectory DB unavailable (%s) — skipped\n' "${1:-hook}" "$db" >&2
    return 1
  fi
  printf '%s\n' "$db"
}

# tmb_sqlite_ro <db> <sql>
# tmb_gate_read with a 500ms busy timeout, for reads that treat an error as
# "no rows": prints the query output, or nothing on error. Never fails the
# caller.
tmb_sqlite_ro() {
  local out
  out=$(TMB_DB_WRITE_TIMEOUT_MS=500 tmb_gate_read "${1:-}" "${2:-}")
  [ -n "$out" ] && [ "$out" != "__ERR__" ] && printf '%s\n' "$out"
  return 0
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

# tmb_effort_defaults <db>
# Prints "<swe_default_effort>|<reviewer_effort>" from plugin_config; an unset
# key, or a value other than low|medium|high, reads as medium and high. Prints
# __ERR__ when the read fails (tmb_gate_read), so a gate can fail closed. The
# server's twin is resolveEffortDefaults in
# mcp/trajectory-server/src/tools/config.ts. Never fails the caller.
tmb_effort_defaults() {
  tmb_gate_read "${1:-}" "SELECT
    COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '\$') END AS v
                               FROM plugin_config WHERE key = 'swe_default_effort')
               WHERE v IN ('low','medium','high')), 'medium')
    || '|' ||
    COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '\$') END AS v
                               FROM plugin_config WHERE key = 'reviewer_effort')
               WHERE v IN ('low','medium','high')), 'high');"
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
# Returns "yes" when <agent_type> (normalized via tmb_normalize_role) is swe,
# "no" otherwise. The role comes from the agent identity alone; a path never
# decides it. Never fails the caller.
tmb_swe_context() {
  if [ "${1:-}" = "swe" ]; then echo "yes"; else echo "no"; fi
}

# tmb_sql_int <value>
# Echoes <value> only when it is a non-empty decimal integer (^[0-9]+$).
# Prints nothing (empty) for blank, negative, float, or injection strings.
# Use as the gatekeeper before interpolating a numeric id into SQL.
# Never fails the caller.
tmb_sql_int() {
  local val="${1:-}"
  case "$val" in
    ''|*[!0-9]*) return 0 ;;
  esac
  echo "$val"
}

# tmb_sql_quote <value>
# Echoes <value> with every single-quote doubled (' → '').
# The result is safe to interpolate inside a SQL single-quoted literal.
# Callers must still wrap the result in single quotes in the query:
#   "... WHERE col = '$(tmb_sql_quote "$VAR")'"
# Never fails the caller.
tmb_sql_quote() {
  printf '%s' "${1:-}" | sed "s/'/''/g"
}

# tmb_sql_like_escape <value>
# Echoes <value> with \, % and _ backslash-escaped and single quotes doubled,
# for a LIKE literal written with ESCAPE '\'. Never fails the caller.
tmb_sql_like_escape() {
  printf '%s' "${1:-}" | sed -e 's/[\\%_]/\\&/g' -e "s/'/''/g"
}

# tmb_task_by_slug <db> <slug> <column> [<status_list>]
# Prints <column> (id or branch_id) of the newest task whose branch_id ends in
# /<slug>. `_` and `%` in <slug> match literally. When several types share the
# slug, prints a warning to stderr naming the matches and picks the newest.
# <status_list> (e.g. 'pending','running') narrows by status. Exact
# branch_id matches belong to the caller, before this fallback. Prints nothing
# when no row matches. Never fails the caller.
tmb_task_by_slug() {
  local db="${1:-}" slug="${2:-}" col="${3:-id}" statuses="${4:-}" like where rows count
  [ -n "$db" ] && [ -n "$slug" ] || return 0
  case "$col" in id|branch_id) ;; *) return 0 ;; esac
  case "$statuses" in *[!a-z_\',\ ]*) return 0 ;; esac
  like=$(tmb_sql_like_escape "$slug")
  where="branch_id LIKE '%/${like}' ESCAPE '\\'"
  [ -n "$statuses" ] && where="${where} AND status IN (${statuses})"
  rows=$(tmb_sqlite_ro "$db" "SELECT id || '|' || branch_id FROM tasks WHERE ${where} ORDER BY id DESC;")
  [ -n "$rows" ] || return 0
  count=$(printf '%s\n' "$rows" | grep -c .)
  if [ "$count" -gt 1 ]; then
    printf 'tmb: worktree slug "%s" matches %s tasks (%s); using the newest\n' \
      "$slug" "$count" "$(printf '%s\n' "$rows" | cut -d'|' -f2 | paste -sd, -)" >&2
  fi
  rows=$(printf '%s\n' "$rows" | head -1)
  if [ "$col" = "id" ]; then printf '%s\n' "${rows%%|*}"; else printf '%s\n' "${rows#*|}"; fi
}

# tmb_worktree_root_for_target <target_path>
# Determine the worktree root for a prompt_bearing resolution.
# Priority:
#   1. The TARGET path if it is under .claude/worktrees/<slug>.
#   2. Fall back to $PWD when $PWD is under a worktree.
# Prints the worktree root (.../.claude/worktrees/<slug>) or empty string.
# Never fails the caller.
tmb_worktree_root_for_target() {
  local target="${1:-}"
  case "$target" in
    */.claude/worktrees/*)
      echo "$target" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|'
      return 0
      ;;
  esac
  case "$PWD" in
    */.claude/worktrees/*)
      echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|'
      return 0
      ;;
  esac
  return 0
}

# tmb_resolve_task_id_for_target <target_path> <input_json> [<db>]
# Robustly resolve the active task_id that gates a prompt_bearing edit/write.
# Resolution order (first non-empty wins):
#   1. Worktree's checked-out branch: derive WORKTREE_ROOT from the TARGET path
#      (or $PWD), then `git -C <wt> rev-parse --abbrev-ref HEAD` → exact
#      `branch_id = '<branch>'` (NO status filter).
#   2. Slug fallback: tmb_task_by_slug on the worktree root's basename (NO
#      status filter).
#   3. Transcript fallback: parse `task_id=[0-9]+` from the WHOLE transcript
#      message content (not only type:"text" blocks).
# All SQL is sanitized via tmb_sql_quote. Prints the resolved task_id (decimal)
# or empty string. Never fails the caller.
tmb_resolve_task_id_for_target() {
  local target="${1:-}"
  local input="${2:-}"
  local db="${3:-}"
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi

  local wt_root
  wt_root=$(tmb_worktree_root_for_target "$target")

  local task_id=""

  if [ -n "$db" ] && tmb_have_sqlite && [ -n "$wt_root" ]; then
    # (1) Exact branch match from the worktree's checked-out branch.
    local branch
    branch=$(git -C "$wt_root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
      local safe_branch
      safe_branch=$(tmb_sql_quote "$branch")
      task_id=$(tmb_sqlite_ro "$db" "
        SELECT id FROM tasks
         WHERE branch_id = '${safe_branch}'
         ORDER BY id DESC
         LIMIT 1;
      " 2>/dev/null || true)
      task_id=$(tmb_sql_int "$task_id")
    fi

    # (2) Slug fallback — no status filter.
    if [ -z "$task_id" ]; then
      task_id=$(tmb_sql_int "$(tmb_task_by_slug "$db" "$(basename "$wt_root")" id)")
    fi
  fi

  # (3) Transcript fallback — parse the whole message content.
  if [ -z "$task_id" ] && [ -n "$input" ]; then
    local transcript
    transcript=$(echo "$input" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
    task_id=$(tmb_task_id_from_transcript "$transcript")
  fi

  echo "$task_id"
}

# tmb_task_id_from_transcript <transcript_path>
# The spawn-prompt task binding: the first `task_id=<N>` in the transcript's
# message content. Content may be a plain string or an array of blocks
# (tostring covers both). Prints the decimal id, or empty when the file is
# missing or carries no task_id. Never fails the caller.
tmb_task_id_from_transcript() {
  local transcript="${1:-}" task_id=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    task_id=$(jq -r '.message.content // [] | tostring' "$transcript" 2>/dev/null \
      | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)
  fi
  tmb_sql_int "$task_id"
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
  local safe_id
  safe_id=$(tmb_sql_int "$task_id")
  [ -n "$safe_id" ] || return 0
  if [ -z "$db" ]; then
    db=$(tmb_db_path) || true
  fi
  [ -z "$db" ] && return 0
  tmb_have_sqlite || return 0
  tmb_sqlite_ro "$db" "
    SELECT status, LENGTH(COALESCE(spec_body, ''))
      FROM tasks
     WHERE id = ${safe_id};
  " | tr '|' '\n'
}
