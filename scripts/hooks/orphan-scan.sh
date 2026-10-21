#!/usr/bin/env bash
# SessionStart hook — project-scoped cross-upgrade orphan scan.
#
# Detects (and, only when explicitly opted in, cleans) TMB artifacts left
# behind by version upgrades, scoped STRICTLY to the CURRENT project:
#   1. Stale old-layout / 0-byte trajectory DBs of THIS project.
#   2. A stale duplicate trajectory-server proc holding THIS project's live DB
#      whose owning CC session is dead. A server owned by a live session (this
#      one or another) is never reported: SQLite WAL lets concurrent sessions
#      share the DB.
#   3. Cache version dirs referenced by NO installed_plugins.json entry
#      (globally unused — safe to clean regardless of project).
#
# CRITICAL INVARIANT — project-scoped only.
#   Other projects may legitimately run a DIFFERENT TMB version, each with its
#   own cache dir, MCP process, and trajectory DB. Those are NOT orphans. This
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

# --- plugin name ------------------------------------------------------------
PLUGIN_NAME=$(tmb_plugin_name)

# Required tooling — degrade silently if absent.
command -v jq >/dev/null 2>&1 || exit 0

# --- resolve the CURRENT project --------------------------------------------
# Test override: TMB_ORPHAN_SCAN_PROJECT_DIR pins the project root and
# TMB_ORPHAN_SCAN_HOME pins the HOME used for ~/.claude lookups so tests run
# fully sandboxed.
SCAN_HOME="${TMB_ORPHAN_SCAN_HOME:-$HOME}"

# Live DB for THIS project (the one DB-path rule). Always kept; the anchor for everything below. Unresolved =
# not onboarded yet: the live DB is where the project root would hold it.
if [ -n "${TMB_ORPHAN_SCAN_PROJECT_DIR:-}" ]; then
  LIVE_DB=$(CLAUDE_PROJECT_DIR="$TMB_ORPHAN_SCAN_PROJECT_DIR" tmb_db_path || true)
  PROJECT_DIR="$TMB_ORPHAN_SCAN_PROJECT_DIR"
else
  LIVE_DB=$(tmb_db_path || true)
  PROJECT_DIR=$(tmb_project_root)
  [ -n "$LIVE_DB" ] && [ -z "${TRAJECTORY_DB_PATH:-}" ] && PROJECT_DIR=$(dirname "$(dirname "$(dirname "$LIVE_DB")")")
fi
[ -n "$PROJECT_DIR" ] || exit 0
[ -n "$LIVE_DB" ] || LIVE_DB=$(tmb_db_location "$PROJECT_DIR")
LIVE_READ=""
if [ -e "$LIVE_DB" ]; then
  LIVE_READ=$(tmb_gate_read "$LIVE_DB" 'SELECT count(*) FROM sqlite_master;')
fi
if [ "$LIVE_READ" = "__ERR__" ]; then
  printf 'orphan-scan: trajectory DB unavailable (%s) — scan continues without its schema version\n' "$LIVE_DB" >&2
fi

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
  tmb_sqlite_ro "$db" "SELECT schema_version FROM plugin_meta ORDER BY id DESC LIMIT 1;"
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
consider_stale_db "$PROJECT_HISTORY_DIR/$TMB_DB_FILENAME"
consider_stale_db "$PROJECT_HISTORY_DIR/memory/$TMB_DB_FILENAME"
LEGACY_DB=$(tmb_db_location "$SCAN_HOME")
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
    if printf '%s\n' "$PINNED_PATHS" | grep -xF "$vdir" >/dev/null; then
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

