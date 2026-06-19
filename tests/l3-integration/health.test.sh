#!/usr/bin/env bash
# L3: deterministic health-check (#144).
# scripts/health.sh — a standalone bash diagnostic (deliberately NOT an MCP
# tool, so it can diagnose a DOWN server). It runs 7 checks against the
# trajectory DB, the server log, and the plugin cache filesystem, printing
# exactly one PASS/FAIL line per check and the ONE correct remediation under
# every FAIL.
#
# This test drives health.sh against self-contained fixtures (a temp DB seeded
# with plugin_meta/tasks/repos/plugin_config, a fake mcp-server.log, a fake
# cache tree) and asserts the right PASS/FAIL + remediation per scenario across
# all 7 checks, including the three kuzu sub-diagnoses:
#   - lock-contention   (another process holds the single-writer lock)
#   - postinstall-skip   (native binding not installed)
#   - missing-graph      (graph file gone → /scan)
#
# LOAD-BEARING (#144): NO MCP-server-state FAIL — server-unreachable,
# schema-stale, world-model-unavailable — ever prescribes `/reload-plugins`.
# Those require a FULL Claude Code restart because /reload-plugins re-reads
# hook/skill/agent/command DEFINITIONS but does NOT respawn the long-lived MCP
# server. Each such scenario asserts the absence of /reload-plugins explicitly.
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

SANDBOX=$(mktemp -d)
cd "$SANDBOX"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

cleanup() {
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

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
#   <root>/.claude/tmb/world-model.kuzu     — graph file (sibling of the DB)
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
EOF
  if [ -n "$labels" ]; then
    sqlite3 "$db" "INSERT INTO plugin_config (key, value_json) VALUES ('issue_classification_labels', '${labels}');"
  fi
}

# add_task <db> <status> <branch_id>
add_task() {
  sqlite3 "$1" "INSERT INTO tasks (status, branch_id) VALUES ('$2', '$3');"
}

# make_cache <cache_dir> <target_schema> [<with_kuzu_binding:yes|no>]
# Builds a fake installed-cache tree with a db.ts carrying TARGET_SCHEMA_VERSION
# and (optionally) a present kuzu native binding (node_modules/kuzu/index.js).
make_cache() {
  local cache="$1" target="$2" with_kuzu="${3:-yes}"
  mkdir -p "$cache/mcp/trajectory-server/src"
  printf 'const TARGET_SCHEMA_VERSION = %s;\n' "$target" > "$cache/mcp/trajectory-server/src/db.ts"
  if [ "$with_kuzu" = "yes" ]; then
    mkdir -p "$cache/mcp/trajectory-server/node_modules/kuzu"
    printf 'module.exports = {};\n' > "$cache/mcp/trajectory-server/node_modules/kuzu/index.js"
  fi
}

# run_health — invoke health.sh with a clean env. Every input is an explicit
# override so resolution is deterministic and never touches the real install.
# Globals consumed (set per scenario before calling):
#   F_DB F_LOG F_CACHE F_INTENDED F_PGREP F_PLUGINROOT
run_health() {
  env -i \
    PATH="$PATH" \
    HOME="$SANDBOX/home" \
    TRAJECTORY_DB_PATH="${F_DB:-}" \
    TMB_HEALTH_SERVER_LOG="${F_LOG:-}" \
    TMB_HEALTH_CACHE_DIR="${F_CACHE:-}" \
    TMB_HEALTH_INTENDED_VERSION="${F_INTENDED:-}" \
    TMB_HEALTH_PGREP_COUNT="${F_PGREP:-}" \
    CLAUDE_PLUGIN_ROOT="${F_PLUGINROOT:-}" \
    bash "$HEALTH" 2>&1 || true
}

