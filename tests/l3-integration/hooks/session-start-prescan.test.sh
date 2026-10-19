#!/usr/bin/env bash
# Tests for scripts/hooks/session-start-prescan.sh.
# Covers: output is valid JSON, additionalContext is emitted, cache-friendly
# ordering, cold-session auto-scan launch, bypass env, and the warm / stale /
# cold world-model banner, the duplicate-plugin line, the pre-1.1.0
# user-wide hooks line, and the Tooling line naming a missing jq, and no
# Persona line (the persona hooks own that).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh"

TMPDIR=$(mktemp -d)

# Post-run sentinel: verify no WAL sidecars or stray node processes linger.
cleanup_sidecar_check() {
  pkill -f "$TMPDIR" 2>/dev/null || true
  wait 2>/dev/null || true
  leftover=$(find "$TMPDIR" \( -name "*.db-wal" -o -name "*.db-shm" \) 2>/dev/null || true)
  if [ -n "$leftover" ]; then
    printf "FAIL cleanup: WAL/SHM sidecars left behind:\n%s\n" "$leftover" >&2
  fi
  rm -rf "$TMPDIR"
}
trap cleanup_sidecar_check EXIT

DB="$TMPDIR/trajectory.db"
# Never read the real Claude Code install registry or user settings.
export TMB_INSTALLED_JSON="$TMPDIR/installed_plugins.json"
export CLAUDE_CONFIG_DIR="$TMPDIR/claude-config"

# ---- fixture workspace --------------------------------------------------
# A hermetic git repo with benign commits.  Every hook invocation must run
# from $FIXTURE_WS so that git, glob, and stack-detect all read fixture data
# only — never the real workspace, home dir, or test runner's cwd.
FIXTURE_WS="$TMPDIR/fixture-workspace"
mkdir -p "$FIXTURE_WS/src"
touch "$FIXTURE_WS/README.txt"
touch "$FIXTURE_WS/src/main.sh"
git -C "$FIXTURE_WS" init -q
git -C "$FIXTURE_WS" config user.email "test@example.com"
git -C "$FIXTURE_WS" config user.name "Test"
git -C "$FIXTURE_WS" add .
git -C "$FIXTURE_WS" commit -q -m "initial commit"

# Helper: run the real hook from the fixture workspace with explicit DB.
run_hook() {
  (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) || true
}

# reset_db: remove the DB and any WAL/SHM sidecars atomically, then recreate.
# Use journal_mode=DELETE so no sidecars are ever written during fixture seeding.
reset_db() {
  local db="$1"
  rm -f "$db" "${db}-wal" "${db}-shm"
  sqlite3 "$db" "
    PRAGMA journal_mode=DELETE;
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE repos (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TEXT NOT NULL
    );
    INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
    INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
  "
}

# kill_fixture_node: kill any background node processes scoped to our TMPDIR.
kill_fixture_node() {
  pkill -f "$TMPDIR" 2>/dev/null || true
  # Brief wait so the OS reclaims file handles before the next DB reset.
  sleep 0.1
}

reset_db "$DB"

OUT=$(run_hook)

# ---- basic output shape ----

test_case "hook emits non-empty output"

# Check output is non-empty
if [ -z "$OUT" ]; then
  _fail "hook produced empty output"
else
  _pass
fi

test_case "output is valid JSON"
if echo "$OUT" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "output is not valid JSON: $OUT"
fi

test_case "output contains hookSpecificOutput"
assert_contains "$OUT" "hookSpecificOutput" "JSON has hookSpecificOutput"

test_case "output contains SessionStart event"
assert_contains "$OUT" "SessionStart" "JSON has SessionStart"

test_case "additionalContext is a string"
ctx_type=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

CTX=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")

# ---- stable markers present ----

test_case "stable: Top-level dirs line present"
assert_contains "$CTX" "Top-level dirs:" "Top-level dirs line present"

test_case "stable: Stacks detected line present"
assert_contains "$CTX" "Stacks detected:" "Stacks detected line present"

test_case "stable: World model line present"
assert_contains "$CTX" "World model:" "World model line present"

# ---- volatile markers present ----

test_case "volatile: Git branch line present"
assert_contains "$CTX" "Git branch:" "Git branch line present"

