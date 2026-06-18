#!/usr/bin/env bash
# L3: cheatcode health-check (#113).
# scripts/hooks/cheatcode-healthcheck.sh — SessionStart probe that reconciles
# each cheatcodes row's `status` against the runtime and emits a
# cheatcode_healthcheck audit row on every transition.
#
# Cases:
#   - a skill whose file is missing  → flips to broken (+ audit row)
#   - a present skill                → stays active, no transition, no audit
#   - TMB_DISABLE_CHEATCODE_HEALTHCHECK=1 → no-op
#   - absent `claude` CLI            → graceful skip (skills still reconcile;
#                                      mcp/plugin rows untouched)
#
# All state lives under a mktemp sandbox (per #810); TRAJECTORY_DB_PATH pins
# the DB so the real plugin DB is never touched. assert_not_in_plugin_repo
# guards against running with cwd inside the real plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/cheatcode-healthcheck.sh"

command -v sqlite3 >/dev/null 2>&1 || { printf "SKIP sqlite3 not found\n"; exit 0; }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

WS="$TMPDIR/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"

# Minimal schema: the tables the hook reads/writes. cheatcodes carries the
# columns the probe selects; audit mirrors the production shape; tasks carries
# prompt_bearing so tmb_db_schema_current accepts the DB.
seed_db() {
  rm -f "$DB"
  sqlite3 "$DB" "
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cheatcodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      file_path  TEXT,
      status     TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

# Run the hook with an isolated PATH (claude absent unless we add it),
# TRAJECTORY_DB_PATH pinned, empty hook payload on stdin.
run_hook() {
  printf '{}' | env -i \
    HOME="$TMPDIR/home" \
    PATH="$1" \
    TRAJECTORY_DB_PATH="$DB" \
    "${@:2}" \
    bash "$HOOK" 2>&1 || true
}

# A PATH that excludes any system `claude` but keeps the tools the hook needs.
NOCLAUDE_BIN="$TMPDIR/nocl_bin"
mkdir -p "$NOCLAUDE_BIN" "$TMPDIR/home"
for t in sqlite3 jq grep sed cat dirname date timeout env bash; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$NOCLAUDE_BIN/$t" 2>/dev/null || true
done
NOCLAUDE_PATH="$NOCLAUDE_BIN"

status_of() { sqlite3 "$DB" "SELECT status FROM cheatcodes WHERE name='$1';"; }
audit_count() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='cheatcode_healthcheck';"; }

# ---------------------------------------------------------------------------
# Case 1 — a skill whose file is missing flips to broken + emits an audit row.
# ---------------------------------------------------------------------------
seed_db
GONE="$TMPDIR/does-not-exist/SKILL.md"
sqlite3 "$DB" "INSERT INTO cheatcodes (name, kind, file_path, status) VALUES ('gone-skill', 'skill', '$GONE', 'active');"
run_hook "$NOCLAUDE_PATH" >/dev/null

test_case "missing-file skill flips active -> broken"
assert_eq "broken" "$(status_of gone-skill)" "gone-skill status"

test_case "transition emits a cheatcode_healthcheck audit row"
assert_eq "1" "$(audit_count)" "audit row count"

test_case "audit row records the old->new transition + name + kind"
ROW=$(sqlite3 "$DB" "SELECT content_json FROM audit WHERE event_type='cheatcode_healthcheck' LIMIT 1;")
assert_contains "$ROW" '"name":"gone-skill"' "audit name"
assert_contains "$ROW" '"kind":"skill"' "audit kind"
assert_contains "$ROW" '"from":"active"' "audit from"
assert_contains "$ROW" '"to":"broken"' "audit to"

# ---------------------------------------------------------------------------
# Case 2 — a present skill stays active: no transition, no audit row.
# ---------------------------------------------------------------------------
seed_db
PRESENT="$TMPDIR/present-skill.md"
: > "$PRESENT"
sqlite3 "$DB" "INSERT INTO cheatcodes (name, kind, file_path, status) VALUES ('present-skill', 'skill', '$PRESENT', 'active');"
run_hook "$NOCLAUDE_PATH" >/dev/null

test_case "present-file skill stays active (no-op)"
assert_eq "active" "$(status_of present-skill)" "present-skill status"

test_case "no-op leaves no cheatcode_healthcheck audit row"
assert_eq "0" "$(audit_count)" "audit row count after no-op"

# ---------------------------------------------------------------------------
# Case 3 — TMB_DISABLE_CHEATCODE_HEALTHCHECK=1 is a no-op even when the file
#          is missing (status would otherwise flip).
# ---------------------------------------------------------------------------
seed_db
sqlite3 "$DB" "INSERT INTO cheatcodes (name, kind, file_path, status) VALUES ('gone-skill', 'skill', '$GONE', 'active');"
run_hook "$NOCLAUDE_PATH" TMB_DISABLE_CHEATCODE_HEALTHCHECK=1 >/dev/null

test_case "disable env leaves a flip-worthy row untouched"
assert_eq "active" "$(status_of gone-skill)" "disabled status unchanged"

test_case "disable env writes no audit row"
assert_eq "0" "$(audit_count)" "disabled audit count"

# ---------------------------------------------------------------------------
# Case 4 — absent `claude` CLI: mcp/plugin rows are left untouched (no flip on
#          absent runtime evidence); skill rows still reconcile.
# ---------------------------------------------------------------------------
seed_db
sqlite3 "$DB" "
  INSERT INTO cheatcodes (name, kind, file_path, status) VALUES
    ('some-mcp',    'mcp',    NULL, 'active'),
    ('some-plugin', 'plugin', NULL, 'installed'),
    ('gone-skill',  'skill', '$GONE', 'active');
"
# HOME has no ~/.claude.json → no mcpServers fallback either.
rm -f "$TMPDIR/home/.claude.json"
run_hook "$NOCLAUDE_PATH" >/dev/null

test_case "absent claude: mcp row untouched (no evidence)"
assert_eq "active" "$(status_of some-mcp)" "some-mcp status"

test_case "absent claude: plugin row untouched (no evidence)"
assert_eq "installed" "$(status_of some-plugin)" "some-plugin status"

test_case "absent claude: skill row still reconciles to broken"
assert_eq "broken" "$(status_of gone-skill)" "gone-skill status (no-claude)"

test_case "absent claude: only the skill transition is audited"
assert_eq "1" "$(audit_count)" "audit count under no-claude"

summarize
printf "PASS cheatcode-healthcheck\n"
