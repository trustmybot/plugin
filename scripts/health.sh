#!/usr/bin/env bash
# TMB deterministic health-check.
#
# Standalone bash — deliberately NOT an MCP tool. It must be able to diagnose
# states in which the MCP server itself is DOWN (chicken-and-egg), so it reads
# only the trajectory DB (via sqlite3), the server log, and the plugin cache
# filesystem. No LLM, no MCP round-trip, no guessing.
#
# Runs 7 checks; each prints exactly one `PASS`/`FAIL` line, and every FAIL
# prints the ONE correct remediation directly under it.
#
#   1. server-reachable   — is the trajectory-server process alive?
#   2. cache-version      — DB-recorded plugin_version == installed (intended) version?
#   3. schema-version     — DB schema_version == the installed server's TARGET?
#   4. world-model        — kuzu graph openable? (graph_db_open_failed sub-diagnosis)
#   5. label-config       — issue_classification_labels configured, not the bare default?
#   6. stale-state        — orphaned worktrees / pending|running tasks?
#   7. hook-cache-drift   — running hooks load from the cache, not the dev checkout?
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

PLUGIN_NAME="tmb"
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
fi

FAILED=0

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

DB=""
DB=$(tmb_db_path 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Resolve the installed (intended) version + cache dir from CC's
# installed_plugins.json. This is what the Human asked CC to run; the DB's
# plugin_meta.plugin_version is what the server actually BOOTED with. Drift
# between the two is exactly the post-upgrade failure mode we diagnose.
# ---------------------------------------------------------------------------
INSTALLED_JSON="${TMB_HEALTH_INSTALLED_JSON:-$HOME/.claude/plugins/installed_plugins.json}"
INTENDED_VERSION="${TMB_HEALTH_INTENDED_VERSION:-}"
CACHE_DIR="${TMB_HEALTH_CACHE_DIR:-}"
if [ -z "$INTENDED_VERSION" ] || [ -z "$CACHE_DIR" ]; then
  if [ -f "$INSTALLED_JSON" ] && command -v jq >/dev/null 2>&1; then
    # Prefer the dev-channel entry when CLAUDE_PLUGIN_ROOT points into one of
    # the channels; otherwise take the first tmb entry. Deterministic: newest
    # lastUpdated wins among the tmb entries.
    _entry=$(jq -r --arg root "${CLAUDE_PLUGIN_ROOT:-}" '
      .plugins
      | to_entries
      | map(select(.key | test("^'"$PLUGIN_NAME"'@")))
      | map(.value[0] + {key: .key})
      | (map(select($root != "" and (.installPath == $root))) + .)
      | .[0] // empty
      | "\(.version)\t\(.installPath)"
    ' "$INSTALLED_JSON" 2>/dev/null || true)
    if [ -n "$_entry" ]; then
      [ -z "$INTENDED_VERSION" ] && INTENDED_VERSION=$(printf '%s' "$_entry" | cut -f1)
      [ -z "$CACHE_DIR" ] && CACHE_DIR=$(printf '%s' "$_entry" | cut -f2)
    fi
  fi
fi

# Server log: prefer override, else the canonical per-plugin logs dir.
SERVER_LOG="${TMB_HEALTH_SERVER_LOG:-$HOME/.claude/${PLUGIN_NAME}/logs/mcp-server.log}"

printf '== TMB health-check ==\n'
printf 'db:        %s\n' "${DB:-<unresolved>}"
printf 'cache:     %s\n' "${CACHE_DIR:-<unresolved>}"
printf 'server-log:%s\n' "$SERVER_LOG"
printf '\n'

# ===========================================================================
# 1. server-reachable
# ===========================================================================
PGREP_COUNT="${TMB_HEALTH_PGREP_COUNT:-}"
if [ -z "$PGREP_COUNT" ]; then
  if command -v pgrep >/dev/null 2>&1; then
    _pat="trajectory-server/dist/index.js"
    [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && _pat="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js"
    PGREP_COUNT=$({ pgrep -f "$_pat" 2>/dev/null || true; } | wc -l | tr -d ' ')
  else
    PGREP_COUNT="-1"
  fi
fi
if [ "$PGREP_COUNT" = "-1" ]; then
  pass "server-reachable: pgrep unavailable — cannot probe (assuming reachable)"
elif [ "$PGREP_COUNT" -gt 0 ] 2>/dev/null; then
  pass "server-reachable: trajectory-server process alive ($PGREP_COUNT)"
else
  fail "server-reachable: NO trajectory-server process found"
  remediate \
    "Fully quit Claude Code (Cmd-Q) and relaunch — a dead MCP server needs a full restart, NOT /reload-plugins." \
    "If it does not come back after relaunch, see skills/tmb_recovery (CC plugin MCP-config cache bug)." \
    "Forensics: tail -n 50 $SERVER_LOG"
fi

# ===========================================================================
# 2. cache-version — DB plugin_version vs installed (intended) version
# ===========================================================================
DB_PLUGIN_VERSION=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  DB_PLUGIN_VERSION=$(tmb_sqlite_ro "$DB" "SELECT plugin_version FROM plugin_meta WHERE id = 1;")
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
    "Run /plugin update, then fully quit + relaunch Claude Code so the server reboots on the new cache." \
    "/reload-plugins will NOT pick up the new server — the MCP process is long-lived."
fi

# ===========================================================================
# 3. schema-version — DB schema_version vs the installed server's TARGET
# ===========================================================================
DB_SCHEMA_VERSION=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  DB_SCHEMA_VERSION=$(tmb_sqlite_ro "$DB" "SELECT schema_version FROM plugin_meta WHERE id = 1;")
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
# 4. world-model (kuzu) — graph openable? graph_db_open_failed sub-diagnosis
# ===========================================================================
# The graph file is a sibling of the DB: <...>/world-model.kuzu
KUZU_FILE=""
if [ -n "$DB" ]; then
  KUZU_FILE="${DB%trajectory.db}world-model.kuzu"
fi
# Most recent graph_db_open / graph_db_open_failed line from the server log.
LAST_GRAPH_LINE=""
if [ -f "$SERVER_LOG" ]; then
  LAST_GRAPH_LINE=$(grep -E '"kind":"graph_db_open(_failed)?"' "$SERVER_LOG" 2>/dev/null | tail -1)
fi
KUZU_MODULE_DIR=""
[ -n "$CACHE_DIR" ] && KUZU_MODULE_DIR="$CACHE_DIR/mcp/trajectory-server/node_modules/kuzu"

case "$LAST_GRAPH_LINE" in
  *graph_db_open_failed*)
    # A failure is the latest signal. Sub-diagnose by error_message.
    if printf '%s' "$LAST_GRAPH_LINE" | grep -qiE 'could not set lock|lock.*world-model'; then
      fail "world-model: kuzu open FAILED — graph file is locked by another process"
      remediate \
        "A concurrent/orphan trajectory-server holds the single-writer lock." \
        "Close the other Claude Code session, OR kill the orphan: pkill -f 'trajectory-server/dist/index.js'" \
        "Then fully quit + relaunch THIS session. The .kuzu data is intact — do NOT /scan."
    elif [ -n "$KUZU_MODULE_DIR" ] && [ ! -f "$KUZU_MODULE_DIR/index.js" ]; then
      fail "world-model: kuzu open FAILED — native binding not installed (postinstall skipped)"
      remediate \
        "cd $KUZU_MODULE_DIR && node install.js" \
        "Then fully quit + relaunch Claude Code so the server reboots with kuzu present."
    else
      fail "world-model: kuzu open FAILED — see server log"
      remediate \
        "Inspect the error: grep graph_db_open_failed $SERVER_LOG | tail -1" \
        "If the native binding is missing: cd ${KUZU_MODULE_DIR:-<cache>/mcp/trajectory-server/node_modules/kuzu} && node install.js, then full restart." \
        "The .kuzu data survives — only /scan if the graph file is gone."
    fi
    ;;
  *graph_db_open*)
    pass "world-model: kuzu graph opened successfully (per server log)"
    ;;
  *)
    # No log evidence either way — fall back to filesystem checks.
    if [ -n "$KUZU_MODULE_DIR" ] && [ ! -f "$KUZU_MODULE_DIR/index.js" ]; then
      fail "world-model: kuzu native binding missing (no index.js — postinstall skipped)"
      remediate \
        "cd $KUZU_MODULE_DIR && node install.js" \
        "Then fully quit + relaunch Claude Code so the server reboots with kuzu present."
    elif [ -n "$KUZU_FILE" ] && [ ! -e "$KUZU_FILE" ]; then
      fail "world-model: graph file missing ($KUZU_FILE)"
      remediate \
        "Build the world model: run /scan."
    else
      pass "world-model: kuzu binding present, graph file exists (no failure logged)"
    fi
    ;;
esac

# ===========================================================================
# 5. label-config — issue_classification_labels sane (not bare default)
# ===========================================================================
LABELS_RAW=""
if [ -n "$DB" ] && tmb_have_sqlite; then
  LABELS_RAW=$(tmb_config_raw "issue_classification_labels" "$DB")
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
  PENDING_TASKS=$(tmb_sqlite_ro "$DB" "
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
    "After /plugin update brings the cache to your version, run /reload-plugins to load the new hook/skill/agent/command definitions." \
    "(/reload-plugins is the RIGHT tool here — these are definition files, not the MCP server.)"
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '== all checks passed ==\n'
  exit 0
else
  printf '== %d check(s) FAILED ==\n' "$FAILED"
  exit 1
fi
