#!/usr/bin/env bash
# TMB deterministic health-check.
#
# Standalone bash — deliberately NOT an MCP tool. It must be able to diagnose
# states in which the MCP server itself is DOWN (chicken-and-egg), so it reads
# only the trajectory DB (via sqlite3), the server log, and the plugin cache
# filesystem. No LLM, no MCP round-trip, no guessing. Every DB read goes
# through _tmb_db_read_ro: the DB is never opened writable.
#
# Runs 8 checks; each prints exactly one `PASS`/`FAIL` line (or `WARN` for
# embeddings, `UNVERIFIED` for an unlistable process table), and every FAIL
# prints the ONE correct remediation directly under it.
#
#   1. server-reachable   — is the trajectory-server process alive?
#   2. cache-version      — DB-recorded plugin_version == installed (intended) version?
#   3. schema-version     — DB schema_version == the installed server's TARGET?
#   4. world-model        — wm_ tables present in the trajectory DB? (read-only)
#   5. label-config       — issue_classification_labels configured, not the bare default?
#   6. stale-state        — orphaned worktrees / pending|running tasks?
#   7. hook-cache-drift   — running hooks load from the cache, not the dev checkout?
#   8. embeddings         — no unrecovered embeddings_degraded row in the last
#      24 h (the doctor's embeddings_not_degraded contract)? A WARN, not a
#      FAIL: the exit code stays 0, but the footer no longer says all passed.
#
# Plus warnings and info lines, printed only when they apply and never counted
# as a FAIL:
#   world-model (WARN) — the world-model tables are empty; run /scan.
#   world-model (INFO) — a leftover graph file from the old store sits beside
#   the DB; the user may delete it (health.sh never deletes or writes).
#   duplicate-plugin — more than one enabled copy of this plugin applies to the
#   project; Claude Code registers the hooks of only one of them.
#   legacy-user-hooks — the user-scope settings.json still runs pre-1.1.0
#   TMB hooks in every project (read only; never edited).
#
# LOAD-BEARING REMEDIATION RULE
# ----------------------------
# NEVER recommend `/reload-plugins` for an MCP-SERVER-STATE failure
# (world-model-unavailable, schema mismatch, stale server graph/config, a dead
# server). Those need a FULL Claude Code session restart (quit + relaunch),
# because `/reload-plugins` re-reads hooks/skills/agents/commands but does NOT
# respawn the long-lived MCP server. `/reload-plugins` is correct ONLY for
# hook/skill/agent/command DEFINITION drift (check 7).
#
# Env overrides (primarily for tests; production auto-resolves all of these):
#   TRAJECTORY_DB_PATH         — pin the trajectory DB.
#   TMB_HEALTH_INSTALLED_JSON  — path to CC's installed_plugins.json.
#   TMB_HEALTH_CACHE_DIR       — the installed plugin cache dir (installPath).
#                                Without CLAUDE_PROJECT_DIR it defaults to the
#                                plugin root running this script.
#   TMB_HEALTH_SERVER_LOG      — path to mcp-server.log.
#   TMB_HEALTH_PGREP_COUNT     — stub the server-reachable probe (>=0 process count).
#   TMB_HEALTH_INTENDED_VERSION— stub the intended plugin version.
#   CLAUDE_PLUGIN_ROOT         — the dev checkout (drives hook/cache-drift check).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/hooks/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-workspace.sh
. "$SCRIPT_DIR/hooks/lib/resolve-workspace.sh"
# shellcheck source=scripts/hooks/lib/resolve-install.sh
. "$SCRIPT_DIR/hooks/lib/resolve-install.sh"

SELF_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