# --- (2) MCP procs holding THIS project's live DB ---------------------------
# Only trajectory-server node procs that hold THIS project's live DB are
# enumerated (a proc holding any OTHER project's DB is never touched). Each
# holder is classified by its owning CC session:
#   - own session's server (its parent chain contains this session's CC proc)
#     or a live other session's server → not reported, never killed. SQLite WAL
#     serves concurrent processes, so a sibling session's server is no conflict.
#   - a holder whose owning CC session is dead/absent → stale duplicate;
#     reported and eligible for clean-mode termination.
# POSIX ps -o pid=,ppid= ancestry walks (no /proc dependence) keep this
# portable across macOS and Linux. lsof absence degrades gracefully.

# ppid of a pid (empty on failure — never trips the ERR trap).
proc_ppid() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || printf ''; }
# full command of a pid (empty on failure).
proc_cmd()  { ps -o command= -p "$1" 2>/dev/null || printf ''; }

# A Claude Code process: any word of its full command line is the CC CLI —
# basename `claude` / `claude.exe` (`claude`, `node /x/bin/claude`, the desktop
# app's `.../claude.app/Contents/MacOS/claude`), a native-installer version
# binary (`.../claude/versions/<v>`), or the npm package entry
# (`node .../@anthropic-ai/claude-code/cli.js`). A `.claude/` path component is
# not a match, so shell-snapshot wrappers stay out, and no word of the
# `node .../trajectory-server/dist/index.js` child matches.
is_cc_cmd() {
  local word words
  read -ra words <<<"$1"
  for word in ${words[@]+"${words[@]}"}; do
    case "$word" in
      claude|claude.exe|*/claude|*/claude.exe|*/claude/versions/*|*/claude-code/cli.js|*/claude-code/cli.mjs) return 0 ;;
    esac
  done
  return 1
}

# Walk a pid's ancestry (starting at pid itself) up to init; echo the pid of
# the nearest Claude Code ancestor, or empty when none is found. Always 0.
nearest_cc_ancestor() {
  local pid="$1" guard=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    guard=$((guard + 1)); [ "$guard" -gt 40 ] && break
    if is_cc_cmd "$(proc_cmd "$pid")"; then printf '%s' "$pid"; return 0; fi
    pid=$(proc_ppid "$pid")
  done
  printf ''
}

# True when target appears anywhere in pid's ancestry (pid included).
chain_contains() {
  local pid="$1" target="$2" guard=0
  [ -n "$target" ] || return 1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    guard=$((guard + 1)); [ "$guard" -gt 40 ] && break
    [ "$pid" = "$target" ] && return 0
    pid=$(proc_ppid "$pid")
  done
  return 1
}

# Holders of the live DB: a test override (whitespace-separated PIDs) wins so
# L3 can drive fabricated process trees; otherwise lsof enumerates real ones.
resolve_holders() {
  if [ -n "${TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE:-}" ]; then
    printf '%s\n' "$TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE" | tr ' ' '\n'
    return 0
  fi
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -t -- "$LIVE_DB" 2>/dev/null | sort -u || printf ''
}

# Resolve the CURRENT session's own CC proc by walking this hook's ancestry.
# TMB_ORPHAN_SCAN_SELF_PID pins the start pid so L3 can drive it.
OWN_CC=$(nearest_cc_ancestor "${TMB_ORPHAN_SCAN_SELF_PID:-$$}")

STALE_PROCS=()      # dead-owner holders — reported and clean-mode killable
if [ -s "$LIVE_DB" ] && _within_deadline; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    # Confirm it is a trajectory-server node proc (not an unrelated reader).
    ps -p "$pid" -o command= 2>/dev/null | grep 'trajectory-server' >/dev/null || continue
    chain_contains "$pid" "$OWN_CC" && continue
    owner=$(nearest_cc_ancestor "$pid")
    [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null && continue
    STALE_PROCS+=("$pid")
  done < <(resolve_holders)
fi

for pid in "${STALE_PROCS[@]:-}"; do
  [ -n "$pid" ] || continue
  add_report "stale duplicate trajectory-server on this project's live DB: pid $pid"
done

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
    if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep 'trajectory-server' >/dev/null; then
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
