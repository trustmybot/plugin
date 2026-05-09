#!/usr/bin/env bash
# Tests for scripts/hooks/session-start-regen-check.sh.
# Hook contract: on SessionStart, emits additionalContext suggesting regen
# if HEAD has drifted from regen_state.last_seen_sha by > threshold commits.
# Silent no-op otherwise.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-regen-check.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
REPO="$TMPDIR/repo"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE regen_state (
    target        TEXT PRIMARY KEY,
    last_regen_at TEXT,
    last_seen_sha TEXT,
    notes         TEXT NOT NULL DEFAULT ''
  );
"

git init -q "$REPO"
cd "$REPO"
git -c user.email=t@t.io -c user.name=t commit --allow-empty -qm "init"
INIT_SHA=$(git rev-parse HEAD)

run_hook() {
  echo '{}' | bash "$HOOK" 2>&1 || true
}

test_case "no DB: silent no-op"
PWD_ORIG=$PWD
cd "$TMPDIR"
unset TRAJECTORY_DB_PATH
out=$(run_hook)
export TRAJECTORY_DB_PATH="$DB"
cd "$PWD_ORIG"
assert_eq "" "$out" "no DB silenced"

test_case "DB exists but regen_state has no row: silent no-op"
out=$(run_hook)
assert_eq "" "$out" "no regen_state row silenced"

test_case "regen_state matches HEAD (no drift): silent no-op"
sqlite3 "$DB" "INSERT INTO regen_state (target, last_seen_sha) VALUES ('architecture', '$INIT_SHA');"
out=$(run_hook)
assert_eq "" "$out" "no drift = no nudge"

test_case "drift below threshold: silent no-op"
for i in 1 2 3; do git -c user.email=t@t.io -c user.name=t commit --allow-empty -qm "c$i"; done
out=$(echo '{}' | env TMB_REGEN_DRIFT_THRESHOLD=10 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "below threshold silenced"

test_case "drift at/above threshold: emit additionalContext"
out=$(echo '{}' | env TMB_REGEN_DRIFT_THRESHOLD=2 bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"hookEventName":"SessionStart"' "JSON event name"
assert_contains "$out" 'architecture_regen' "suggests architecture_regen MCP tool"
assert_contains "$out" 'commits since last regen' "summary mentions commit count"

test_case "regen_state references unknown sha: silent no-op (defensive)"
sqlite3 "$DB" "UPDATE regen_state SET last_seen_sha='deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE target='architecture';"
out=$(echo '{}' | env TMB_REGEN_DRIFT_THRESHOLD=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "unknown sha silenced"