PLUGIN_NAME="tmb"
if [ -f "${SELF_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_NAME=$(jq -r '.name // "tmb"' "${SELF_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
fi

FAILED=0
DEGRADED=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %s\n' "$1"
}
# remediate <line...> — print one indented remediation line per argument.
remediate() {
  local line
  for line in "$@"; do
    printf '      -> %s\n' "$line"
  done
}
# db_read <sql> — read the trajectory DB without ever opening it writable
# (_tmb_db_read_ro, 500ms busy timeout); prints nothing on error.
db_read() {
  local out
  out=$(TMB_DB_WRITE_TIMEOUT_MS=500 _tmb_db_read_ro "$DB" "$1")
  [ -n "$out" ] && [ "$out" != "__ERR__" ] && printf '%s\n' "$out"
  return 0
}

DB=""
if [ "${TRAJECTORY_DB_PATH:-}" = ":memory:" ]; then
  DB=":memory:"
else
  DB=$(tmb_db_path 2>/dev/null || true)
fi

# ---------------------------------------------------------------------------
# Resolve the installed (intended) version + cache dir from CC's
# installed_plugins.json. This is what the Human asked CC to run; the DB's
# plugin_meta.plugin_version is what the server actually BOOTED with. Drift
# between the two is exactly the post-upgrade failure mode we diagnose.
# ---------------------------------------------------------------------------
INSTALLED_JSON="${TMB_HEALTH_INSTALLED_JSON:-$HOME/.claude/plugins/installed_plugins.json}"
INTENDED_VERSION="${TMB_HEALTH_INTENDED_VERSION:-}"
CACHE_DIR="${TMB_HEALTH_CACHE_DIR:-}"
INSTALL_KEY=""
INSTALL_SCOPE=""
if [ -f "$INSTALLED_JSON" ] && command -v jq >/dev/null 2>&1; then
  # Prefer the entry installed at the plugin root running this script;
  # otherwise take the first tmb entry. Without a project env, a first entry
  # that is not this root (e.g. the stable cache while a dev copy runs) names
  # the update command only — its version and cache describe another install.
  _entry=$(jq -r --arg root "$SELF_ROOT" '
    .plugins
    | to_entries
    | map(select(.key | test("^'"$PLUGIN_NAME"'@")))
    | map(.value[0] + {key: .key})
    | (map(select(.installPath == $root)) + .)
    | .[0] // empty
    | "\(.version)\t\(.installPath)\t\(.key)\t\(.scope // "")"
  ' "$INSTALLED_JSON" 2>/dev/null || true)
  if [ -n "$_entry" ]; then
    _entry_path=$(printf '%s' "$_entry" | cut -f2)
    if [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ "$_entry_path" = "$SELF_ROOT" ]; then
      [ -z "$INTENDED_VERSION" ] && INTENDED_VERSION=$(printf '%s' "$_entry" | cut -f1)
      [ -z "$CACHE_DIR" ] && CACHE_DIR="$_entry_path"
    fi
    INSTALL_KEY=$(printf '%s' "$_entry" | cut -f3)
    INSTALL_SCOPE=$(printf '%s' "$_entry" | cut -f4)
  fi
fi
if [ -z "$CACHE_DIR" ] && [ -z "${CLAUDE_PROJECT_DIR:-}" ]; then
  CACHE_DIR="$SELF_ROOT"
fi

# CC updates a plugin only at the scope it is installed at: use the entry's own
# project/local scope, else the channel default (stable → project, rc/dev → local).
SCOPE_DOC="docs/reference/INSTALL.md#recommended-scope-project-or-local"
if [ -n "$INSTALL_KEY" ]; then
  case "$INSTALL_SCOPE" in
    project|local) ;;
    *) case "$INSTALL_KEY" in
         *@trustmybot) INSTALL_SCOPE="project" ;;
         *) INSTALL_SCOPE="local" ;;
       esac ;;
  esac
  UPDATE_CMD="claude plugin update $INSTALL_KEY --scope $INSTALL_SCOPE"
else
  UPDATE_CMD="claude plugin update ${PLUGIN_NAME}@<marketplace> --scope project (stable) or --scope local (rc/dev)"
fi

# Server log: prefer override, else the logs dir beside the trajectory DB
# (mirrors platform.ts resolveLogDir).
SERVER_LOG="${TMB_HEALTH_SERVER_LOG:-}"
if [ -z "$SERVER_LOG" ]; then
  if [ "$DB" = ":memory:" ]; then
    _tmp="${TMPDIR:-/tmp}"
    SERVER_LOG="${_tmp%/}/${PLUGIN_NAME}-memory-logs/mcp-server.log"
  elif [ -n "$DB" ]; then
    SERVER_LOG="$(dirname "$DB")/logs/mcp-server.log"
  fi
fi

printf '== TMB health-check ==\n'
printf 'db:        %s\n' "${DB:-<unresolved>}"
printf 'cache:     %s\n' "${CACHE_DIR:-<unresolved>}"
printf 'server-log:%s\n' "${SERVER_LOG:-<unresolved>}"
printf '\n'