# Reset scenario globals to "healthy" defaults; each test overrides what it
# exercises. Healthy baseline: server alive, versions match, schema matches,
# graph opens, labels set, no stale state, no drift.
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
  make_cache "$F_CACHE" "$TARGET_SCHEMA" yes
  # Graph file present (sibling of DB) so the world-model FS fallback is happy.
  : > "$root/.claude/tmb/world-model.kuzu"
  # Server log logs a successful graph open.
  printf '{"kind":"graph_db_open","ok":true}\n' > "$F_LOG"
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

test_case "check1 server-reachable: LOAD-BEARING — never prescribes /reload-plugins"
assert_not_contains "$rem" "/reload-plugins NOW" "no reload directive in server-state remediation"
# The only mention allowed is the explicit negation ("NOT /reload-plugins").
# Assert no bare positive directive: the remediation must contain "NOT /reload-plugins".
assert_contains "$rem" "NOT /reload-plugins" "server-down explicitly forbids /reload-plugins"

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

test_case "check2 cache-version: remediation = /plugin update + full relaunch"
rem=$(remediation_after "$out" "FAIL  cache-version")
assert_contains "$rem" "/plugin update" "cache-version update remediation"
assert_contains "$rem" "quit + relaunch" "cache-version restart remediation"

test_case "check2 cache-version: LOAD-BEARING — /reload-plugins won't pick up server"
assert_contains "$rem" "/reload-plugins will NOT pick up the new server" "cache-version forbids reload as the fix"

# ============================================================================
# Check 3 — schema-version: DB schema behind installed target → FAIL, restart
# ============================================================================
test_case "check3 schema-version: DB schema < installed target → FAIL"
reset_scenario schema-stale
sqlite3 "$F_DB" "UPDATE plugin_meta SET schema_version=23 WHERE id=1;"
make_cache "$F_CACHE" 24 yes
out=$(run_health)
assert_contains "$out" "FAIL  schema-version: DB at v23 but installed server targets v24" "schema-version FAIL line"

test_case "check3 schema-version: remediation = full quit + relaunch (migration on server start)"
rem=$(remediation_after "$out" "FAIL  schema-version")
assert_contains "$rem" "Fully quit + relaunch Claude Code" "schema restart remediation"
assert_contains "$rem" "migration runs on the next SERVER start" "schema migration framing"

test_case "check3 schema-version: LOAD-BEARING — /reload-plugins does NOT run the migration"
assert_contains "$rem" "/reload-plugins does NOT restart the server" "schema forbids reload as the fix"

# ============================================================================
# Check 4 — world-model (kuzu), sub-diagnosis A: lock-contention → FAIL
# ============================================================================
test_case "check4a world-model: lock-contention → FAIL"
reset_scenario kuzu-lock
printf '{"kind":"graph_db_open_failed","error_message":"Could not set lock on file world-model.kuzu"}\n' > "$F_LOG"
out=$(run_health)
assert_contains "$out" "FAIL  world-model: kuzu open FAILED — graph file is locked" "kuzu lock FAIL line"

test_case "check4a world-model lock: remediation kills the orphan + full restart"
rem=$(remediation_after "$out" "FAIL  world-model")
assert_contains "$rem" "single-writer lock" "lock remediation names the lock"
assert_contains "$rem" "pkill -f 'trajectory-server/dist/index.js'" "lock remediation gives the kill command"
assert_contains "$rem" "quit + relaunch" "lock remediation restarts"

test_case "check4a world-model lock: LOAD-BEARING — no /reload-plugins"
assert_not_contains "$rem" "/reload-plugins" "lock remediation never mentions /reload-plugins"

# ============================================================================
# Check 4 — kuzu sub-diagnosis B: postinstall skipped (binding missing) → FAIL
# ============================================================================
test_case "check4b world-model: postinstall-skipped (binding missing) → FAIL"
reset_scenario kuzu-postinstall
printf '{"kind":"graph_db_open_failed","error_message":"Cannot find module kuzu"}\n' > "$F_LOG"
# Rebuild cache WITHOUT the kuzu native binding.
rm -rf "$F_CACHE"
make_cache "$F_CACHE" "$TARGET_SCHEMA" no
out=$(run_health)
assert_contains "$out" "FAIL  world-model: kuzu open FAILED — native binding not installed" "kuzu postinstall FAIL line"

