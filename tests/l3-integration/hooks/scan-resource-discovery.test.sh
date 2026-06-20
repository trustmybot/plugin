#!/usr/bin/env bash
# L3: scan resource-discovery (#124/#846).
# scripts/scan.sh — after the repo/file walk, reconciles locally-present
# resources (project-local skills, plugins, mcp servers) into the cheatcodes
# table: each not-already-tracked resource is INSERTed with its lifecycle-correct
# provenance (a local skill is origin=external, source_url='skill:<name>',
# status=active; #150) + a scan_discovered audit row.
#
# Cases:
#   - a new local skill on disk          → registered + audited
#   - re-run                             → no duplicate (idempotent on name+kind)
#   - already-tracked skill              → untouched, no audit (left to #113)
#   - absent `claude` CLI                → graceful (skills still from disk)
#
# All state lives under a mktemp sandbox (per #810); TRAJECTORY_DB_PATH pins
# the DB so the real plugin DB is never touched. assert_not_in_plugin_repo
# guards against running with cwd inside the real plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCAN="$PLUGIN_ROOT/scripts/scan.sh"

command -v sqlite3 >/dev/null 2>&1 || { printf "SKIP sqlite3 not found\n"; exit 0; }
command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

WS="$TMPDIR/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"

# Minimal schema: tasks carries prompt_bearing so tmb_db_schema_current accepts
# the DB; cheatcodes carries the columns the discovery INSERT names; audit
# mirrors the production shape.
seed_db() {
  rm -f "$DB"
  sqlite3 "$DB" "
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cheatcodes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      origin       TEXT NOT NULL DEFAULT 'installed',
      source_url   TEXT,
      file_path    TEXT,
      scope        TEXT NOT NULL DEFAULT 'project-local',
      status       TEXT NOT NULL DEFAULT 'installed',
      installed_at TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id     INTEGER NOT NULL DEFAULT -1,
      branch_id    TEXT,
      from_node    TEXT NOT NULL DEFAULT 'bro',
      event_type   TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

# A project-local skill on disk under the scanned session dir.
mk_skill() {
  local name="$1"
  mkdir -p "$WS/.claude/skills/$name"
  printf -- '---\nname: %s\n---\nbody\n' "$name" > "$WS/.claude/skills/$name/SKILL.md"
}

# A PATH that excludes any system `claude` but keeps the tools scan.sh needs.
NOCLAUDE_BIN="$TMPDIR/nocl_bin"
mkdir -p "$NOCLAUDE_BIN" "$TMPDIR/home"
for t in sqlite3 jq grep sed cat dirname basename date timeout env bash awk find sort md5 md5sum stat wc xargs printf tr which head mktemp rm mkdir ln; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$NOCLAUDE_BIN/$t" 2>/dev/null || true
done

# Run scan.sh with an isolated PATH (claude absent), TRAJECTORY_DB_PATH pinned,
# scanning the workspace dir. stdout (world-model JSON) is captured separately.
run_scan() {
  env -i \
    HOME="$TMPDIR/home" \
    PATH="$1" \
    TRAJECTORY_DB_PATH="$DB" \
    bash "$SCAN" "$WS" 2>/dev/null || true
}

cc_row() { sqlite3 "$DB" "SELECT origin||'|'||COALESCE(source_url,'')||'|'||status||'|'||COALESCE(file_path,'') FROM cheatcodes WHERE name='$1' AND kind='$2';"; }
cc_count() { sqlite3 "$DB" "SELECT COUNT(*) FROM cheatcodes WHERE name='$1' AND kind='$2';"; }
audit_count() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='scan_discovered' AND summary LIKE '$1%';"; }

# ---------------------------------------------------------------------------
# Case 1 — a new local skill on disk is registered + audited.
# ---------------------------------------------------------------------------
seed_db
mk_skill "alpha-skill"
JSON=$(run_scan "$NOCLAUDE_BIN")

test_case "scan still emits valid world-model JSON (stdout unchanged)"
assert_contains "$JSON" '"session_dir"' "scan json"

test_case "new local skill registered as external/skill:<name> row"
assert_eq "external|skill:alpha-skill|active|.claude/skills/alpha-skill/SKILL.md" \
  "$(cc_row alpha-skill skill)" "alpha-skill row"

test_case "discovery emits a scan_discovered audit row for the skill"
assert_eq "1" "$(audit_count 'alpha-skill')" "alpha-skill audit count"

# ---------------------------------------------------------------------------
# Case 2 — re-run is idempotent: no duplicate row, no second audit row.
# ---------------------------------------------------------------------------
run_scan "$NOCLAUDE_BIN" >/dev/null

test_case "re-scan inserts no duplicate cheatcodes row"
assert_eq "1" "$(cc_count alpha-skill skill)" "alpha-skill row count after re-scan"

test_case "re-scan emits no second audit row"
assert_eq "1" "$(audit_count 'alpha-skill')" "alpha-skill audit count after re-scan"

# ---------------------------------------------------------------------------
# Case 3 — an already-tracked skill is left untouched (no dup, no audit).
# ---------------------------------------------------------------------------
seed_db
mk_skill "tracked-skill"
sqlite3 "$DB" "INSERT INTO cheatcodes (name, kind, origin, source_url, file_path, status, installed_at)
  VALUES ('tracked-skill','skill','builtin',NULL,'skills/tracked-skill/SKILL.md','active','x');"
run_scan "$NOCLAUDE_BIN" >/dev/null

test_case "already-tracked skill not duplicated"
assert_eq "1" "$(cc_count tracked-skill skill)" "tracked-skill row count"

test_case "already-tracked row left untouched (origin/status unchanged)"
assert_eq "builtin|active" "$(sqlite3 "$DB" "SELECT origin||'|'||status FROM cheatcodes WHERE name='tracked-skill';")" "tracked-skill unchanged"

test_case "already-tracked skill emits no audit row"
assert_eq "0" "$(audit_count 'tracked-skill')" "tracked-skill audit count"

# ---------------------------------------------------------------------------
# Case 4 — absent claude: skills still reconcile from disk; scan succeeds.
# ---------------------------------------------------------------------------
seed_db
mk_skill "beta-skill"
rm -f "$TMPDIR/home/.claude.json"
JSON=$(run_scan "$NOCLAUDE_BIN")

test_case "absent claude: scan still emits valid JSON"
assert_contains "$JSON" '"session_dir"' "scan json (no-claude)"

test_case "absent claude: local skill still registered from disk"
assert_eq "1" "$(cc_count beta-skill skill)" "beta-skill row count (no-claude)"

test_case "absent claude: local skill audited"
assert_eq "1" "$(audit_count 'beta-skill')" "beta-skill audit count (no-claude)"

# ---------------------------------------------------------------------------
# Case 5 — graceful skip when sqlite3/DB absent (no TRAJECTORY_DB_PATH match):
#          scan still succeeds and emits JSON.
# ---------------------------------------------------------------------------
test_case "missing DB: scan still emits valid JSON (graceful skip)"
JSON=$(env -i HOME="$TMPDIR/home" PATH="$NOCLAUDE_BIN" \
  TRAJECTORY_DB_PATH="$TMPDIR/nope/trajectory.db" \
  bash "$SCAN" "$WS" 2>/dev/null || true)
assert_contains "$JSON" '"session_dir"' "scan json (no-db)"

summarize
printf "PASS scan-resource-discovery\n"