# ===========================================================================
# 1. server-reachable
# ===========================================================================
PGREP_COUNT="${TMB_HEALTH_PGREP_COUNT:-}"
PGREP_RC=0
if [ -z "$PGREP_COUNT" ]; then
  if command -v pgrep >/dev/null 2>&1; then
    _pat="trajectory-server/dist/index.js"
    [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && _pat="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js"
    _pids=$(pgrep -f "$_pat" 2>/dev/null) || PGREP_RC=$?
    PGREP_COUNT=$(printf '%s' "$_pids" | grep -c . || true)
  else
    PGREP_COUNT="-1"
  fi
fi
if [ "$PGREP_RC" -ge 2 ]; then
  printf 'UNVERIFIED  server-reachable: pgrep exited %s — the process table cannot be listed here (e.g. the Claude Code sandbox)\n' "$PGREP_RC"
  remediate "Re-run outside the sandbox to probe the server, or check that trajectory-server MCP tools respond."
elif [ "$PGREP_COUNT" = "-1" ]; then
  pass "server-reachable: pgrep unavailable — cannot probe (assuming reachable)"
elif [ "$PGREP_COUNT" -gt 0 ] 2>/dev/null; then
  pass "server-reachable: trajectory-server process alive ($PGREP_COUNT)"
else
  fail "server-reachable: NO trajectory-server process found"
  remediate \
    "Fully quit Claude Code (Cmd-Q) and relaunch — a dead MCP server needs a full restart, NOT /reload-plugins." \
    "If it does not come back after relaunch, see skills/tmb_recovery (CC plugin MCP-config cache bug)." \
    "Forensics: tail -n 50 ${SERVER_LOG:-<project>/.claude/${PLUGIN_NAME}/logs/mcp-server.log}"
fi

# ===========================================================================
# 2. cache-version — DB plugin_version vs installed (intended) version
# ===========================================================================
DB_PLUGIN_VERSION=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  DB_PLUGIN_VERSION=$(db_read "SELECT plugin_version FROM plugin_meta WHERE id = 1;")
fi
if [ -z "$INTENDED_VERSION" ]; then
  pass "cache-version: intended version unknown — skipping (no installed_plugins.json)"
elif [ -z "$DB_PLUGIN_VERSION" ]; then
  fail "cache-version: DB plugin_version unreadable (intended=$INTENDED_VERSION)"
  remediate \
    "Cannot read plugin_meta — is the DB present/queryable? db=${DB:-<unresolved>}"
elif [ "$DB_PLUGIN_VERSION" = "$INTENDED_VERSION" ]; then
  pass "cache-version: DB matches installed version ($INTENDED_VERSION)"
else
  fail "cache-version: server booted $DB_PLUGIN_VERSION but $INTENDED_VERSION is installed"
  remediate \
    "From the project root, run $UPDATE_CMD; then fully quit + relaunch Claude Code so the server reboots on the new cache." \
    "Scope rule: $SCOPE_DOC" \
    "/reload-plugins will NOT pick up the new server — the MCP process is long-lived."
fi

# ===========================================================================
# 3. schema-version — DB schema_version vs the installed server's TARGET
# ===========================================================================
DB_SCHEMA_VERSION=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  DB_SCHEMA_VERSION=$(db_read "SELECT schema_version FROM plugin_meta WHERE id = 1;")
fi
# The server's TARGET schema lives in its source as `const TARGET_SCHEMA_VERSION = N`.
# Read it from the INSTALLED cache (src or dist), so we compare the DB against
# the version the server WILL migrate to on its next boot.
TARGET_SCHEMA=""
if [ -n "$CACHE_DIR" ]; then
  for _f in \
    "$CACHE_DIR/mcp/trajectory-server/src/db.ts" \
    "$CACHE_DIR/mcp/trajectory-server/dist/db.js"; do
    if [ -f "$_f" ]; then
      TARGET_SCHEMA=$(grep -oE 'TARGET_SCHEMA_VERSION[[:space:]]*=[[:space:]]*[0-9]+' "$_f" 2>/dev/null \
        | grep -oE '[0-9]+' | head -1)
      [ -n "$TARGET_SCHEMA" ] && break
    fi
  done
fi
if [ -z "$TARGET_SCHEMA" ]; then
  pass "schema-version: target schema unknown — skipping (no cache db source)"
elif [ -z "$DB_SCHEMA_VERSION" ]; then
  fail "schema-version: DB schema_version unreadable (target=$TARGET_SCHEMA)"
  remediate \
    "Cannot read plugin_meta.schema_version — is the DB present/queryable? db=${DB:-<unresolved>}"
elif [ "$DB_SCHEMA_VERSION" = "$TARGET_SCHEMA" ]; then
  pass "schema-version: DB at current schema (v$DB_SCHEMA_VERSION)"
else
  fail "schema-version: DB at v$DB_SCHEMA_VERSION but installed server targets v$TARGET_SCHEMA"
  remediate \
    "Fully quit + relaunch Claude Code — the migration runs on the next SERVER start." \
    "/reload-plugins does NOT restart the server, so it will NOT run the migration."
fi

# ===========================================================================
# 4. world-model — wm_ tables in the trajectory DB (read-only probe)
# ===========================================================================
# The world model is the wm_directories / wm_files tables inside the trajectory
# DB, filled by /scan.
WM_TABLES="'wm_directories','wm_files'"
WM_TABLE_COUNT=""
WM_COUNTS=""
if [ -n "$DB" ] && [ "$DB" != ":memory:" ] && tmb_have_sqlite; then
  WM_TABLE_COUNT=$(_tmb_db_read_ro "$DB" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ($WM_TABLES);")
  if [ "$WM_TABLE_COUNT" = "2" ]; then
    WM_COUNTS=$(_tmb_db_read_ro "$DB" \
      "SELECT (SELECT COUNT(*) FROM wm_directories) || ' ' || (SELECT COUNT(*) FROM wm_files);")
  fi
fi
WM_DIRS="${WM_COUNTS%% *}"
WM_FILES="${WM_COUNTS##* }"

if [ -z "$DB" ]; then
  pass "world-model: trajectory DB unresolved — skipping"
elif [ "$DB" = ":memory:" ]; then
  pass "world-model: in-memory trajectory DB — nothing on disk to probe"
elif ! tmb_have_sqlite; then
  pass "world-model: sqlite3 unavailable — skipping"
elif [ "$WM_TABLE_COUNT" = "__ERR__" ] || [ "$WM_COUNTS" = "__ERR__" ] || [ -z "$WM_TABLE_COUNT" ]; then
  fail "world-model: cannot read the world-model tables"
  remediate \
    "Is the DB present/queryable? db=$DB"
elif [ "$WM_TABLE_COUNT" != "2" ]; then
  fail "world-model: wm_directories / wm_files missing from the trajectory DB"
  remediate \
    "Fully quit + relaunch Claude Code — the server creates the tables when it migrates the DB on start." \
    "Then build the world model: run /scan."
elif [ "$WM_DIRS" = "0" ]; then
  pass "world-model: tables present"
  printf 'WARN  world-model: empty — no directories scanned yet\n'
  remediate "Build the world model: run /scan."
else
  pass "world-model: $WM_DIRS directories, $WM_FILES files"
fi

# The world model used to live in a separate graph file beside the DB
# (<dir>/world-model.kuzu, or <db>.world-model.kuzu for a custom DB name).
# Nothing reads it any more; report it, never delete it.
LEGACY_GRAPH=""
if [ -n "$DB" ] && [ "$DB" != ":memory:" ]; then
  if [ "${DB##*/}" = "trajectory.db" ]; then
    LEGACY_GRAPH="${DB%trajectory.db}world-model.kuzu"
  else
    LEGACY_GRAPH="${DB}.world-model.kuzu"
  fi
fi
if [ -n "$LEGACY_GRAPH" ] && [ -e "$LEGACY_GRAPH" ]; then
  printf 'INFO  world-model: %s is an unused leftover from the old graph store — TMB no longer reads it; you may delete it (and any %s.* files beside it).\n' \
    "$LEGACY_GRAPH" "${LEGACY_GRAPH##*/}"
fi

# ===========================================================================
# 5. label-config — issue_classification_labels sane (not bare default)
# ===========================================================================
LABELS_RAW=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  LABELS_RAW=$(db_read "SELECT value_json FROM plugin_config WHERE key = 'issue_classification_labels';")
fi
LABEL_COUNT=0
if [ -n "$LABELS_RAW" ] && command -v jq >/dev/null 2>&1; then
  LABEL_COUNT=$(printf '%s' "$LABELS_RAW" | jq 'if type=="array" then length else 0 end' 2>/dev/null || echo 0)
fi
if [ -z "$LABELS_RAW" ] || [ "$LABEL_COUNT" = "0" ]; then
  fail "label-config: issue_classification_labels is unset/empty"
  remediate \
    "Set it via /onboard, or with the config_set MCP tool (key=issue_classification_labels)." \
    "Until set, issue auto-classification falls back to the generic default."
else
  pass "label-config: issue_classification_labels set ($LABEL_COUNT labels)"
fi

# ===========================================================================
# 6. stale-state — orphaned worktrees / pending|running tasks
# ===========================================================================
WS_ROOT=$(tmb_workspace_root "$DB")
STALE_WORKTREES=""
if [ -n "$WS_ROOT" ] && [ -d "$WS_ROOT/.claude/worktrees" ]; then
  for _wt in "$WS_ROOT"/.claude/worktrees/*/; do
    [ -d "$_wt" ] || continue
    STALE_WORKTREES="${STALE_WORKTREES}${_wt}\n"
  done
fi
PENDING_TASKS=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  PENDING_TASKS=$(db_read "
    SELECT id || ' [' || status || '] ' || COALESCE(branch_id,'')
      FROM tasks
     WHERE status IN ('pending','running');
  ")
fi
if [ -z "$STALE_WORKTREES" ] && [ -z "$PENDING_TASKS" ]; then
  pass "stale-state: no orphaned worktrees or pending/running tasks"
else
  fail "stale-state: orphaned worktrees and/or pending|running tasks present"
  if [ -n "$PENDING_TASKS" ]; then
    remediate "Pending/running tasks (recover or close):"
    while IFS= read -r _t; do
      [ -n "$_t" ] && remediate "    task $_t"
    done <<EOF
$PENDING_TASKS
EOF
  fi
  if [ -n "$STALE_WORKTREES" ]; then
    remediate "Worktrees under $WS_ROOT/.claude/worktrees/ (clean up once the task is done):"
    printf '%b' "$STALE_WORKTREES" | while IFS= read -r _w; do
      [ -n "$_w" ] && remediate "    $_w"
    done
    remediate "Cleanup helper: scripts/maintenance/cleanup-stale-worktrees.sh"
  fi
fi

# ===========================================================================
# 7. hook-cache-drift — running hooks load from the cache, not the dev checkout
# ===========================================================================
# CC executes hooks/skills/agents/commands from the marketplace CACHE, not from
# a dev checkout. If the dev checkout (CLAUDE_PLUGIN_ROOT, when it is a working
# tree under git) is at a different version than the installed cache, the hook
# definitions you are editing are NOT the ones running this session.
DRIFT_SOURCE_VERSION=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  DRIFT_SOURCE_VERSION=$(jq -r '.version // ""' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || true)
fi
if [ -z "$DRIFT_SOURCE_VERSION" ] || [ -z "$INTENDED_VERSION" ]; then
  pass "hook-cache-drift: no dev checkout vs cache comparison available"
elif [ "${CLAUDE_PLUGIN_ROOT:-}" = "$CACHE_DIR" ]; then
  pass "hook-cache-drift: running directly from the cache (no drift)"
elif [ "$DRIFT_SOURCE_VERSION" = "$INTENDED_VERSION" ]; then
  pass "hook-cache-drift: dev checkout version matches the installed cache ($INTENDED_VERSION)"
else
  fail "hook-cache-drift: dev checkout is $DRIFT_SOURCE_VERSION but the cache runs $INTENDED_VERSION"
  remediate \
    "Your edits to hooks/skills/agents/commands are NOT live until the cache updates." \
    "Once the cache is at your version (from the project root: $UPDATE_CMD), run /reload-plugins to load the new hook/skill/agent/command definitions." \
    "(/reload-plugins is the RIGHT tool here — these are definition files, not the MCP server.)"
fi

# ===========================================================================
# 8. embeddings — the doctor's embeddings_not_degraded contract
#    (mcp/trajectory-server/src/data-contracts.ts): an embeddings_degraded row
#    from the last 24 h with no later embeddings_recovered row.
# ===========================================================================
EMB_DEGRADED=""
if [ -n "$DB" ] && [ "$DB" != ":memory:" ] && tmb_have_sqlite; then
  EMB_DEGRADED=$(TMB_DB_WRITE_TIMEOUT_MS=500 _tmb_db_read_ro "$DB" "
    SELECT d.created_at || ' ' || COALESCE(json_extract(d.content_json, '\$.reason'), '')
      FROM audit d
     WHERE d.event_type = 'embeddings_degraded'
       AND strftime('%Y-%m-%dT%H:%M:%fZ', d.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days')
       AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
     ORDER BY d.id DESC LIMIT 1;")
fi
if [ -z "$DB" ] || [ "$DB" = ":memory:" ] || ! tmb_have_sqlite; then
  pass "embeddings: no on-disk trajectory DB to read — skipping"
elif [ "$EMB_DEGRADED" = "__ERR__" ]; then
  pass "embeddings: audit table unreadable — skipping"
elif [ -n "$EMB_DEGRADED" ]; then
  DEGRADED=$((DEGRADED + 1))
  printf 'WARN  embeddings: degraded since %s — semantic search is falling back to FTS\n' "$EMB_DEGRADED"
  remediate \
    "The embedding model failed to load or kept failing; the server re-attempts on its own (1 min, 5 min, then every 10 min)." \
    "Check the embeddings_state lines in ${SERVER_LOG:-mcp-server.log}; trajectory_doctor reports the live state."
else
  pass "embeddings: no unrecovered embeddings_degraded event in the last 24 h"
fi

# ===========================================================================
# duplicate-plugin (warning) — more than one enabled copy for this project
# ===========================================================================
DUP_PROJECT=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ "$DB" != ":memory:" ]; then
  DUP_PROJECT=$(tmb_project_root)
fi
DUP_INSTALLS=""
if [ -z "$DUP_PROJECT" ]; then
  printf 'WARN  duplicate-plugin: skipped — no project resolves (no CLAUDE_PROJECT_DIR and no trajectory DB)\n'
  remediate "Run from a Claude Code session in the project, or set CLAUDE_PROJECT_DIR (or TRAJECTORY_DB_PATH) to it."
else
  DUP_INSTALLS=$(TMB_INSTALLED_JSON="$INSTALLED_JSON" tmb_duplicate_installs "$DUP_PROJECT" 2>/dev/null || true)
fi
if [ -n "$DUP_INSTALLS" ]; then
  printf 'WARN  duplicate-plugin: %s enabled %s copies for %s: %s\n' \
    "$(printf '%s\n' "$DUP_INSTALLS" | grep -c .)" "$PLUGIN_NAME" "$DUP_PROJECT" "$(tmb_duplicate_installs_names "$DUP_INSTALLS")"
  remediate \
    "Claude Code registers the hooks of only one of them (which one is not documented) and skips the other's with a note under /plugin Errors — TMB's gates may be missing while its MCP tools still work." \
    "Run /plugin and disable the extra copy, then restart Claude Code."
fi

# ===========================================================================
# legacy-user-hooks (warning) — pre-1.1.0 hooks left in the user settings.json
# ===========================================================================
LEGACY_HOOKS=$(TMB_INSTALLED_JSON="$INSTALLED_JSON" tmb_legacy_user_hooks "$DUP_PROJECT" 2>/dev/null || true)
if [ -n "$LEGACY_HOOKS" ]; then
  printf 'WARN  legacy-user-hooks: %s holds %s pre-1.1.0 TMB hook(s): %s\n' \
    "$(tmb_user_settings_json)" "$(printf '%s\n' "$LEGACY_HOOKS" | grep -c '^hook')" "$(tmb_legacy_user_hooks_entries "$LEGACY_HOOKS")"
  remediate \
    "They run in every project, so a pre-1.1.0 gate can deny what this version allows. TMB does not edit that file." \
    "Remove them by hand: $(tmb_legacy_user_hooks_doc)"
  LEGACY_PROJECTS=$(tmb_legacy_user_hooks_projects "$LEGACY_HOOKS")
  [ -z "$LEGACY_PROJECTS" ] || remediate "Projects on TMB < 1.1.0 lose them too: ${LEGACY_PROJECTS}"
fi

printf '\n'
if [ "$FAILED" -eq 0 ] && [ "$DEGRADED" -gt 0 ]; then
  printf '== no check FAILED, %d degraded (see WARN above) ==\n' "$DEGRADED"
  exit 0
elif [ "$FAILED" -eq 0 ]; then
  printf '== all checks passed ==\n'
  exit 0
else
  printf '== %d check(s) FAILED ==\n' "$FAILED"
  exit 1
fi
