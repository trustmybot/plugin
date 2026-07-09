#!/usr/bin/env bash
# Tests for scripts/hooks/orphan-scan.sh.
#
# Contract: a SessionStart hook that detects (and, gated, cleans) cross-upgrade
# TMB orphans scoped STRICTLY to the current project. The critical invariant is
# project isolation: another project's stale-looking DB / cache version must
# never be reported or touched.
#
# Each case builds a fully sandboxed HOME + project root and drives the hook via
# TMB_ORPHAN_SCAN_HOME / TMB_ORPHAN_SCAN_PROJECT_DIR so nothing leaks onto the
# real machine.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/orphan-scan.sh"

PLUGIN_NAME="tmb"

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# slug must match the hook's project_slug(): non-alphanumeric runs → '-'.
slug_for() { printf '%s' "$1" | sed -E 's/[^A-Za-z0-9]+/-/g'; }

# Create a trajectory.db with a given schema_version. Empty version → 0-byte.
make_db() {
  local path="$1" version="${2:-}"
  mkdir -p "$(dirname "$path")"
  if [ -z "$version" ]; then
    : > "$path"   # 0-byte
    return 0
  fi
  sqlite3 "$path" \
    "CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL);
     INSERT INTO plugin_meta (schema_version, plugin_version) VALUES ($version, '0.0.0');" 2>/dev/null
}

# Run the hook in a sandboxed (HOME, project) pair. Echoes stdout.
run_hook() {
  local home="$1" project="$2" clean="${3:-0}"
  TMB_ORPHAN_SCAN_HOME="$home" \
  TMB_ORPHAN_SCAN_PROJECT_DIR="$project" \
  TMB_ORPHAN_SCAN_CLEAN="$clean" \
    bash "$HOOK" <<<'{"hook_event_name":"SessionStart"}' 2>/dev/null || true
}

# --- fixture scaffolding ----------------------------------------------------
# A sandbox with: a live project (live DB schema 26), its history dir holding a
# 0-byte stale DB, and an OTHER project with its own stale-looking DB + a cache
# version pinned ONLY by that other project.
build_sandbox() {
  local home="$1" project="$2"
  mkdir -p "$home/.claude/plugins/cache" "$home/.claude/projects"

  # Live DB for the current project (schema 26).
  make_db "$project/.claude/$PLUGIN_NAME/trajectory.db" 26

  # Stale 0-byte old-layout DB in this project's history dir.
  local slug; slug=$(slug_for "$project")
  make_db "$home/.claude/projects/$slug/trajectory.db" ""
}

# ===========================================================================
test_case "current-project 0-byte stale DB is reported; live DB is not"
HOME1="$TMPROOT/h1"
PROJ1="$TMPROOT/proj1"
build_sandbox "$HOME1" "$PROJ1"
out=$(run_hook "$HOME1" "$PROJ1")
SLUG1=$(slug_for "$PROJ1")
assert_contains "$out" "$HOME1/.claude/projects/$SLUG1/trajectory.db" "stale DB reported"
assert_not_contains "$out" "$PROJ1/.claude/$PLUGIN_NAME/trajectory.db" "live DB never reported"

# ===========================================================================
test_case "report-only mode deletes nothing"
HOME2="$TMPROOT/h2"
PROJ2="$TMPROOT/proj2"
build_sandbox "$HOME2" "$PROJ2"
SLUG2=$(slug_for "$PROJ2")
STALE2="$HOME2/.claude/projects/$SLUG2/trajectory.db"
run_hook "$HOME2" "$PROJ2" >/dev/null
[ -f "$STALE2" ] && _pass || _fail "stale DB removed in report-only mode"
[ -f "$PROJ2/.claude/$PLUGIN_NAME/trajectory.db" ] && _pass || _fail "live DB removed in report-only"

# ===========================================================================
test_case "gated cleanup removes the stale DB; live DB intact"
HOME3="$TMPROOT/h3"
PROJ3="$TMPROOT/proj3"
build_sandbox "$HOME3" "$PROJ3"
SLUG3=$(slug_for "$PROJ3")
STALE3="$HOME3/.claude/projects/$SLUG3/trajectory.db"
run_hook "$HOME3" "$PROJ3" 1 >/dev/null
[ ! -f "$STALE3" ] && _pass || _fail "gated cleanup did not remove stale DB"
[ -f "$PROJ3/.claude/$PLUGIN_NAME/trajectory.db" ] && _pass || _fail "gated cleanup removed live DB"

