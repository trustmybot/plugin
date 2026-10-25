#!/usr/bin/env bash
# L3: deterministic health-check (#144).
# scripts/health.sh — a standalone bash diagnostic (deliberately NOT an MCP
# tool, so it can diagnose a DOWN server). It runs 8 checks against the
# trajectory DB, the server log, and the plugin cache filesystem, printing
# exactly one PASS/FAIL line per check and the ONE correct remediation under
# every FAIL.
#
# This test drives health.sh against self-contained fixtures (a temp DB seeded
# with plugin_meta/tasks/repos/plugin_config, a fake mcp-server.log, a fake
# cache tree) and asserts the right PASS/FAIL + remediation per scenario across
# all 8 checks, plus the duplicate-plugin and legacy-user-hooks warnings.
# The world-model check covers:
#   - tables with rows   → PASS
#   - tables empty       → WARN naming /scan (not a FAIL)
#   - tables missing     → FAIL, full restart (the server migrates on start)
#   - a leftover graph file from the old store → INFO line, file kept
#   - the DB file's bytes and mtime unchanged after the run (read-only probe)
#
# LOAD-BEARING (#144, GH 1730): every remediation names a scoped `claude
# plugin …` command and/or a FULL Claude Code quit + relaunch, and none names an
# in-session command (`/plugin`, `/reload-plugins`, `/mcp`): a plugin change
# applies only after a full restart, which also respawns the long-lived MCP
# server. Each failing scenario asserts that with assert_no_in_session_cmd.
#
# All state lives under a mktemp sandbox; the script reads only via env
# overrides (TRAJECTORY_DB_PATH + TMB_HEALTH_*), so the real plugin DB / cache /
# log are never touched. assert_not_in_plugin_repo guards against running with
# cwd inside the real plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HEALTH="$PLUGIN_ROOT/scripts/health.sh"

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf "SKIP: sqlite3 not available\n"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  printf "SKIP: jq not available\n"
  exit 0
fi

SANDBOX=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-health.XXXXXX")
cd "$SANDBOX"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

cleanup() {
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

IN_SESSION_CMD='(^|[ `"'"'"'(])/(plugin|reload-plugins|mcp)([ `"'"'"'),.;:]|$)'
assert_no_in_session_cmd() {
  local found
  found=$(printf '%s\n' "$1" | grep -E "$IN_SESSION_CMD" || true)
  assert_eq "" "$found" "$2"
}

# The script's server-reachable probe shells out to pgrep. Shadow it via PATH
# with a stub so the developer's real trajectory-server processes never leak in.
# (Belt-and-suspenders: scenarios also pin TMB_HEALTH_PGREP_COUNT directly.)
STUB_DIR="$SANDBOX/bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$STUB_DIR/pgrep"
export PATH="$STUB_DIR:$PATH"

# Per-scenario fixture builder. Each scenario gets its own workspace tree so
# nothing bleeds across cases:
#   <root>/.claude/tmb/trajectory.db        — seeded DB (TRAJECTORY_DB_PATH)
#   <root>/cache/...                        — fake installed plugin cache
#   <root>/server.log                       — fake mcp-server.log
# Args: <scenario-slug>
# Prints the workspace root on stdout; the caller derives sub-paths.
new_fixture() {
  local slug="$1"
  local root="$SANDBOX/$slug"
  mkdir -p "$root/.claude/tmb"
  printf '%s' "$root"
}

# seed_db <db> <plugin_version> <schema_version> [<labels_json>]
# Creates the minimal tables health.sh reads. A `prompt_bearing` column is added
# to tasks so the lib's schema-current probe treats the DB as adoptable (only
# relevant if a scenario lets the script walk-up; we always pin TRAJECTORY_DB_PATH).
seed_db() {
  local db="$1" pv="$2" sv="$3" labels="${4:-}"
  sqlite3 "$db" <<EOF
CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, plugin_version TEXT, schema_version INTEGER);
INSERT INTO plugin_meta (id, plugin_version, schema_version) VALUES (1, '${pv}', ${sv});
CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin');
CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, branch_id TEXT, commit_sha TEXT, prompt_bearing INTEGER DEFAULT 0);
CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);
CREATE TABLE wm_directories (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, parent_path TEXT, summary TEXT);
CREATE TABLE wm_files (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, dir TEXT, purpose TEXT);
EOF
  if [ -n "$labels" ]; then
    sqlite3 "$db" "INSERT INTO plugin_config (key, value_json) VALUES ('issue_classification_labels', '${labels}');"
  fi
}