test_case "volatile: Open issues line present"
assert_contains "$CTX" "Open issues:" "Open issues line present"

test_case "volatile: Pending tasks line present"
assert_contains "$CTX" "Pending tasks:" "Pending tasks line present"

test_case "volatile: Last 5 commits present"
assert_contains "$CTX" "Last 5 commits:" "Last 5 commits line present"

# ---- cache-friendly ordering: stable before volatile ----
# Strategy: find the byte-offset of a stable marker and a volatile marker;
# assert stable_offset < volatile_offset.

stable_marker="Top-level dirs:"
volatile_marker="Git branch:"

stable_pos=$(echo "$CTX" | grep -b -o "$stable_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
volatile_pos=$(echo "$CTX" | grep -b -o "$volatile_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")

test_case "ordering: 'Top-level dirs' (stable) appears before 'Git branch' (volatile)"
if [ -z "$stable_pos" ] || [ -z "$volatile_pos" ]; then
  _fail "could not locate markers: stable_pos=<$stable_pos> volatile_pos=<$volatile_pos>"
elif [ "$stable_pos" -lt "$volatile_pos" ]; then
  _pass
else
  _fail "stable marker at byte $stable_pos should be before volatile marker at byte $volatile_pos"
fi

test_case "ordering: 'World model' (stable) appears before 'Open issues' (volatile)"
wm_pos=$(echo "$CTX" | grep -b -o "World model:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
oi_pos=$(echo "$CTX" | grep -b -o "Open issues:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
if [ -z "$wm_pos" ] || [ -z "$oi_pos" ]; then
  _fail "could not locate markers: wm_pos=<$wm_pos> oi_pos=<$oi_pos>"
elif [ "$wm_pos" -lt "$oi_pos" ]; then
  _pass
else
  _fail "world-model marker at byte $wm_pos should be before open-issues marker at byte $oi_pos"
fi

# ---- no-DB graceful exit ----

test_case "missing DB: hook exits silently (no output)"
rm -f "$DB" "${DB}-wal" "${DB}-shm"
out_no_db=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null) || true)
assert_eq "" "$out_no_db" "no output when DB missing"

# Re-create DB for the remaining cold/warm tests.
reset_db "$DB"

# ---- cold session: auto-scan fires ----
# Build a fake invoker that records its invocation without actually running a scan.
FAKE_INVOKER_DIR="$TMPDIR/fake-maintenance"
mkdir -p "$FAKE_INVOKER_DIR"
INVOCATION_FLAG="$TMPDIR/invoked"
cat > "$FAKE_INVOKER_DIR/run-scan-initial.mjs" <<'FAKE'
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
// Record invocation and exit cleanly.
writeFileSync(process.env.INVOCATION_FLAG, '1');
FAKE

# Build a fake scripts tree: hooks/, maintenance/, and scan.sh (availability sentinel).
FAKE_SCRIPTS="$TMPDIR/fake-scripts"
mkdir -p "$FAKE_SCRIPTS/hooks/lib"
cp "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh" "$FAKE_SCRIPTS/hooks/lib/query-task.sh"
mkdir -p "$FAKE_SCRIPTS/maintenance"
cp "$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh" "$FAKE_SCRIPTS/hooks/session-start-prescan.sh"
cp "$FAKE_INVOKER_DIR/run-scan-initial.mjs" "$FAKE_SCRIPTS/maintenance/run-scan-initial.mjs"
# Provide a stub scan.sh so the hook's availability check passes.
echo '#!/usr/bin/env bash' > "$FAKE_SCRIPTS/scan.sh"
chmod +x "$FAKE_SCRIPTS/scan.sh"
FAKE_HOOK="$FAKE_SCRIPTS/hooks/session-start-prescan.sh"

test_case "cold + invoker present: context says scan started"
kill_fixture_node
rm -f "$INVOCATION_FLAG"
COLD_OUT=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" INVOCATION_FLAG="$INVOCATION_FLAG" TMB_SKIP_AUTO_PRESCAN=0 bash "$FAKE_HOOK" 2>/dev/null) || true)
COLD_CTX=$(echo "$COLD_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$COLD_CTX" "scan is running in the background" "cold context mentions background scan"

test_case "cold + invoker present: scan process was invoked"
# Give the background node process a moment to write the flag.
sleep 0.5
if [ -f "$INVOCATION_FLAG" ]; then
  _pass
else
  _fail "fake invoker was not called (flag missing at $INVOCATION_FLAG)"
fi

test_case "cold + invoker present: no Human-directed /scan instruction"
assert_not_contains "$COLD_CTX" "tell the Human to run /scan" "no manual scan instruction"

# ---- cold + TMB_SKIP_AUTO_PRESCAN=1: warn only, no invocation ----

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: context says world model is cold"
kill_fixture_node
rm -f "$INVOCATION_FLAG"
SKIP_OUT=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$FAKE_HOOK" 2>/dev/null) || true)
SKIP_CTX=$(echo "$SKIP_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$SKIP_CTX" "cold" "skip context mentions cold"

test_case "cold: banner line reads cold when no scan row exists"
assert_contains "$SKIP_CTX" "World model:       cold" "cold banner"

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: invoker not called"
sleep 0.2
if [ -f "$INVOCATION_FLAG" ]; then
  _fail "invoker was called despite TMB_SKIP_AUTO_PRESCAN=1"
else
  _pass
fi

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: no background scan message"
assert_not_contains "$SKIP_CTX" "scan is running in the background" "no background scan message when bypassed"

# ---- cold source-file count: workspace root and empty tree ----

test_case "cold workspace: source files are summed across registered repos on one line"
kill_fixture_node
reset_db "$DB"
WS_ROOT="$TMPDIR/ws"
mkdir -p "$WS_ROOT"
for spec in "alpha:2" "beta:3"; do
  repo_name="${spec%%:*}"
  repo_files="${spec##*:}"
  mkdir -p "$WS_ROOT/$repo_name"
  git -C "$WS_ROOT/$repo_name" init -q
  git -C "$WS_ROOT/$repo_name" config user.email "test@example.com"
  git -C "$WS_ROOT/$repo_name" config user.name "Test"
  for i in $(seq 1 "$repo_files"); do touch "$WS_ROOT/$repo_name/file$i.txt"; done
  git -C "$WS_ROOT/$repo_name" add .
  git -C "$WS_ROOT/$repo_name" commit -q -m "initial commit"
  sqlite3 "$DB" "INSERT INTO repos (name, path, last_scanned_at) VALUES ('$repo_name', '$WS_ROOT/$repo_name', '2026-01-01T00:00:00Z');"
done
WS_OUT=$( (cd "$WS_ROOT" && env CLAUDE_PROJECT_DIR="$WS_ROOT" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) || true)
WS_CTX=$(echo "$WS_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$WS_CTX" "cold (no scan yet; 5 source files)" "workspace sum of 2 + 3 files"

test_case "non-repo cwd: the inventory names every repos row with its own branch, stacks and commits"
printf '{}\n' > "$WS_ROOT/beta/package.json"
git -C "$WS_ROOT/beta" checkout -q -b feature-x
NONREPO_CWD="$TMPDIR/not-a-repo"
mkdir -p "$NONREPO_CWD"
NR_CTX=$( (cd "$NONREPO_CWD" && env CLAUDE_PROJECT_DIR="$WS_ROOT" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || true)
NR_BRANCH_ALPHA=$(git -C "$WS_ROOT/alpha" rev-parse --abbrev-ref HEAD)
assert_contains "$NR_CTX" "Top-level dirs:    alpha beta" "top-level dirs come from the project root"
assert_contains "$NR_CTX" "Stacks detected:   alpha: (none detected); beta: Node" "stacks per repos row"
assert_contains "$NR_CTX" "Git branch:        alpha: ${NR_BRANCH_ALPHA} (1 commits, 0 dirty paths); beta: feature-x (1 commits, 1 dirty paths)" "branch per repos row"
assert_contains "$NR_CTX" "  [alpha] " "alpha's commits are labelled"
assert_contains "$NR_CTX" "  [beta] " "beta's commits are labelled"
rm -f "$WS_ROOT/beta/package.json"

test_case "a repos row whose dir is gone is reported missing"
sqlite3 "$DB" "INSERT INTO repos (name, path, last_scanned_at) VALUES ('gone', '$WS_ROOT/gone', '2026-01-01T00:00:00Z');"
GONE_CTX=$( (cd "$NONREPO_CWD" && env CLAUDE_PROJECT_DIR="$WS_ROOT" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || true)
assert_contains "$GONE_CTX" "gone: missing ($WS_ROOT/gone)" "missing repo dir named"
WS_WM_LINES=$(printf '%s\n' "$WS_CTX" | grep -c '^World model:' || true)
assert_eq "1" "$WS_WM_LINES" "World model row starts once"
assert_eq "Trajectory DB:" "$(printf '%s\n' "$WS_CTX" | grep -A1 '^World model:' | tail -1 | cut -c1-14)" "World model row is a single line"

test_case "cold empty tree: a single 0 source files and no auto-scan"
kill_fixture_node
reset_db "$DB"
EMPTY_REPO="$TMPDIR/empty-repo"
mkdir -p "$EMPTY_REPO"
git -C "$EMPTY_REPO" init -q
rm -f "$INVOCATION_FLAG"
EMPTY_OUT=$( (cd "$EMPTY_REPO" && env CLAUDE_PROJECT_DIR="$EMPTY_REPO" TRAJECTORY_DB_PATH="$DB" INVOCATION_FLAG="$INVOCATION_FLAG" TMB_SKIP_AUTO_PRESCAN=0 bash "$FAKE_HOOK" 2>/dev/null) || true)
EMPTY_CTX=$(echo "$EMPTY_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$EMPTY_CTX" "cold (no scan yet; 0 source files)" "zero tracked files"
EMPTY_ZERO_COUNT=$(printf '%s\n' "$EMPTY_CTX" | grep -o '0 source files' | wc -l | tr -d ' ')
assert_eq "1" "$EMPTY_ZERO_COUNT" "0 source files appears exactly once"
assert_eq "World model:       cold (no scan yet; 0 source files)" "$(printf '%s\n' "$EMPTY_CTX" | grep '^World model:')" "no doubled 0 in the World model row"
assert_eq "Trajectory DB:" "$(printf '%s\n' "$EMPTY_CTX" | grep -A1 '^World model:' | tail -1 | cut -c1-14)" "World model row is a single line"
assert_not_contains "$EMPTY_CTX" "scan is running in the background" "no auto-scan message on an empty tree"
sleep 0.3
if [ -f "$INVOCATION_FLAG" ]; then
  _fail "invoker was called for an empty tree"
else
  _pass
fi
reset_db "$DB"

# ---- warm session: recent scan, banner carries file count + age ----

test_case "warm: context shows warm world model with file count and age"
kill_fixture_node
sqlite3 "$DB" "INSERT INTO audit (event_type) VALUES ('deep_scan_completed');
  INSERT INTO repos (name, path, file_count, last_scanned_at)
    VALUES ('fixture', '$FIXTURE_WS', 42, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'));"
WARM_OUT=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null) || true)
WARM_CTX=$(echo "$WARM_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$WARM_CTX" "World model:       warm (42 files, last scan 3h ago)" "warm banner with age"

test_case "warm: no background scan note in context"
assert_not_contains "$WARM_CTX" "scan is running in the background" "no scan note in warm session"

test_case "warm: no cold-world-model note in context"
assert_not_contains "$WARM_CTX" "world model is cold" "no cold message in warm session"

# ---- stale session: newest scan older than 7 days ----

test_case "stale: last scan past 7 days reads stale with age and /scan hint"
sqlite3 "$DB" "UPDATE repos SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days');"
STALE_OUT=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null) || true)
STALE_CTX=$(echo "$STALE_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$STALE_CTX" "World model:       stale (last scan 12d ago) — run /scan" "stale banner"

test_case "stale: never says warm"
assert_not_contains "$STALE_CTX" "warm" "stale model is not warm"

test_case "stale: a scan row with no repos row still reads stale, never warm"
sqlite3 "$DB" "DELETE FROM repos;"
NOREPO_OUT=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null) || true)
NOREPO_CTX=$(echo "$NOREPO_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$NOREPO_CTX" "World model:       stale (last scan unknown) — run /scan" "unknown age reads stale"

# ---- Trajectory DB data-contract banner ----
# A DB built from the real schema (rollback journal, so no sidecars), so every
# contract in scripts/hooks/lib/data-contracts.json can run against it.
SCHEMA_DB="$TMPDIR/schema-trajectory.db"
schema_db() {
  rm -f "$SCHEMA_DB" "${SCHEMA_DB}-wal" "${SCHEMA_DB}-shm"
  grep -v '^PRAGMA journal_mode' "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" | sqlite3 "$SCHEMA_DB" >/dev/null
  sqlite3 "$SCHEMA_DB" "INSERT INTO audit (issue_id, from_node, event_type, summary, created_at) VALUES (-1, 'system', 'deep_scan_completed', 'fixture', strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
}
doctor_line() {
  local out
  out=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$SCHEMA_DB" TMB_SKIP_AUTO_PRESCAN=1 "$@" bash "$HOOK" 2>/dev/null) || true)
  printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep '^Trajectory DB:' || true
}

test_case "doctor banner: clean schema DB reports healthy"
schema_db
assert_eq "Trajectory DB:     healthy" "$(doctor_line)" "healthy banner"

test_case "doctor banner: line sits right after the World model line"
schema_db
BANNER_CTX=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$SCHEMA_DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) | jq -r '.hookSpecificOutput.additionalContext' | grep -A1 '^World model:' | tail -1 || true)
assert_contains "$BANNER_CTX" "Trajectory DB:" "Trajectory DB line follows World model"

test_case "doctor banner: violations are counted and named"
schema_db
sqlite3 "$SCHEMA_DB" "
  INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('closed', 'closed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
    VALUES (last_insert_rowid(), 'feat/x', 'd', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO audit (issue_id, from_node, event_type, summary, created_at) VALUES (-1, 'system', 'made_up_event', 'x', strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
assert_eq "Trajectory DB:     2 contract violation(s) [event_type_documented, issues_closed_no_live_tasks] — run trajectory_doctor" \
  "$(doctor_line)" "violations banner"

test_case "doctor banner: a spent budget reports unchecked (timeout), never healthy"
schema_db
assert_eq "Trajectory DB:     unchecked (timeout)" "$(doctor_line TMB_DOCTOR_BUDGET_MS=1)" "timeout banner"

test_case "doctor banner: an older schema names the version gap, never healthy"
schema_db
sqlite3 "$SCHEMA_DB" "UPDATE plugin_meta SET schema_version = 29 WHERE id = 1; ALTER TABLE agent_runs RENAME COLUMN session_id TO session_id_v29;"
assert_eq "Trajectory DB:     unchecked (schema v29 < v$(jq -r .schema_version "$PLUGIN_ROOT/scripts/hooks/lib/data-contracts.json") — start the trajectory server to migrate)" "$(doctor_line)" "schema banner"

test_case "doctor banner: an older schema with every contract column present still names the gap, never healthy"
schema_db
sqlite3 "$SCHEMA_DB" "UPDATE plugin_meta SET schema_version = 30 WHERE id = 1;"
assert_eq "Trajectory DB:     unchecked (schema v30 < v$(jq -r .schema_version "$PLUGIN_ROOT/scripts/hooks/lib/data-contracts.json") — start the trajectory server to migrate)" "$(doctor_line)" "schema banner with all columns"

test_case "doctor banner: a DB the contracts cannot read reports unchecked, never healthy"
reset_db "$DB"
NO_SCHEMA_LINE=$( (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) | jq -r '.hookSpecificOutput.additionalContext' | grep '^Trajectory DB:' || true)
assert_not_contains "$NO_SCHEMA_LINE" "healthy" "no healthy banner on read errors"
assert_contains "$NO_SCHEMA_LINE" "unchecked" "read errors leave contracts unchecked"

# ---- Duplicate enabled plugin copies ----
# Fixture pairs: installed_plugins.json + the project's settings.local.json.
DUP_HOME="$TMPDIR/dup-home"
mkdir -p "$DUP_HOME" "$FIXTURE_WS/.claude"
LOCAL_SETTINGS="$FIXTURE_WS/.claude/settings.local.json"
dup_entry() { printf '{"scope":"%s","projectPath":"%s","installPath":"/cache/%s","version":"%s"}' "$1" "$FIXTURE_WS" "$2" "$2"; }
dup_run() {
  (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$SCHEMA_DB" TMB_SKIP_AUTO_PRESCAN=1 HOME="$DUP_HOME" bash "$HOOK" 2>"$TMPDIR/dup.err") || true
}
dup_line() { dup_run | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep '^Plugin:' || true; }
schema_db

test_case "duplicate plugin: one enabled copy is silent"
printf '{"plugins":{"tmb@trustmybot-dev":[%s]}}' "$(dup_entry local 1.0.3)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true}}' > "$LOCAL_SETTINGS"
assert_eq "" "$(dup_line)" "no Plugin line"

test_case "duplicate plugin: two enabled copies for this project add one line naming both"
printf '{"plugins":{"tmb@trustmybot-dev":[%s],"tmb@trustmybot-rc":[%s]}}' "$(dup_entry local 1.0.3)" "$(dup_entry project 1.0.2-rc.3)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$LOCAL_SETTINGS"
assert_eq "Plugin: duplicate tmb copies enabled (trustmybot-dev, trustmybot-rc) — hooks from one are dropped; run /plugin" "$(dup_line)" "Plugin line"

test_case "duplicate plugin: two installed, one disabled is silent"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}' > "$LOCAL_SETTINGS"
assert_eq "" "$(dup_line)" "no Plugin line"

test_case "duplicate plugin: a user and a project entry of one marketplace are one copy"
printf '{"plugins":{"tmb@trustmybot-dev":[%s,%s]}}' "$(dup_entry user 1.0.1)" "$(dup_entry local 1.0.3)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true}}' > "$LOCAL_SETTINGS"
assert_eq "" "$(dup_line)" "no Plugin line"

test_case "duplicate plugin: unreadable files are silent with no error"
printf '{"plugins":{"tmb@trustmybot-dev":[%s],"tmb@trustmybot-rc":[%s]}}' "$(dup_entry local 1.0.3)" "$(dup_entry local 1.0.2-rc.3)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":' > "$LOCAL_SETTINGS"
assert_eq "" "$(dup_line)" "invalid settings.local.json: no Plugin line"
assert_eq "" "$(cat "$TMPDIR/dup.err")" "invalid settings.local.json: no stderr"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$LOCAL_SETTINGS"
chmod 000 "$TMB_INSTALLED_JSON"
assert_eq "" "$(dup_line)" "unreadable installed_plugins.json: no Plugin line"
assert_eq "" "$(cat "$TMPDIR/dup.err")" "unreadable installed_plugins.json: no stderr"
chmod 600 "$TMB_INSTALLED_JSON"
rm -f "$TMB_INSTALLED_JSON" "$LOCAL_SETTINGS"

# ---- Pre-1.1.0 TMB hooks in the user-scope settings.json ----
LEGACY_CFG="$CLAUDE_CONFIG_DIR"
LEGACY_SETTINGS="$LEGACY_CFG/settings.json"
LEGACY_FIXTURE="$HERE/fixtures/legacy-user-settings.json"
LEGACY_OLD="$TMPDIR/old-project"
mkdir -p "$LEGACY_CFG" "$LEGACY_OLD" "$TMPDIR/rc-project"
LEGACY_OLD_REAL=$(cd "$LEGACY_OLD" && pwd -P)
legacy_run() {
  (cd "$FIXTURE_WS" && env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TRAJECTORY_DB_PATH="$SCHEMA_DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>"$TMPDIR/legacy.err") || true
}
legacy_lines() { legacy_run | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep '^Plugin: .*pre-1\.1\.0 TMB hook' || true; }
legacy_sums() { cksum "$LEGACY_SETTINGS" "$TMB_INSTALLED_JSON" 2>/dev/null; }
legacy_entry() { printf '{"scope":"local","projectPath":"%s","installPath":"/cache/%s","version":"%s"}' "$1" "$2" "$2"; }
LEGACY_DOC="docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks"
LEGACY_ENTRIES="line 10 git-guards, line 23 agent-spawn-dispatch, line 33 swe-scope-guard"
schema_db

test_case "legacy user hooks: resolve-hook.sh and _tmb_managed entries add one line naming the file, lines, hooks and other old projects"
cp "$LEGACY_FIXTURE" "$LEGACY_SETTINGS"
printf '{"plugins":{"tmb@trustmybot-dev":[%s,%s,%s,%s]}}' \
  "$(legacy_entry "$LEGACY_OLD" 1.0.2)" "$(legacy_entry "$TMPDIR/rc-project" 1.1.0-rc.1)" \
  "$(legacy_entry "$FIXTURE_WS" 1.0.3)" "$(legacy_entry "$TMPDIR/gone-project" 1.0.1)" > "$TMB_INSTALLED_JSON"
BEFORE=$(legacy_sums)
assert_eq "Plugin: $LEGACY_SETTINGS holds 3 pre-1.1.0 TMB hook(s) ($LEGACY_ENTRIES) — they run in every project and can deny what this version allows; the Human removes them by hand, see $LEGACY_DOC; projects on TMB < 1.1.0 lose them too: $LEGACY_OLD_REAL (1.0.2)" \
  "$(legacy_lines)" "one legacy line"
assert_eq "" "$(cat "$TMPDIR/legacy.err")" "no stderr"
assert_eq "$BEFORE" "$(legacy_sums)" "settings.json and installed_plugins.json unchanged"

test_case "legacy user hooks: no old project installs leaves the project clause off"
rm -f "$TMB_INSTALLED_JSON"
assert_eq "Plugin: $LEGACY_SETTINGS holds 3 pre-1.1.0 TMB hook(s) ($LEGACY_ENTRIES) — they run in every project and can deny what this version allows; the Human removes them by hand, see $LEGACY_DOC" \
  "$(legacy_lines)" "no project clause"
cmp "$LEGACY_FIXTURE" "$LEGACY_SETTINGS" >/dev/null && same=yes || same=no
assert_eq "yes" "$same" "settings.json byte-identical"

test_case "legacy user hooks: both SessionStart hooks together give one warning naming each entry once"
cp "$LEGACY_FIXTURE" "$LEGACY_SETTINGS"
both_ctx=$( {
  legacy_run
  printf '{"hook_event_name":"SessionStart","session_id":"legacy-1"}' \
    | env CLAUDE_PROJECT_DIR="$FIXTURE_WS" TMB_MCP_HEALTH_SAMPLES=1 bash "$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh" 2>/dev/null || true
} | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
assert_eq "1" "$(printf '%s\n' "$both_ctx" | grep -c "$LEGACY_SETTINGS")" "one warning names the settings file"
for entry in "line 10 git-guards" "line 23 agent-spawn-dispatch" "line 33 swe-scope-guard"; do
  assert_eq "1" "$(printf '%s\n' "$both_ctx" | grep -o "$entry" | grep -c .)" "$entry named once"
done
cmp "$LEGACY_FIXTURE" "$LEGACY_SETTINGS" >/dev/null && same=yes || same=no
assert_eq "yes" "$same" "settings.json byte-identical"

test_case "legacy user hooks: a one-line settings file names each entry on line 1"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash ~/.claude/tmb-hooks/resolve-hook.sh --marketplace mp --hook a"},{"type":"command","command":"bash ~/.claude/tmb-hooks/resolve-hook.sh --marketplace mp --hook b","_tmb_managed":true},{"type":"command","command":"bash ~/.claude/tmb-hooks/dispatch.sh --hook c","_tmb_managed":true}]}]}}\n' > "$LEGACY_SETTINGS"
assert_contains "$(legacy_lines)" "holds 3 pre-1.1.0 TMB hook(s) (line 1 a, line 1 b, line 1 c)" "each entry once"

test_case "legacy user hooks: a _tmb_managed entry without resolve-hook.sh or --hook is named by line"
printf '{\n  "statusLine": {"type": "command", "command": "echo status"},\n  "hooks": {"PreToolUse": [{"hooks": [\n    {"type": "command", "command": "/opt/old-tmb/gate.sh", "_tmb_managed": true}\n  ]}]}\n}\n' > "$LEGACY_SETTINGS"
assert_contains "$(legacy_lines)" "holds 1 pre-1.1.0 TMB hook(s) (line 4 ?)" "named by line"

test_case "legacy user hooks: clean, missing or unparsable settings print nothing"
printf '{"plugins":{"tmb@trustmybot-dev":[%s]}}' "$(legacy_entry "$LEGACY_OLD" 1.0.2)" > "$TMB_INSTALLED_JSON"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"},{"type":"command","command":"echo also-mine","_tmb_managed":false}]}]},"permissions":{"allow":["Bash(bash resolve-hook.sh)"]}}\n' > "$LEGACY_SETTINGS"
BEFORE=$(legacy_sums)
assert_eq "" "$(legacy_lines)" "clean settings: no line"
assert_eq "$BEFORE" "$(legacy_sums)" "clean settings: files unchanged"
printf '{"hooks":' > "$LEGACY_SETTINGS"
assert_eq "" "$(legacy_lines)" "unparsable settings: no line"
assert_eq "" "$(cat "$TMPDIR/legacy.err")" "unparsable settings: no stderr"
rm -f "$LEGACY_SETTINGS"
assert_eq "" "$(legacy_lines)" "missing settings: no line"
assert_eq "" "$(cat "$TMPDIR/legacy.err")" "missing settings: no stderr"
rm -f "$TMB_INSTALLED_JSON"

# ---- Persona: none in the prescan ----
# A fixture plugin root (v1.0.3) and the fixture project's CLAUDE.md.
PERSONA_PLUGIN="$TMPDIR/persona-plugin"
mkdir -p "$PERSONA_PLUGIN/.claude-plugin"
echo '{"name":"tmb","version":"1.0.3"}' > "$PERSONA_PLUGIN/.claude-plugin/plugin.json"
echo '# bro' > "$PERSONA_PLUGIN/CLAUDE.md"
persona_line() {
  local project="$1"
  ( (cd "$project" && env TRAJECTORY_DB_PATH="$SCHEMA_DB" TMB_SKIP_AUTO_PRESCAN=1 TMB_INSTALLED_JSON="$TMPDIR/none.json" \
      CLAUDE_PLUGIN_ROOT="$PERSONA_PLUGIN" CLAUDE_PROJECT_DIR="$project" bash "$HOOK" 2>/dev/null) || true) \
    | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep '^Persona:' || true
}
schema_db

test_case "persona: no Persona line for any project CLAUDE.md"
rm -f "$FIXTURE_WS/CLAUDE.md"
assert_eq "" "$(persona_line "$FIXTURE_WS")" "no CLAUDE.md"
printf '# Mine\n' > "$FIXTURE_WS/CLAUDE.md"
assert_eq "" "$(persona_line "$FIXTURE_WS")" "CLAUDE.md without a block"
printf '# Mine\n\n<!-- tmb:persona start v1.0.2 -->\n# bro\n<!-- tmb:persona end -->\n' > "$FIXTURE_WS/CLAUDE.md"
assert_eq "" "$(persona_line "$FIXTURE_WS")" "stale block"
printf '# Mine\r\n\r\n<!-- tmb:persona start v1.0.3 -->\r\n# bro\r\n<!-- tmb:persona end -->\r\n' > "$FIXTURE_WS/CLAUDE.md"
assert_eq "" "$(persona_line "$FIXTURE_WS")" "current CRLF block"
rm -f "$FIXTURE_WS/CLAUDE.md"
assert_eq "" "$(persona_line "$PERSONA_PLUGIN")" "plugin-root project"

test_case "jq present: no Tooling line"
assert_not_contains "$OUT" "Tooling:" "no Tooling line with jq on PATH"

test_case "jq off PATH: the Tooling line, as valid JSON"
. "$HERE/fixtures/no-jq-path.sh"
NOJQ=$(no_jq_path "$TMPDIR/nojq")
NOJQ_OUT=$( (cd "$FIXTURE_WS" && env PATH="$NOJQ" TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$HOOK" 2>/dev/null) || true)
assert_eq "Tooling: jq not found — every TMB gate will deny until it is installed" \
  "$(printf '%s' "$NOJQ_OUT" | jq -r '.hookSpecificOutput.additionalContext')" "the one Tooling line"
assert_eq "SessionStart" "$(printf '%s' "$NOJQ_OUT" | jq -r '.hookSpecificOutput.hookEventName')" "a SessionStart output"

summarize
