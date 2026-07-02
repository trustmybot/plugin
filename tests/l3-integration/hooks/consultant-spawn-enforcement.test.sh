#!/usr/bin/env bash
# L3 tests for the consultant-spawn enforcement nudge in
# scripts/hooks/prompt-intent-hints.sh (consultant-spawn pattern class).
#
# De-flake of L6 row 10-consultant (#865): when the consultant-spawn class
# emits its domain-specialist nudge, it ALSO writes a deterministic
# `consultant_spawn_nudged` audit row. The 10-consultant outcome.sql gates on
# that row instead of bro's non-deterministic agent-creator compliance.
#
# Verifies:
#   1. A domain-trade-off prompt (the nudge fires) writes one
#      consultant_spawn_nudged audit row.
#   2. A non-triggering prompt writes NO such row.
#   3. A missing/absent DB does not crash the hook (fail-open, exit 0).
#
# Sandbox-isolated per #810: own tmpdir DB seeded from the real schema; never
# touches the plugin repo working tree.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/prompt-intent-hints.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v sqlite3 >/dev/null 2>&1 || { echo "FAIL: sqlite3 unavailable — required dependency for this security-gate test"; exit 1; }
command -v jq     >/dev/null 2>&1 || { echo "FAIL: jq unavailable — required dependency for this security-gate test"; exit 1; }

TMPDIR_CS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_CS"' EXIT
cd "$TMPDIR_CS" || exit 1

# Sandbox-isolation guard: never run with cwd inside the real plugin repo.
assert_not_in_plugin_repo "$PLUGIN_ROOT"

DB="$TMPDIR_CS/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$SCHEMA" >/dev/null

# Run the hook with a prompt, DB resolved via TRAJECTORY_DB_PATH override.
# Bypass env vars all disabled so the consultant-spawn class is live.
run_hook_with_db() {
  local prompt="$1"
  local payload
  payload=$(jq -cn --arg p "$prompt" '{prompt:$p}')
  printf '%s' "$payload" \
    | TMB_DISABLE_CHEATCODE_INSTALL_HINT=0 \
      TMB_DISABLE_CONSULTANT_HINT=0 \
      TRAJECTORY_DB_PATH="$DB" \
      bash "$HOOK" 2>&1 || true
}

nudged_count() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='consultant_spawn_nudged';"
}

# ========================================================
# Case 1: domain trade-off prompt → nudge fires + audit row written
# ========================================================

test_case "domain trade-off prompt emits the consultant-spawn nudge"
sqlite3 "$DB" "DELETE FROM audit WHERE event_type='consultant_spawn_nudged';"
out=$(run_hook_with_db "Should we keep src/cli.py's storage in JSON or move to SQLite as the CLI scales?")
assert_contains "$out" "consultant-spawn enforcement" "domain trade-off prompt must emit the nudge"

test_case "nudge writes exactly one consultant_spawn_nudged audit row"
assert_eq "1" "$(nudged_count)" "one audit row per nudge"

test_case "audit row carries the enforcement from_node"
ROW=$(sqlite3 -separator "|" "$DB" "SELECT from_node, event_type FROM audit WHERE event_type='consultant_spawn_nudged' LIMIT 1;")
assert_eq "consultant-spawn-enforcement|consultant_spawn_nudged" "$ROW" "from_node + event_type correct"

# ========================================================
# Case 2: non-triggering prompt → no nudge, no audit row
# ========================================================

test_case "non-triggering prompt emits no nudge"
sqlite3 "$DB" "DELETE FROM audit WHERE event_type='consultant_spawn_nudged';"
out=$(run_hook_with_db "Please update the README with the new install steps")
assert_not_contains "$out" "consultant-spawn enforcement" "benign prompt must not emit the nudge"

test_case "non-triggering prompt writes no consultant_spawn_nudged audit row"
assert_eq "0" "$(nudged_count)" "no audit row for a non-triggering prompt"

# ========================================================
# Case 3: missing DB → fail-open (no crash, exit 0, no output crash)
# ========================================================

test_case "missing DB → hook does not crash, still emits the advisory nudge"
ec=0
payload=$(jq -cn '{prompt:"Should we keep JSON or move to SQLite as the CLI scales?"}')
out=$(printf '%s' "$payload" \
  | TMB_DISABLE_CONSULTANT_HINT=0 \
    TRAJECTORY_DB_PATH=/nonexistent-tmb-consultant-spawn.db \
    bash "$HOOK" 2>&1) || ec=$?
assert_eq "0" "$ec" "hook exits 0 when DB is absent"
assert_contains "$out" "consultant-spawn enforcement" "advisory nudge still emitted with no DB"

# ========================================================
# Case 4: DB resolved via walk-up (no env var) still writes the row
# ========================================================

test_case "consultant nudge resolves DB via walk-up (no env var) and writes the row"
WALK_ROOT=$(mktemp -d -t tmb-cs-walk-XXXX)
WALK_DB="$WALK_ROOT/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WALK_DB")"
sqlite3 "$WALK_DB" < "$SCHEMA" >/dev/null
CHILD_DIR="$WALK_ROOT/some/nested/path"
mkdir -p "$CHILD_DIR"
PAYLOAD=$(jq -cn '{prompt:"Should we move from JSON to SQLite as the CLI scales?"}')
BEFORE=$(sqlite3 "$WALK_DB" "SELECT COUNT(*) FROM audit WHERE event_type='consultant_spawn_nudged';")
(
  cd "$CHILD_DIR" || exit 1
  printf '%s' "$PAYLOAD" | TMB_DISABLE_CONSULTANT_HINT=0 bash "$HOOK" >/dev/null 2>&1 || true
)
AFTER=$(sqlite3 "$WALK_DB" "SELECT COUNT(*) FROM audit WHERE event_type='consultant_spawn_nudged';")
rm -rf "$WALK_ROOT"
assert_eq "$((BEFORE + 1))" "$AFTER" "walk-up resolution writes the audit row"

summarize
