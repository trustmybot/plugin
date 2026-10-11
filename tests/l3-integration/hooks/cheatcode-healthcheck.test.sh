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
#   - plugin-bundled server (mcp:<plugin>/<server>) → active when its plugin
#     is enabled and bundles it; broken when the plugin is disabled
#   - exact names: `tmb` never matches `tmb-x` (plugin and mcp rows)
#   - unparseable `claude plugin list --json` → plugin/bundled rows untouched
#
# All state lives under a mktemp sandbox (per #810); TRAJECTORY_DB_PATH pins
# the DB so the real plugin DB is never touched. assert_not_in_plugin_repo
# guards against running with cwd inside the real plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/cheatcode-healthcheck.sh"

command -v sqlite3 >/dev/null 2>&1 || { printf "FAIL sqlite3 not found — required dependency for this security-gate test\n"; exit 1; }

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
      source_url TEXT,
      file_path  TEXT,
      status     TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE issues (id INTEGER PRIMARY KEY, repo TEXT);
    CREATE TABLE audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id     INTEGER NOT NULL DEFAULT -1,
      branch_id    TEXT,
      from_node    TEXT NOT NULL DEFAULT 'bro',
      event_type   TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      repo TEXT,
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

# ---------------------------------------------------------------------------
# Cases 5-8 — a stub `claude` answers `mcp list` and `plugin list --json`
#             from the files named by STUB_MCP_LIST / STUB_PLUGIN_JSON.
# ---------------------------------------------------------------------------
STUB_BIN="$TMPDIR/stub_bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "mcp list") cat "$STUB_MCP_LIST" ;;
  "plugin list --json") cat "$STUB_PLUGIN_JSON" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/claude"
STUB_PATH="$STUB_BIN:$NOCLAUDE_BIN"

MCP_LIST_FILE="$TMPDIR/mcp-list.txt"
PLUGIN_JSON_FILE="$TMPDIR/plugin-list.json"
cat > "$MCP_LIST_FILE" <<'EOF_MCP'
Checking MCP server health…

tmb-x: node server.js - ✔ Connected
plugin:linear:linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected
EOF_MCP
cat > "$PLUGIN_JSON_FILE" <<'EOF_PLUGINS'
[
  {"id": "tmb@trustmybot-dev", "version": "1.0.2", "enabled": true,
   "mcpServers": {"trajectory-server": {"command": "node"}}},
  {"id": "linear@claude-plugins-official", "version": "abc", "enabled": false,
   "mcpServers": {"linear": {"type": "http"}}},
  {"id": "tmb-x@somewhere", "version": "0.1.0", "enabled": true}
]
EOF_PLUGINS

run_stub() {
  run_hook "$STUB_PATH" STUB_MCP_LIST="$MCP_LIST_FILE" STUB_PLUGIN_JSON="$1"
}
status_of_kind() { sqlite3 "$DB" "SELECT status FROM cheatcodes WHERE name='$1' AND kind='$2';"; }

seed_db
sqlite3 "$DB" "
  INSERT INTO cheatcodes (name, kind, source_url, status) VALUES
    ('trajectory-server', 'mcp',    'mcp:tmb/trajectory-server', 'broken'),
    ('linear',            'mcp',    'mcp:linear/linear',         'active'),
    ('ghost',             'mcp',    'mcp:tmb/ghost',             'active'),
    ('tmb',               'plugin', 'tmb@trustmybot-dev',        'installed'),
    ('linear',            'plugin', 'linear@claude-plugins-official', 'active'),
    ('tmb-x',             'plugin', 'tmb-x@somewhere',           'installed'),
    ('tmb',               'mcp',    'mcp:tmb',                   'active'),
    ('tmb-x',             'mcp',    'mcp:tmb-x',                 'installed');
"
run_stub "$PLUGIN_JSON_FILE" >/dev/null

test_case "bundled server of an enabled plugin -> active"
assert_eq "active" "$(status_of_kind trajectory-server mcp)" "trajectory-server status"

test_case "bundled server of a disabled plugin -> broken"
assert_eq "broken" "$(status_of_kind linear mcp)" "linear mcp status"

test_case "bundled server its plugin does not declare -> broken"
assert_eq "broken" "$(status_of_kind ghost mcp)" "ghost mcp status"

test_case "enabled plugin -> active; disabled plugin -> broken"
assert_eq "active" "$(status_of_kind tmb plugin)" "tmb plugin status"
assert_eq "broken" "$(status_of_kind linear plugin)" "linear plugin status"
assert_eq "active" "$(status_of_kind tmb-x plugin)" "tmb-x plugin status"

test_case "mcp names match exactly: tmb-x in mcp list does not make tmb active"
assert_eq "broken" "$(status_of_kind tmb mcp)" "tmb mcp status"
assert_eq "active" "$(status_of_kind tmb-x mcp)" "tmb-x mcp status"

seed_db
sqlite3 "$DB" "INSERT INTO cheatcodes (name, kind, source_url, status) VALUES ('tmb', 'plugin', 'tmb@trustmybot-dev', 'installed');"
printf '[{"id": "tmb-x@somewhere", "enabled": true}]' > "$TMPDIR/only-tmb-x.json"
run_stub "$TMPDIR/only-tmb-x.json" >/dev/null

test_case "plugin names match exactly: an enabled tmb-x does not make tmb active"
assert_eq "broken" "$(status_of_kind tmb plugin)" "tmb plugin status vs tmb-x"

seed_db
sqlite3 "$DB" "
  INSERT INTO cheatcodes (name, kind, source_url, status) VALUES
    ('trajectory-server', 'mcp',    'mcp:tmb/trajectory-server', 'broken'),
    ('tmb',               'plugin', 'tmb@trustmybot-dev',        'installed');
"
printf 'not json' > "$TMPDIR/garbage.json"
run_stub "$TMPDIR/garbage.json" >/dev/null

test_case "unparseable plugin list: bundled server and plugin rows untouched"
assert_eq "broken" "$(status_of_kind trajectory-server mcp)" "trajectory-server untouched"
assert_eq "installed" "$(status_of_kind tmb plugin)" "tmb plugin untouched"
assert_eq "0" "$(audit_count)" "no transition audited without evidence"

summarize
printf "PASS cheatcode-healthcheck\n"