# add_task <db> <status> <branch_id>
add_task() {
  sqlite3 "$1" "INSERT INTO tasks (status, branch_id) VALUES ('$2', '$3');"
}

# seed_world_model <db> — a scanned world model: two directories, one file.
seed_world_model() {
  sqlite3 "$1" <<'EOF'
INSERT INTO wm_directories (repo, path, parent_path, summary) VALUES ('plugin', '', NULL, 'root'), ('plugin', 'src', '', 'sources');
INSERT INTO wm_files (repo, path, dir, purpose) VALUES ('plugin', 'src/main.ts', 'src', 'entry point');
EOF
}

# make_cache <cache_dir> <target_schema>
# Builds a fake installed-cache tree with a db.ts carrying TARGET_SCHEMA_VERSION.
make_cache() {
  local cache="$1" target="$2"
  mkdir -p "$cache/mcp/trajectory-server/src"
  printf 'const TARGET_SCHEMA_VERSION = %s;\n' "$target" > "$cache/mcp/trajectory-server/src/db.ts"
}

# db_state <db> — bytes checksum + mtime of the DB file, plus any sidecar files.
db_state() {
  local db="$1" m f sidecars=""
  m=$(stat -c %Y "$db" 2>/dev/null || stat -f %m "$db")
  for f in "$db"-*; do
    [ -e "$f" ] && sidecars="$sidecars $f"
  done
  printf '%s %s%s\n' "$(cksum < "$db")" "$m" "$sidecars"
}

# run_health — invoke health.sh with a clean env. Every input is an explicit
# override so resolution is deterministic and never touches the real install.
# Globals consumed (set per scenario before calling):
#   F_DB F_LOG F_CACHE F_INTENDED F_PGREP F_PLUGINROOT
run_health_rc() {
  env -i \
    PATH="$PATH" \
    HOME="$SANDBOX/home" \
    TRAJECTORY_DB_PATH="${F_DB:-}" \
    TMB_HEALTH_SERVER_LOG="${F_LOG:-}" \
    TMB_HEALTH_CACHE_DIR="${F_CACHE:-}" \
    TMB_HEALTH_INTENDED_VERSION="${F_INTENDED:-}" \
    TMB_HEALTH_PGREP_COUNT="${F_PGREP:-}" \
    CLAUDE_PLUGIN_ROOT="${F_PLUGINROOT:-}" \
    bash "$HEALTH" 2>&1
}
run_health() { run_health_rc || true; }

# Reset scenario globals to "healthy" defaults; each test overrides what it
# exercises. Healthy baseline: server alive, versions match, schema matches,
# world model scanned, labels set, no stale state, no drift.
TARGET_SCHEMA=24
HEALTHY_VERSION="0.10.0-delta"

reset_scenario() {
  local slug="$1"
  local root
  root=$(new_fixture "$slug")
  ROOT="$root"
  F_DB="$root/.claude/tmb/trajectory.db"
  F_LOG="$root/server.log"
  F_CACHE="$root/cache"
  F_INTENDED="$HEALTHY_VERSION"
  F_PGREP="1"
  F_PLUGINROOT=""
  seed_db "$F_DB" "$HEALTHY_VERSION" "$TARGET_SCHEMA" '["Bug","Feature","Docs"]'
  seed_world_model "$F_DB"
  make_cache "$F_CACHE" "$TARGET_SCHEMA"
  : > "$F_LOG"
}

# Extract the remediation block (the `-> ...` lines) that follow a given FAIL
# line, up to the next blank line / PASS / FAIL / check boundary. Used to assert
# remediation text is scoped to the right failure.
remediation_after() {
  local output="$1" needle="$2"
  printf '%s\n' "$output" | awk -v n="$needle" '
    index($0, n) { grab=1; next }
    grab && /^[[:space:]]*-> / { print; next }
    grab && /^(PASS|FAIL|== )/ { grab=0 }
    grab && /^[[:space:]]*$/ { grab=0 }
  '
}

# ============================================================================
# Baseline — all healthy → every check PASS, exit 0
# ============================================================================
test_case "baseline: all checks PASS"
reset_scenario healthy
out=$(run_health)
assert_contains "$out" "PASS  server-reachable" "server PASS"
assert_contains "$out" "PASS  cache-version" "cache-version PASS"
assert_contains "$out" "PASS  schema-version" "schema-version PASS"
assert_contains "$out" "PASS  world-model" "world-model PASS"
assert_contains "$out" "PASS  label-config" "label-config PASS"
assert_contains "$out" "PASS  stale-state" "stale-state PASS"
assert_contains "$out" "PASS  hook-cache-drift" "hook-cache-drift PASS"

