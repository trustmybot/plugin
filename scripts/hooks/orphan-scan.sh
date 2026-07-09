#!/usr/bin/env bash
# SessionStart hook — project-scoped cross-upgrade orphan scan.
#
# Detects (and, only when explicitly opted in, cleans) TMB artifacts left
# behind by version upgrades, scoped STRICTLY to the CURRENT project:
#   1. Stale old-layout / 0-byte trajectory DBs of THIS project.
#   2. A stale duplicate trajectory-server proc holding THIS project's live DB.
#   3. Cache version dirs referenced by NO installed_plugins.json entry
#      (globally unused — safe to clean regardless of project).
#
# CRITICAL INVARIANT — project-scoped only.
#   Other projects may legitimately run a DIFFERENT TMB version, each with its
#   own cache dir, MCP process, and trajectory.db. Those are NOT orphans. This
#   hook never enumerates, reports, or touches another project's DB, process,
#   or pinned cache version. The ONLY cross-project action permitted is
#   removing a cache version that NO installed_plugins entry pins.
#
# Safety: detection-first (default report-only); cleanup gated behind
# TMB_ORPHAN_SCAN_CLEAN=1 (default OFF); the live DB is always kept; idempotent;
# soft-fails; advisory — never blocks SessionStart; tight internal timeout.

set -uo pipefail

# Advisory only: any unexpected failure must exit 0 so SessionStart proceeds.
trap 'exit 0' ERR

# --- internal timeout guard -------------------------------------------------
# Self-cap: if anything wedges (a stuck lsof, a slow find), bail well within
# the hooks.json timeout so the session is never blocked.
SCAN_DEADLINE=$(( $(date +%s) + 4 ))
_within_deadline() { [ "$(date +%s)" -lt "$SCAN_DEADLINE" ]; }

CLEAN="${TMB_ORPHAN_SCAN_CLEAN:-0}"

# --- plugin name ------------------------------------------------------------
PLUGIN_NAME="tmb"
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
fi

# Required tooling — degrade silently if absent.
command -v jq >/dev/null 2>&1 || exit 0

# --- resolve the CURRENT project --------------------------------------------
# Test override: TMB_ORPHAN_SCAN_PROJECT_DIR pins the project root and
# TMB_ORPHAN_SCAN_HOME pins the HOME used for ~/.claude lookups so tests run
# fully sandboxed.
PROJECT_DIR="${TMB_ORPHAN_SCAN_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
SCAN_HOME="${TMB_ORPHAN_SCAN_HOME:-$HOME}"

# Live DB for THIS project. Always kept; the anchor for everything below.
LIVE_DB="$PROJECT_DIR/.claude/$PLUGIN_NAME/trajectory.db"

# Project slug for ~/.claude/projects/<slug>: absolute path with every
# non-alphanumeric run collapsed to a single '-' (CC's slug convention).
project_slug() {
  printf '%s' "$1" | sed -E 's/[^A-Za-z0-9]+/-/g'
}
SLUG=$(project_slug "$PROJECT_DIR")
PROJECT_HISTORY_DIR="$SCAN_HOME/.claude/projects/$SLUG"

# schema_version of a DB, or empty if unreadable / no plugin_meta.
db_schema_version() {
  local db="$1"
  command -v sqlite3 >/dev/null 2>&1 || { printf ''; return 0; }
  sqlite3 "$db" "SELECT schema_version FROM plugin_meta ORDER BY id DESC LIMIT 1;" 2>/dev/null || printf ''
}

LIVE_SCHEMA=""
[ -s "$LIVE_DB" ] && LIVE_SCHEMA=$(db_schema_version "$LIVE_DB")