# ===========================================================================
test_case "OTHER project's stale DB is never reported or touched"
HOME4="$TMPROOT/h4"
PROJ4="$TMPROOT/proj4"          # current project
OTHER4="$TMPROOT/other4"        # different project, NOT being scanned
build_sandbox "$HOME4" "$PROJ4"
# Other project's own history dir with a 0-byte DB — legitimate, not ours.
OSLUG=$(slug_for "$OTHER4")
OTHER_STALE="$HOME4/.claude/projects/$OSLUG/trajectory.db"
make_db "$OTHER_STALE" ""
out=$(run_hook "$HOME4" "$PROJ4" 1)
assert_not_contains "$out" "$OTHER_STALE" "other project's DB not reported"
[ -f "$OTHER_STALE" ] && _pass || _fail "other project's DB was deleted (invariant breach)"

# ===========================================================================
test_case "unused cache version is a candidate; pinned versions are not"
HOME5="$TMPROOT/h5"
PROJ5="$TMPROOT/proj5"
build_sandbox "$HOME5" "$PROJ5"
CACHE5="$HOME5/.claude/plugins/cache/trustmybot-dev/$PLUGIN_NAME"
PINNED_DIR="$CACHE5/0.10.0-rc.4"   # pinned by another project below
UNUSED_DIR="$CACHE5/0.9.0"         # pinned by nobody
mkdir -p "$PINNED_DIR" "$UNUSED_DIR"
cat > "$HOME5/.claude/plugins/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "tmb@trustmybot-dev": [
      { "scope": "local", "projectPath": "$TMPROOT/someother", "installPath": "$PINNED_DIR", "version": "0.10.0-rc.4" }
    ]
  }
}
EOF
out=$(run_hook "$HOME5" "$PROJ5")
assert_contains "$out" "$UNUSED_DIR" "unused cache version reported as candidate"
assert_not_contains "$out" "$PINNED_DIR" "pinned cache version (other project) never a candidate"

# ===========================================================================
test_case "gated cleanup removes only the unused cache version, keeps pinned"
run_hook "$HOME5" "$PROJ5" 1 >/dev/null
[ ! -d "$UNUSED_DIR" ] && _pass || _fail "unused cache version not cleaned"
[ -d "$PINNED_DIR" ] && _pass || _fail "pinned cache version was removed (invariant breach)"

# ===========================================================================
test_case "non-stale DB (same schema as live) is not reported"
HOME6="$TMPROOT/h6"
PROJ6="$TMPROOT/proj6"
build_sandbox "$HOME6" "$PROJ6"
SLUG6=$(slug_for "$PROJ6")
# Replace the 0-byte dup with one matching the live schema → not stale.
make_db "$HOME6/.claude/projects/$SLUG6/trajectory.db" 26
out=$(run_hook "$HOME6" "$PROJ6")
assert_not_contains "$out" "$HOME6/.claude/projects/$SLUG6/trajectory.db" "current-schema dup not flagged"

# ===========================================================================
test_case "clean sandbox: silent (no findings, exit 0)"
HOME7="$TMPROOT/h7"
PROJ7="$TMPROOT/proj7"
mkdir -p "$HOME7/.claude/plugins/cache" "$HOME7/.claude/projects"
make_db "$PROJ7/.claude/$PLUGIN_NAME/trajectory.db" 26
out=$(run_hook "$HOME7" "$PROJ7")
assert_eq "" "$out" "no findings → empty output"

# ===========================================================================
test_case "lsof / sqlite absence degrades gracefully (still exits 0)"
HOME8="$TMPROOT/h8"
PROJ8="$TMPROOT/proj8"
build_sandbox "$HOME8" "$PROJ8"
# Curate PATH so lsof and sqlite3 are unavailable but the shell + core tools
# (env, bash) still resolve; the hook must degrade rather than crash.
CURATED_BIN="$TMPROOT/curatedbin"
mkdir -p "$CURATED_BIN"
for b in env bash sh jq date find grep sed sort head tail ps kill rm mkdir cat printf awk dirname basename ln; do
  src=$(command -v "$b" 2>/dev/null) && ln -sf "$src" "$CURATED_BIN/$b"
done
PATH="$CURATED_BIN" TMB_ORPHAN_SCAN_HOME="$HOME8" TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJ8" \
  bash "$HOOK" <<<'{"hook_event_name":"SessionStart"}' >/dev/null 2>&1
assert_exit_code 0 "$?" "soft-fail with missing lsof/sqlite3"

summarize