test_case "baseline: no FAIL lines, all checks passed footer"
assert_not_contains "$out" "FAIL  " "no FAIL lines in healthy run"
assert_contains "$out" "== all checks passed ==" "healthy footer"

# ============================================================================
# Check 1 — server-reachable: no process → FAIL, full restart, NOT /reload
# ============================================================================
test_case "check1 server-reachable: zero processes → FAIL"
reset_scenario server-down
F_PGREP="0"
out=$(run_health)
assert_contains "$out" "FAIL  server-reachable: NO trajectory-server process found" "server-down FAIL line"

test_case "check1 server-reachable: remediation says full quit + relaunch"
rem=$(remediation_after "$out" "FAIL  server-reachable")
assert_contains "$rem" "Fully quit Claude Code" "server-down restart remediation"

test_case "check1 server-reachable: LOAD-BEARING — no in-session command"
assert_no_in_session_cmd "$rem" "server-down remediation names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# Check 2 — cache-version: DB booted older than installed → FAIL, restart
# ============================================================================
test_case "check2 cache-version: DB version != installed → FAIL"
reset_scenario cache-stale
# DB booted on an older version than what is now installed.
sqlite3 "$F_DB" "UPDATE plugin_meta SET plugin_version='0.10.0-gamma' WHERE id=1;"
F_INTENDED="0.10.0-delta"
out=$(run_health)
assert_contains "$out" "FAIL  cache-version: server booted 0.10.0-gamma but 0.10.0-delta is installed" "cache-version FAIL line"

test_case "check2 cache-version: remediation = scoped claude plugin update + full relaunch"
rem=$(remediation_after "$out" "FAIL  cache-version")
assert_contains "$rem" "claude plugin update tmb@<marketplace> --scope project (stable) or --scope local (rc/dev)" "no installed entry: generic scoped update"
assert_contains "$rem" "quit + relaunch" "cache-version restart remediation"
assert_contains "$rem" "INSTALL.md#recommended-scope-project-or-local" "cache-version links the scope rule"

test_case "check2 cache-version: update uses the installed entry's own scope, else the channel default"
scoped_rem() {
  printf '{"plugins":{"%s":[{%s"installPath":"/c/x","version":"0.10.0-delta"}]}}' "$1" "$2" > "$ROOT/installed.json"
  out=$(env -i PATH="$PATH" HOME="$SANDBOX/home" \
    TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
    TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
    TMB_HEALTH_PGREP_COUNT="1" TMB_HEALTH_INSTALLED_JSON="$ROOT/installed.json" \
    bash "$HEALTH" 2>&1 || true)
  remediation_after "$out" "FAIL  cache-version"
}
assert_contains "$(scoped_rem tmb@trustmybot '"scope":"local",')" "claude plugin update tmb@trustmybot --scope local" "recorded local scope wins"
assert_contains "$(scoped_rem tmb@trustmybot '"scope":"user",')" "claude plugin update tmb@trustmybot --scope project" "user scope falls back to stable default"
assert_contains "$(scoped_rem tmb@trustmybot-dev '')" "claude plugin update tmb@trustmybot-dev --scope local" "no scope falls back to dev default"

test_case "check2 cache-version: LOAD-BEARING — only a full restart picks up the server"
assert_contains "$rem" "Only a full restart picks up the new server" "cache-version names the full restart"
assert_no_in_session_cmd "$rem" "cache-version remediation names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# Check 3 — schema-version: DB schema behind installed target → FAIL, restart
# ============================================================================
test_case "check3 schema-version: DB schema < installed target → FAIL"
reset_scenario schema-stale
sqlite3 "$F_DB" "UPDATE plugin_meta SET schema_version=23 WHERE id=1;"
make_cache "$F_CACHE" 24
out=$(run_health)
assert_contains "$out" "FAIL  schema-version: DB at v23 but installed server targets v24" "schema-version FAIL line"

test_case "check3 schema-version: remediation = full quit + relaunch (migration on server start)"
rem=$(remediation_after "$out" "FAIL  schema-version")
assert_contains "$rem" "Fully quit + relaunch Claude Code" "schema restart remediation"
assert_contains "$rem" "migration runs on the next SERVER start" "schema migration framing"