test_case "check4b world-model postinstall: remediation = node install.js + full restart"
rem=$(remediation_after "$out" "FAIL  world-model")
assert_contains "$rem" "node install.js" "postinstall remediation runs install.js"
assert_contains "$rem" "quit + relaunch" "postinstall remediation restarts"

test_case "check4b world-model postinstall: LOAD-BEARING — no /reload-plugins"
assert_not_contains "$rem" "/reload-plugins" "postinstall remediation never mentions /reload-plugins"

# ============================================================================
# Check 4 — kuzu sub-diagnosis C: missing graph file → FAIL, /scan
# ============================================================================
test_case "check4c world-model: graph file missing → FAIL"
reset_scenario kuzu-missing
# No failure logged; remove the graph file so the FS fallback catches it.
: > "$F_LOG"
rm -f "$ROOT/.claude/tmb/world-model.kuzu"
out=$(run_health)
assert_contains "$out" "FAIL  world-model: graph file missing" "kuzu missing-graph FAIL line"

test_case "check4c world-model missing: remediation = run /scan"
rem=$(remediation_after "$out" "FAIL  world-model")
assert_contains "$rem" "run /scan" "missing-graph remediation prescribes /scan"

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
# Check 7 — hook-cache-drift: dev checkout version != cache → FAIL, /reload OK
# This is the ONE check where /reload-plugins is the CORRECT remediation
# (hook/skill/agent/command DEFINITION drift, not MCP server state).
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

test_case "check7 hook-cache-drift: remediation EXPLICITLY allows /reload-plugins"
rem=$(remediation_after "$out" "FAIL  hook-cache-drift")
assert_contains "$rem" "run /reload-plugins" "drift remediation prescribes /reload-plugins (correct here)"
assert_contains "$rem" "the RIGHT tool here" "drift remediation marks /reload-plugins as correct"

# ============================================================================
# Cross-cutting LOAD-BEARING sweep (#144):
# Run each MCP-server-state failure and assert /reload-plugins is NEVER the
# prescribed fix. The drift check (7) is the only legitimate /reload-plugins
# emitter; all server-state checks must steer to a full restart.
# ============================================================================
test_case "sweep: server-down emits NO bare /reload-plugins directive"
reset_scenario sweep-server
F_PGREP="0"
out=$(run_health)
rem=$(remediation_after "$out" "FAIL  server-reachable")
# A server-state remediation may NEGATE /reload-plugins but must never tell the
# user to run it. Strip the explicit negations, then assert nothing remains.
residual=$(printf '%s\n' "$rem" | grep -F '/reload-plugins' | grep -vF 'NOT /reload-plugins' || true)
assert_eq "" "$residual" "server-state remediation has no positive /reload-plugins directive"

test_case "sweep: schema-stale emits NO bare /reload-plugins directive"
reset_scenario sweep-schema
sqlite3 "$F_DB" "UPDATE plugin_meta SET schema_version=23 WHERE id=1;"
make_cache "$F_CACHE" 24 yes
out=$(run_health)
rem=$(remediation_after "$out" "FAIL  schema-version")
residual=$(printf '%s\n' "$rem" | grep -F '/reload-plugins' | grep -vF 'does NOT restart the server' || true)
assert_eq "" "$residual" "schema-state remediation has no positive /reload-plugins directive"

test_case "sweep: world-model-unavailable (lock) emits NO /reload-plugins at all"
reset_scenario sweep-kuzu
printf '{"kind":"graph_db_open_failed","error_message":"Could not set lock on file world-model.kuzu"}\n' > "$F_LOG"
out=$(run_health)
rem=$(remediation_after "$out" "FAIL  world-model")
assert_not_contains "$rem" "/reload-plugins" "world-model remediation never mentions /reload-plugins"

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