REPORT=""
add_report() { REPORT="${REPORT}$1
"; }

# --- (1) stale old-layout DBs of THIS project -------------------------------
# Candidate locations belonging to the current project ONLY. The live DB is
# NEVER a candidate. A candidate is reported when it is 0-byte OR has a
# schema_version older than the live DB.
STALE_DBS=()
consider_stale_db() {
  local db="$1"
  [ -e "$db" ] || return 0
  # Never the live DB — resolve both to absolute, compared as plain strings.
  [ "$db" = "$LIVE_DB" ] && return 0
  if [ ! -s "$db" ]; then
    STALE_DBS+=("$db")
    return 0
  fi
  # Non-empty: stale only if we can read both versions and this one is older.
  local v
  v=$(db_schema_version "$db")
  if [ -n "$v" ] && [ -n "$LIVE_SCHEMA" ] && [ "$v" -lt "$LIVE_SCHEMA" ] 2>/dev/null; then
    STALE_DBS+=("$db")
  fi
}

# Old-layout duplicate locations for THIS project's slug, plus a legacy
# ~/.claude/<plugin>/ DB ONLY if it maps to this project (i.e. there is no
# other project that could own it — the legacy single-location path predates
# multi-project, so it belongs to whichever project is resolving it).
consider_stale_db "$PROJECT_HISTORY_DIR/trajectory.db"
consider_stale_db "$PROJECT_HISTORY_DIR/memory/trajectory.db"
LEGACY_DB="$SCAN_HOME/.claude/$PLUGIN_NAME/trajectory.db"
# Legacy DB is only THIS project's when the live DB is absent (pre-migration
# state). If a live per-project DB exists, the legacy path is ambiguous and we
# leave it alone.
if [ ! -s "$LIVE_DB" ]; then
  consider_stale_db "$LEGACY_DB"
fi

if [ "${#STALE_DBS[@]}" -gt 0 ]; then
  for db in "${STALE_DBS[@]}"; do
    add_report "stale trajectory DB (this project): $db"
  done
fi

# --- (3) globally-unused cache versions -------------------------------------
# A cache version dir referenced by NO installed_plugins.json entry. A version
# pinned by ANY project (current or other) is never a candidate.
INSTALLED_JSON="$SCAN_HOME/.claude/plugins/installed_plugins.json"
CACHE_ROOT="$SCAN_HOME/.claude/plugins/cache"
UNUSED_CACHE=()
if [ -f "$INSTALLED_JSON" ] && [ -d "$CACHE_ROOT" ] && _within_deadline; then
  # All installPath values currently pinned (any plugin, any channel, any project).
  PINNED_PATHS=$(jq -r '
    .plugins // {} | to_entries[] | .value[]? | .installPath // empty
  ' "$INSTALLED_JSON" 2>/dev/null || printf '')
  # Enumerate this plugin's cache version dirs across every channel.
  while IFS= read -r vdir; do
    [ -d "$vdir" ] || continue
    _within_deadline || break
    # Pinned if any installed_plugins entry's installPath equals this dir.
    if printf '%s\n' "$PINNED_PATHS" | grep -qxF "$vdir"; then
      continue
    fi
    UNUSED_CACHE+=("$vdir")
  done < <(find "$CACHE_ROOT" -mindepth 3 -maxdepth 3 -type d -path "*/$PLUGIN_NAME/*" 2>/dev/null)
fi

if [ "${#UNUSED_CACHE[@]}" -gt 0 ]; then
  for vdir in "${UNUSED_CACHE[@]}"; do
    add_report "unused cache version (pinned by no project): $vdir"
  done
fi

# --- (2) stale duplicate MCP proc on THIS project's live DB -----------------
# Only flag a trajectory-server node proc that holds THIS project's live DB.
# A proc holding any OTHER project's DB is never enumerated. lsof absence
# degrades gracefully (we simply report nothing).
DUP_PROCS=()
if [ -s "$LIVE_DB" ] && command -v lsof >/dev/null 2>&1 && _within_deadline; then
  # PIDs with the live DB file open.
  HOLDERS=$(lsof -t -- "$LIVE_DB" 2>/dev/null | sort -u || printf '')
  if [ -n "$HOLDERS" ]; then
    HOLDER_COUNT=$(printf '%s\n' "$HOLDERS" | grep -c . || printf '0')
    # A single holder is the live server — not a duplicate. Only when more
    # than one trajectory-server holds the SAME live DB is there a stale dup.
    if [ "$HOLDER_COUNT" -gt 1 ]; then
      while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        # Confirm it is a trajectory-server node proc (not an unrelated reader).
        if ps -p "$pid" -o command= 2>/dev/null | grep -q 'trajectory-server'; then
          DUP_PROCS+=("$pid")
        fi
      done < <(printf '%s\n' "$HOLDERS")
    fi
  fi
fi

if [ "${#DUP_PROCS[@]}" -gt 1 ]; then
  # Keep the lowest PID (oldest / live); the rest are stale duplicates.
  SORTED=$(printf '%s\n' "${DUP_PROCS[@]}" | sort -n)
  KEEP=$(printf '%s\n' "$SORTED" | head -1)
  STALE_PROCS=()
  while IFS= read -r pid; do
    [ "$pid" = "$KEEP" ] && continue
    STALE_PROCS+=("$pid")
  done < <(printf '%s\n' "$SORTED")
  for pid in "${STALE_PROCS[@]}"; do
    add_report "stale duplicate trajectory-server on this project's live DB: pid $pid"
  done
else
  STALE_PROCS=()
fi

# --- cleanup (gated) --------------------------------------------------------
# Default OFF. When on, act ONLY on the project-scoped candidates above plus
# globally-unused cache. The live DB and other projects' artifacts are never
# touched (they were never collected as candidates).
CLEANED=""
if [ "$CLEAN" = "1" ]; then
  for db in "${STALE_DBS[@]:-}"; do
    [ -n "$db" ] || continue
    [ "$db" = "$LIVE_DB" ] && continue   # belt-and-suspenders: never the live DB
    if rm -f "$db" 2>/dev/null; then
      CLEANED="${CLEANED}removed stale DB: $db
"
    fi
  done
  for vdir in "${UNUSED_CACHE[@]:-}"; do
    [ -n "$vdir" ] || continue
    case "$vdir" in
      "$CACHE_ROOT"/*) ;;
      *) continue ;;   # never delete outside the cache root
    esac
    if rm -rf "$vdir" 2>/dev/null; then
      CLEANED="${CLEANED}removed unused cache version: $vdir
"
    fi
  done
  for pid in "${STALE_PROCS[@]:-}"; do
    [ -n "$pid" ] || continue
    # Liveness check then terminate only the confirmed stale duplicate.
    if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'trajectory-server'; then
      if kill "$pid" 2>/dev/null; then
        CLEANED="${CLEANED}terminated stale duplicate trajectory-server: pid $pid
"
      fi
    fi
  done
fi

# --- emit advisory context --------------------------------------------------
if [ -z "$REPORT" ]; then
  exit 0
fi

MODE_LINE="report-only (set TMB_ORPHAN_SCAN_CLEAN=1 to clean)"
[ "$CLEAN" = "1" ] && MODE_LINE="cleanup enabled (TMB_ORPHAN_SCAN_CLEAN=1)"

CTX="=== TMB orphan scan (project-scoped) ===
project: $PROJECT_DIR
mode: $MODE_LINE
${REPORT}"
if [ -n "$CLEANED" ]; then
  CTX="${CTX}--- cleaned ---
${CLEANED}"
fi
CTX="${CTX}========================================"

jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}' 2>/dev/null || true
exit 0