test_case "check3 schema-version: LOAD-BEARING — no in-session command"
assert_no_in_session_cmd "$rem" "schema remediation names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# Check 4 — world-model: wm_ tables with rows → PASS naming the counts
# ============================================================================
test_case "check4a world-model: scanned tables → PASS with counts"
reset_scenario wm-scanned
out=$(run_health)
assert_contains "$out" "PASS  world-model: 2 directories, 1 files" "world-model PASS line"
assert_not_contains "$out" "WARN  world-model" "no empty warning"
assert_not_contains "$out" "INFO  world-model" "no leftover line without a leftover file"

# ============================================================================
# Check 4 — world-model: tables empty → WARN naming /scan, not a FAIL
# ============================================================================
test_case "check4b world-model: empty tables → WARN pointing at /scan"
reset_scenario wm-empty
sqlite3 "$F_DB" "DELETE FROM wm_files; DELETE FROM wm_directories;"
set +e
out=$(run_health_rc)
rc=$?
set -e
assert_contains "$out" "WARN  world-model: empty" "empty WARN line"
rem=$(remediation_after "$out" "WARN  world-model")
assert_contains "$rem" "run /scan" "empty remediation prescribes /scan"
assert_not_contains "$out" "FAIL  world-model" "an empty world model is not a FAIL"
assert_contains "$out" "== all checks passed ==" "a warning is not a failed check"
assert_exit_code 0 "$rc" "exit code unchanged"

# ============================================================================
# Check 4 — world-model: tables missing → FAIL, full restart, NOT /reload
# ============================================================================
test_case "check4c world-model: tables missing → FAIL"
reset_scenario wm-missing
sqlite3 "$F_DB" "DROP TABLE wm_files; DROP TABLE wm_directories;"
out=$(run_health)
assert_contains "$out" "FAIL  world-model: wm_directories / wm_files missing" "missing-tables FAIL line"
rem=$(remediation_after "$out" "FAIL  world-model")
assert_contains "$rem" "quit + relaunch" "missing-tables remediation restarts"
assert_contains "$rem" "run /scan" "missing-tables remediation then scans"
assert_no_in_session_cmd "$rem" "missing-tables remediation names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# Check 4 — a leftover graph file from the old store → INFO, never deleted
# ============================================================================
test_case "check4d world-model: leftover world-model.kuzu beside trajectory.db → INFO line, file kept"
reset_scenario wm-leftover
legacy="$ROOT/.claude/tmb/world-model.kuzu"
mkdir -p "$legacy"
: > "$legacy/data"
: > "$legacy.wal"
out=$(run_health)
assert_contains "$out" "INFO  world-model: $legacy is an unused leftover" "leftover INFO line names the file"
assert_contains "$out" "you may delete it" "leftover INFO line says the user may delete it"
assert_contains "$out" "PASS  world-model: 2 directories, 1 files" "leftover does not change the verdict"
assert_contains "$out" "== all checks passed ==" "an info line is not a failed check"
[ -f "$legacy/data" ] && [ -f "$legacy.wal" ] && kept=yes || kept=no
assert_eq "yes" "$kept" "leftover files are never deleted"

test_case "check4d world-model: a custom DB name looks for <db>.world-model.kuzu"
custom_db="$ROOT/.claude/tmb/custom.db"
cp "$F_DB" "$custom_db"
F_DB="$custom_db"
out=$(run_health)
assert_not_contains "$out" "INFO  world-model" "the standard-name leftover belongs to trajectory.db, not custom.db"
: > "$custom_db.world-model.kuzu"
out=$(run_health)
assert_contains "$out" "INFO  world-model: $custom_db.world-model.kuzu is an unused leftover" "custom DB leftover INFO line"

# ============================================================================
# Check 4 — the probe never writes the DB
# ============================================================================
test_case "check4e world-model: DB bytes and mtime unchanged after the check"
reset_scenario wm-readonly
touch -t 200001010000 "$F_DB"
BEFORE=$(db_state "$F_DB")
out=$(run_health)
assert_contains "$out" "PASS  world-model" "world-model PASS on the probed DB"
assert_eq "$BEFORE" "$(db_state "$F_DB")" "rollback-journal DB: bytes, mtime and sidecars unchanged"

test_case "check4e world-model: a WAL DB with no -shm stays untouched"
reset_scenario wm-readonly-wal
sqlite3 "$F_DB" "PRAGMA journal_mode=WAL;" >/dev/null
rm -f "$F_DB-wal" "$F_DB-shm"
touch -t 200001010000 "$F_DB"
BEFORE=$(db_state "$F_DB")
out=$(run_health)
assert_contains "$out" "PASS  world-model: 2 directories, 1 files" "world-model reads a cold WAL DB"
assert_eq "$BEFORE" "$(db_state "$F_DB")" "WAL DB: bytes, mtime and sidecars unchanged"

