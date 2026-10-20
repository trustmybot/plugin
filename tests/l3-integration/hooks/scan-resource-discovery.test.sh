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
#   - a plugin bundling a same-named MCP server (fixture `claude plugin list
#     --json`) → both rows registered once with description/version, exactly
#     two scan_discovered rows; a re-scan adds nothing and writes no stderr
#   - a legacy 'mcp:<server>' row → rewritten to 'mcp:<plugin>/<server>', blank
#     plugin version filled, no audit; a new bundled server inherits the
#     parent plugin's trust_tier
#   - test flags (TMB_FORBID_LIVE_SYNC=1 / TMB_TEST_RUN_ID), each: no or a
#     missing TRAJECTORY_DB_PATH → exit 2 with the shared resolver's line (no
#     walk-up); CLAUDE_PROJECT_DIR naming the fixture project resolves; the
#     live `claude` is never spawned (plugins from TMB_SCAN_PLUGIN_JSON, else
#     unavailable); MCP servers come from TMB_SCAN_MCP_JSON, never
#     ~/.claude.json; absent → mcp_inventory unavailable. Unflagged,
#     ~/.claude.json is still read (mcp_inventory home).
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

TMPDIR=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-scan-resource-discovery.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

WS="$TMPDIR/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"

# The shipped schema, so the discovery writes meet the real (name, kind) key,
# CHECKs and foreign keys.
SCHEMA_SQL="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"
seed_db() {
  rm -f "$DB" "$DB-wal" "$DB-shm"
  sqlite3 "$DB" < "$SCHEMA_SQL" >/dev/null
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
discovered_total() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='scan_discovered';"; }
row_total() { sqlite3 "$DB" "SELECT (SELECT COUNT(*) FROM cheatcodes) || '/' || (SELECT COUNT(*) FROM audit);"; }

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

# ---------------------------------------------------------------------------
# Cases 6-7 — a stub `claude` answers `plugin list --json` from a fixture.
# ---------------------------------------------------------------------------
FIXTURES="$HERE/fixtures/scan-resource-discovery"
STUB_BIN="$TMPDIR/stub_bin"
mkdir -p "$STUB_BIN" "$TMPDIR/install/linear/.claude-plugin"
printf '{"name": "linear", "description": "Linear issue tracking"}' \
  > "$TMPDIR/install/linear/.claude-plugin/plugin.json"
cat > "$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "plugin list --json") cat "$STUB_PLUGIN_JSON" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/claude"

# run_stub_scan <plugin-list.json> — prints the scan's stderr only.
run_stub_scan() {
  { env -i \
    HOME="$TMPDIR/home" \
    PATH="$STUB_BIN:$NOCLAUDE_BIN" \
    TRAJECTORY_DB_PATH="$DB" \
    STUB_PLUGIN_JSON="$1" \
    bash "$SCAN" "$WS" >/dev/null || true; } 2>&1
}
cc_fields() { sqlite3 "$DB" "SELECT origin||'|'||source_url||'|'||status||'|'||description||'|'||COALESCE(version,'')||'|'||COALESCE(trust_tier,'') FROM cheatcodes WHERE name='$1' AND kind='$2';"; }

rm -rf "$WS/.claude/skills"
seed_db
sed "s#INSTALL_ROOT#$TMPDIR/install#" "$FIXTURES/plugin-list-bundled.json" > "$TMPDIR/bundled.json"
ERR=$(run_stub_scan "$TMPDIR/bundled.json")

test_case "first scan writes no stderr"
assert_eq "" "$ERR" "first scan stderr"

test_case "plugin row registered with manifest description + version"
assert_eq "marketplace|linear@claude-plugins-official|active|Linear issue tracking|1.2.3|" \
  "$(cc_fields linear plugin)" "linear plugin row"

test_case "same-named bundled server registered as mcp:<plugin>/<server>"
assert_eq "marketplace|mcp:linear/linear|active|linear MCP server bundled by linear|1.2.3|" \
  "$(cc_fields linear mcp)" "linear mcp row"

test_case "exactly two scan_discovered audit rows"
assert_eq "2" "$(discovered_total)" "scan_discovered count"

BEFORE=$(row_total)
ERR=$(run_stub_scan "$TMPDIR/bundled.json")

test_case "re-scan adds zero cheatcodes and zero audit rows"
assert_eq "$BEFORE" "$(row_total)" "cheatcodes/audit totals after re-scan"

test_case "re-scan writes no stderr"
assert_eq "" "$ERR" "re-scan stderr"

seed_db
sqlite3 "$DB" "
  INSERT INTO cheatcodes (name, kind, origin, source_url, trust_tier, scope, status, installed_at)
    VALUES ('tmb', 'plugin', 'marketplace', 'tmb@trustmybot-dev', 'reputable', 'project-local', 'active', 'x'),
           ('trajectory-server', 'mcp', 'marketplace', 'mcp:trajectory-server', NULL, 'project-local', 'active', 'x');
"
ERR=$(run_stub_scan "$FIXTURES/plugin-list-legacy.json")

test_case "legacy scan writes no stderr"
assert_eq "" "$ERR" "legacy scan stderr"

test_case "legacy mcp:<server> row rewritten to mcp:<plugin>/<server> with manifest fields"
assert_eq "marketplace|mcp:tmb/trajectory-server|active|trajectory-server MCP server bundled by tmb|1.0.2|" \
  "$(cc_fields trajectory-server mcp)" "trajectory-server row"

test_case "existing plugin row gains its blank description + NULL version, keeps trust_tier"
assert_eq "marketplace|tmb@trustmybot-dev|active|Trust me bro|1.0.2|reputable" \
  "$(cc_fields tmb plugin)" "tmb plugin row"

test_case "new bundled server inherits the parent plugin's trust_tier"
assert_eq "marketplace|mcp:tmb/helper|active|helper MCP server bundled by tmb|1.0.2|reputable" \
  "$(cc_fields helper mcp)" "helper mcp row"

test_case "only the new server is audited"
assert_eq "1" "$(discovered_total)" "scan_discovered count (legacy)"
assert_eq "1" "$(audit_count 'helper')" "helper audit count"

# ---------------------------------------------------------------------------
# Cases 8-11 — test flags pin the DB and fixture the ~/.claude.json fallback.
# ---------------------------------------------------------------------------
printf '{"mcpServers": {"home-server": {"command": "x"}}}' > "$TMPDIR/home/.claude.json"
printf '{"fixture-server": {"command": "node"}}' > "$TMPDIR/mcp-servers.json"
REQUIRED_MSG='scan: TRAJECTORY_DB_PATH is required under TMB_FORBID_LIVE_SYNC/TMB_TEST_RUN_ID (walk-up discovery disabled) unless CLAUDE_PROJECT_DIR names a project with a DB'

# run_flagged <env assignments...> — runs scan.sh from inside the workspace
# (whose .claude/tmb/trajectory.db a walk-up would find); prints
# "<exit>|<stderr>" on line 1 and stdout after it.
run_flagged() {
  local out err rc=0
  err=$(mktemp "$TMPDIR/err.XXXXXX")
  out=$(cd "$WS" && env -i HOME="$TMPDIR/home" PATH="$NOCLAUDE_BIN" "$@" bash "$SCAN" "$WS" 2>"$err") || rc=$?
  printf '%s|%s\n%s' "$rc" "$(cat "$err")" "$out"
}

# A spy `claude` that records every call; under a test flag it must stay unused.
SPY_BIN="$TMPDIR/spy_bin"
SPY_LOG="$TMPDIR/claude-calls"
mkdir -p "$SPY_BIN"
cat > "$SPY_BIN/claude" <<SPY
#!/usr/bin/env bash
echo "claude \$*" >> "$SPY_LOG"
exit 97
SPY
chmod +x "$SPY_BIN/claude"
sed "s#INSTALL_ROOT#$TMPDIR/install#" "$FIXTURES/plugin-list-bundled.json" > "$TMPDIR/flag-plugins.json"

for flag in TMB_FORBID_LIVE_SYNC=1 TMB_TEST_RUN_ID=tmb-l3-scan; do
  test_case "$flag, TRAJECTORY_DB_PATH unset: exit 2, no walk-up"
  OUT=$(run_flagged "$flag")
  assert_eq "2" "${OUT%%|*}" "unset path exit ($flag)"
  assert_contains "$OUT" "$REQUIRED_MSG" "unset path message ($flag)"
  assert_contains "$OUT" "tmb: trajectory DB unresolved: ${flag%%=*} is set" "shared resolver names the flag ($flag)"

  test_case "$flag, TRAJECTORY_DB_PATH missing: exit 2"
  OUT=$(run_flagged "$flag" TRAJECTORY_DB_PATH="$TMPDIR/nope/trajectory.db")
  assert_eq "2" "${OUT%%|*}" "missing path exit ($flag)"
  assert_contains "$OUT" "$REQUIRED_MSG" "missing path message ($flag)"

  seed_db
  test_case "$flag, CLAUDE_PROJECT_DIR names the fixture project: resolves"
  assert_eq "0|" "$(run_flagged "$flag" CLAUDE_PROJECT_DIR="$WS" | head -1)" "project dir pins the DB ($flag)"

  seed_db
  rm -f "$SPY_LOG"
  test_case "$flag, claude on PATH: never spawned, plugins unavailable"
  OUT=$(run_flagged "$flag" TRAJECTORY_DB_PATH="$DB" PATH="$SPY_BIN:$NOCLAUDE_BIN")
  assert_eq "unavailable" "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.plugin_inventory.status')" "plugin_inventory unavailable ($flag)"
  assert_contains "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.plugin_inventory.note')" "claude plugin list skipped" "plugin_inventory note ($flag)"
  assert_eq "no" "$([ -e "$SPY_LOG" ] && echo yes || echo no)" "claude not spawned ($flag)"

  seed_db
  test_case "$flag, TMB_SCAN_PLUGIN_JSON: plugins from the fixture, claude never spawned"
  OUT=$(run_flagged "$flag" TRAJECTORY_DB_PATH="$DB" PATH="$SPY_BIN:$NOCLAUDE_BIN" TMB_SCAN_PLUGIN_JSON="$TMPDIR/flag-plugins.json")
  assert_eq "fixture" "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.plugin_inventory.status')" "plugin_inventory fixture ($flag)"
  assert_eq "1" "$(cc_count linear plugin)" "fixture plugin registered ($flag)"
  assert_eq "no" "$([ -e "$SPY_LOG" ] && echo yes || echo no)" "claude not spawned with a fixture ($flag)"
done

seed_db
OUT=$(run_flagged TMB_TEST_RUN_ID=tmb-l3-scan TRAJECTORY_DB_PATH="$DB" TMB_SCAN_MCP_JSON="$TMPDIR/mcp-servers.json")
test_case "flagged with TMB_SCAN_MCP_JSON: fixture server registered, ~/.claude.json unread"
assert_eq "0|" "$(printf '%s' "$OUT" | head -1)" "flagged fixture exit"
assert_eq '{"status":"fixture","note":""}' "$(printf '%s' "$OUT" | tail -n +2 | jq -c '.mcp_inventory')" "mcp_inventory fixture"
assert_eq "external|mcp:fixture-server|active|" "$(cc_row fixture-server mcp)" "fixture-server row"
assert_eq "0" "$(cc_count home-server mcp)" "home-server not read"

seed_db
OUT=$(run_flagged TMB_FORBID_LIVE_SYNC=1 TRAJECTORY_DB_PATH="$DB")
test_case "flagged without TMB_SCAN_MCP_JSON: mcp_inventory unavailable, nothing registered"
assert_eq "unavailable" "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.mcp_inventory.status')" "mcp_inventory unavailable"
assert_contains "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.mcp_inventory.note')" "no readable TMB_SCAN_MCP_JSON" "mcp_inventory note"
assert_eq "0" "$(cc_count home-server mcp)" "home-server not read (no fixture)"

seed_db
OUT=$(run_flagged TRAJECTORY_DB_PATH="$DB")
test_case "unflagged: ~/.claude.json still read"
assert_eq "home" "$(printf '%s' "$OUT" | tail -n +2 | jq -r '.mcp_inventory.status')" "mcp_inventory home"
assert_eq "external|mcp:home-server|active|" "$(cc_row home-server mcp)" "home-server row"

summarize
printf "PASS scan-resource-discovery\n"