# ============================================================================
# Check 4 — :memory: has nothing on disk to probe
# ============================================================================
test_case "check4f world-model: :memory: → PASS without a probe"
reset_scenario wm-memory
F_DB=":memory:"
out=$(run_health)
assert_contains "$out" "db:        :memory:" ":memory: override is preserved"
assert_contains "$out" "PASS  world-model: in-memory trajectory DB" ":memory: world model PASS"
assert_not_contains "$out" "INFO  world-model" ":memory: has no leftover graph file"

# ============================================================================
# Server log default — beside the trajectory DB, never under $HOME
# ============================================================================
test_case "server-log default: resolves to <db-dir>/logs/mcp-server.log"
reset_scenario log-default
F_LOG=""
out=$(run_health)
assert_contains "$out" "server-log:$ROOT/.claude/tmb/logs/mcp-server.log" "default server log sits beside the DB"
assert_not_contains "$out" "$SANDBOX/home" "default server log is not under HOME"

# ============================================================================
# Check 5 — label-config: unset issue_classification_labels → FAIL
# ============================================================================
test_case "check5 label-config: empty labels → FAIL"
reset_scenario labels-unset
sqlite3 "$F_DB" "DELETE FROM plugin_config WHERE key='issue_classification_labels';"
out=$(run_health)
assert_contains "$out" "FAIL  label-config: issue_classification_labels is unset/empty" "label-config FAIL line"

test_case "check5 label-config: remediation points to /onboard or config_set"
rem=$(remediation_after "$out" "FAIL  label-config")
assert_contains "$rem" "/onboard" "label remediation mentions /onboard"
assert_contains "$rem" "config_set" "label remediation mentions config_set"

# ============================================================================
# Check 6 — stale-state: pending/running task + orphan worktree → FAIL
# ============================================================================
test_case "check6 stale-state: pending task + orphan worktree → FAIL"
reset_scenario stale
add_task "$F_DB" "pending" "feat/some-thing"
mkdir -p "$ROOT/.claude/worktrees/some-thing"
out=$(run_health)
assert_contains "$out" "FAIL  stale-state: orphaned worktrees and/or pending|running tasks present" "stale-state FAIL line"

test_case "check6 stale-state: remediation lists the pending task and the worktree"
rem=$(remediation_after "$out" "FAIL  stale-state")
assert_contains "$out" "[pending]" "stale remediation names the pending task status"
assert_contains "$out" "feat/some-thing" "stale remediation names the branch"
assert_contains "$out" ".claude/worktrees/some-thing" "stale remediation names the worktree"

# ============================================================================
# Check 7 — hook-cache-drift: dev checkout version != cache → FAIL, scoped
# update then a full restart (definition drift needs one too).
# ============================================================================
test_case "check7 hook-cache-drift: dev checkout != cache → FAIL"
reset_scenario hook-drift
# CLAUDE_PLUGIN_ROOT is a dev checkout at a different version than the cache.
DEVROOT="$ROOT/devcheckout"
mkdir -p "$DEVROOT/.claude-plugin"
printf '{"name":"tmb","version":"0.10.0-epsilon"}\n' > "$DEVROOT/.claude-plugin/plugin.json"
F_PLUGINROOT="$DEVROOT"
F_INTENDED="0.10.0-delta"
out=$(run_health)
assert_contains "$out" "FAIL  hook-cache-drift: dev checkout is 0.10.0-epsilon but the cache runs 0.10.0-delta" "hook-drift FAIL line"

test_case "check7 hook-cache-drift: remediation = scoped claude plugin update + full relaunch"
rem=$(remediation_after "$out" "FAIL  hook-cache-drift")
assert_contains "$rem" "claude plugin update tmb@<marketplace> --scope project (stable) or --scope local (rc/dev)" "drift remediation names the scoped update"
assert_contains "$rem" "fully quit + relaunch Claude Code" "drift remediation prescribes a full restart"
assert_no_in_session_cmd "$rem" "drift remediation names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# Cross-cutting LOAD-BEARING sweep (#144, GH 1730): the whole output of every
# failing scenario names no in-session command.
# ============================================================================
test_case "sweep: server-down output names no in-session command"
reset_scenario sweep-server
F_PGREP="0"
out=$(run_health)
assert_no_in_session_cmd "$out" "server-down output names no /plugin, /reload-plugins or /mcp"

test_case "sweep: schema-stale output names no in-session command"
reset_scenario sweep-schema
sqlite3 "$F_DB" "UPDATE plugin_meta SET schema_version=23 WHERE id=1;"
make_cache "$F_CACHE" 24
out=$(run_health)
assert_no_in_session_cmd "$out" "schema-stale output names no /plugin, /reload-plugins or /mcp"

test_case "sweep: world-model tables missing output names no in-session command"
reset_scenario sweep-world-model
sqlite3 "$F_DB" "DROP TABLE wm_files; DROP TABLE wm_directories;"
out=$(run_health)
assert_no_in_session_cmd "$out" "world-model output names no /plugin, /reload-plugins or /mcp"

# ============================================================================
# duplicate-plugin warning — two enabled copies: WARN naming both, exit 0
# ============================================================================
test_case "duplicate-plugin: two enabled copies warn, naming both; exit code unchanged"
reset_scenario duplicate-plugin
mkdir -p "$ROOT/.claude"
printf '{"plugins":{"tmb@trustmybot-dev":[{"scope":"local","projectPath":"%s","installPath":"/c/dev","version":"1.0.3"}],"tmb@trustmybot-rc":[{"scope":"local","projectPath":"%s","installPath":"/c/rc","version":"1.0.2-rc.3"}]}}' "$ROOT" "$ROOT" > "$ROOT/installed.json"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$ROOT/.claude/settings.local.json"
dup_health() {
  env -i PATH="$PATH" HOME="$SANDBOX/home" \
    TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
    TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
    TMB_HEALTH_PGREP_COUNT="1" TMB_HEALTH_INSTALLED_JSON="$ROOT/installed.json" \
    CLAUDE_PROJECT_DIR="$ROOT" bash "$HEALTH" 2>&1
}
set +e
out=$(dup_health)
rc=$?
set -e
assert_contains "$out" "WARN  duplicate-plugin: 2 enabled tmb copies" "WARN line"
assert_contains "$out" "trustmybot-dev@1.0.3, trustmybot-rc@1.0.2-rc.3" "names both copies"
assert_contains "$out" "claude plugin disable tmb@trustmybot-dev --scope local; claude plugin disable tmb@trustmybot-rc --scope local" "remedy names a scoped disable per copy"
assert_contains "$out" "Then fully quit + relaunch Claude Code." "remedy restarts"
assert_no_in_session_cmd "$out" "duplicate-plugin output names no /plugin, /reload-plugins or /mcp"
assert_contains "$out" "== all checks passed ==" "a warning is not a failed check"
assert_exit_code 0 "$rc" "exit code unchanged"

test_case "duplicate-plugin: one enabled copy prints nothing"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}' > "$ROOT/.claude/settings.local.json"
out=$(dup_health || true)
assert_not_contains "$out" "WARN  duplicate-plugin" "no warning"

test_case "duplicate-plugin: no DB and no CLAUDE_PROJECT_DIR is reported, never guessed from the cwd"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$ROOT/.claude/settings.local.json"
out=$(cd "$ROOT" && env -i PATH="$PATH" HOME="$SANDBOX/home" TMB_TEST_RUN_ID=health-unresolved \
  TMB_HEALTH_SERVER_LOG="$F_LOG" TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
  TMB_HEALTH_PGREP_COUNT="1" TMB_HEALTH_INSTALLED_JSON="$ROOT/installed.json" \
  bash "$HEALTH" 2>&1 || true)
assert_contains "$out" "WARN  duplicate-plugin: skipped — no project resolves" "unresolved project reported"
assert_not_contains "$out" "enabled tmb copies for" "cwd not used as the project"

# ============================================================================
# legacy-user-hooks warning — pre-1.1.0 resolve-hook.sh and _tmb_managed
# entries in the user settings.json: WARN naming file, lines and hooks; files
# untouched; exit 0
# ============================================================================
test_case "legacy-user-hooks: resolve-hook.sh and _tmb_managed entries warn with lines, hooks and old projects; files unchanged"
reset_scenario legacy-user-hooks
mkdir -p "$ROOT/home/.claude" "$ROOT/old-project"
OLD_REAL=$(cd "$ROOT/old-project" && pwd -P)
cp "$HERE/hooks/fixtures/legacy-user-settings.json" "$ROOT/home/.claude/settings.json"
printf '{"plugins":{"tmb@trustmybot-dev":[{"scope":"local","projectPath":"%s","installPath":"/c/old","version":"1.0.2"},{"scope":"local","projectPath":"%s","installPath":"/c/new","version":"1.1.0"}]}}' \
  "$ROOT/old-project" "$ROOT" > "$ROOT/installed.json"
legacy_health() {
  env -i PATH="$PATH" HOME="$ROOT/home" \
    TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
    TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
    TMB_HEALTH_PGREP_COUNT="1" TMB_HEALTH_INSTALLED_JSON="$ROOT/installed.json" \
    CLAUDE_PROJECT_DIR="$ROOT" bash "$HEALTH" 2>&1
}
legacy_sums() { cksum "$ROOT/home/.claude/settings.json" "$ROOT/installed.json" 2>/dev/null; }
BEFORE=$(legacy_sums)
set +e
out=$(legacy_health)
rc=$?
set -e
assert_contains "$out" "WARN  legacy-user-hooks: $ROOT/home/.claude/settings.json holds 3 pre-1.1.0 TMB hook(s): line 10 git-guards, line 23 agent-spawn-dispatch, line 33 swe-scope-guard" "WARN line"
assert_eq "1" "$(printf '%s\n' "$out" | grep -c 'WARN  legacy-user-hooks')" "one warning"
assert_contains "$out" "Remove them by hand: docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks" "points to UPGRADE.md"
assert_contains "$out" "Projects on TMB < 1.1.0 lose them too: $OLD_REAL (1.0.2)" "names the old project only"
assert_contains "$out" "== all checks passed ==" "a warning is not a failed check"
assert_exit_code 0 "$rc" "exit code unchanged"
assert_eq "$BEFORE" "$(legacy_sums)" "settings.json and installed_plugins.json unchanged"
cmp "$HERE/hooks/fixtures/legacy-user-settings.json" "$ROOT/home/.claude/settings.json" >/dev/null && same=yes || same=no
assert_eq "yes" "$same" "settings.json byte-identical"

test_case "legacy-user-hooks: a _tmb_managed entry without resolve-hook.sh warns by line and --hook name"
printf '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"bash ~/.claude/tmb-hooks/dispatch.sh --hook bash-guard","_tmb_managed":true}]}]}}\n' > "$ROOT/home/.claude/settings.json"
out=$(legacy_health || true)
assert_contains "$out" "holds 1 pre-1.1.0 TMB hook(s): line 1 bash-guard" "WARN line"

test_case "legacy-user-hooks: clean or missing settings print nothing"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"},{"type":"command","command":"echo also-mine","_tmb_managed":false}]}]}}\n' > "$ROOT/home/.claude/settings.json"
BEFORE=$(legacy_sums)
out=$(legacy_health || true)
assert_not_contains "$out" "WARN  legacy-user-hooks" "clean settings: no warning"
assert_eq "$BEFORE" "$(legacy_sums)" "clean settings: files unchanged"
rm -f "$ROOT/home/.claude/settings.json"
out=$(legacy_health || true)
assert_not_contains "$out" "WARN  legacy-user-hooks" "missing settings: no warning"

# ============================================================================
# Check 8 — embeddings: the doctor's embeddings_not_degraded predicate
# ============================================================================
# add_audit <db> <event_type> <created_at-sql-expr>
add_audit() {
  sqlite3 "$1" <<EOF
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, event_type TEXT, from_node TEXT, content_json TEXT, created_at TEXT);
INSERT INTO audit (issue_id, event_type, from_node, content_json, created_at)
  VALUES (-1, '$2', 'trajectory-server', '{"reason":"model_load_failed"}', $3);
EOF
}

test_case "check8 embeddings: unrecovered embeddings_degraded row → WARN, footer not all-passed, exit 0"
reset_scenario emb-degraded
add_audit "$F_DB" embeddings_degraded "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')"
set +e
out=$(run_health_rc)
rc=$?
set -e
assert_contains "$out" "WARN  embeddings: degraded since" "embeddings WARN line"
assert_contains "$out" "model_load_failed" "WARN names the degraded reason"
assert_not_contains "$out" "all checks passed" "degraded embeddings are not all-passed"
assert_contains "$out" "== no check FAILED, 1 degraded" "degraded footer"
assert_not_contains "$out" "FAIL  " "a warn contract is not a FAIL"
assert_exit_code 0 "$rc" "exit code unchanged"

test_case "check8 embeddings: a later embeddings_recovered row → PASS"
add_audit "$F_DB" embeddings_recovered "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
out=$(run_health)
assert_contains "$out" "PASS  embeddings: no unrecovered embeddings_degraded event" "recovered → PASS"
assert_contains "$out" "== all checks passed ==" "recovered → all passed"

test_case "check8 embeddings: a degraded row older than 24 h → PASS"
reset_scenario emb-old
add_audit "$F_DB" embeddings_degraded "strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')"
out=$(run_health)
assert_contains "$out" "PASS  embeddings" "stale degraded row ignored"

test_case "check8 embeddings: no audit table → PASS skipping, never FAIL"
reset_scenario emb-noaudit
out=$(run_health)
assert_contains "$out" "PASS  embeddings: audit table unreadable" "missing audit table skipped"

# ============================================================================
# cache: without project env → the plugin root running the script
# ============================================================================
test_case "cache: script under a dev cache, no CLAUDE_PROJECT_DIR → cache is that dev root, not stable"
reset_scenario self-cache
FAKE_DEV="$SANDBOX/home/.claude/plugins/cache/trustmybot-dev/tmb/9.9.9-dev.1"
STABLE="$SANDBOX/home/.claude/plugins/cache/trustmybot/tmb/1.1.0"
mkdir -p "$FAKE_DEV/scripts/hooks" "$STABLE"
cp "$HEALTH" "$FAKE_DEV/scripts/health.sh"
cp -R "$PLUGIN_ROOT/scripts/hooks/lib" "$FAKE_DEV/scripts/hooks/lib"
printf '{"plugins":{"tmb@trustmybot":[{"scope":"project","projectPath":"/elsewhere","installPath":"%s","version":"1.1.0"}]}}' "$STABLE" > "$ROOT/installed.json"
out=$(env -i PATH="$PATH" HOME="$SANDBOX/home" \
  TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
  TMB_HEALTH_PGREP_COUNT="1" TMB_HEALTH_INSTALLED_JSON="$ROOT/installed.json" \
  bash "$FAKE_DEV/scripts/health.sh" 2>&1 || true)
assert_contains "$out" "cache:     $FAKE_DEV" "cache is the dev root holding the script"
assert_not_contains "$out" "trustmybot/tmb" "stable cache never resolved"
assert_not_contains "$out" "FAIL  cache-version" "no false cache-version FAIL from the stable entry"

# ============================================================================
# server-reachable: pgrep cannot list the process table → UNVERIFIED
# ============================================================================
test_case "check1 server-reachable: pgrep exit 3 → UNVERIFIED, not FAIL"
reset_scenario pgrep-sandboxed
F_PGREP=""
PGREP3_DIR="$SANDBOX/bin-pgrep3"
mkdir -p "$PGREP3_DIR"
printf '#!/usr/bin/env bash\nexit 3\n' > "$PGREP3_DIR/pgrep"
chmod +x "$PGREP3_DIR/pgrep"
set +e
out=$(PATH="$PGREP3_DIR:$PATH" run_health_rc)
rc=$?
set -e
assert_contains "$out" "UNVERIFIED  server-reachable: pgrep exited 3" "UNVERIFIED line"
assert_not_contains "$out" "FAIL  server-reachable" "no server-reachable FAIL"
assert_contains "$out" "== all checks passed ==" "unverified does not fail the run"
assert_exit_code 0 "$rc" "exit code unchanged"

test_case "check1 server-reachable: pgrep exit 1 (no match) → still FAIL"
F_PGREP=""
out=$(run_health)
assert_contains "$out" "FAIL  server-reachable: NO trajectory-server process found" "exit 1 keeps its meaning"

# ============================================================================
# Exit-code contract
# ============================================================================
test_case "exit code: healthy → 0"
reset_scenario exit-ok
env -i PATH="$PATH" HOME="$SANDBOX/home" \
  TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
  TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
  TMB_HEALTH_PGREP_COUNT="1" \
  bash "$HEALTH" >/dev/null 2>&1
assert_exit_code 0 "$?" "healthy exit code"

test_case "exit code: a failing check → 1"
reset_scenario exit-fail
set +e
env -i PATH="$PATH" HOME="$SANDBOX/home" \
  TRAJECTORY_DB_PATH="$F_DB" TMB_HEALTH_SERVER_LOG="$F_LOG" \
  TMB_HEALTH_CACHE_DIR="$F_CACHE" TMB_HEALTH_INTENDED_VERSION="$F_INTENDED" \
  TMB_HEALTH_PGREP_COUNT="0" \
  bash "$HEALTH" >/dev/null 2>&1
rc=$?
set -e
assert_exit_code 1 "$rc" "failing exit code"

summarize
