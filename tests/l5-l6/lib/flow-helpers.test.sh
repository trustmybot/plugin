#!/usr/bin/env bash
# Tests for the L5 harness helpers in tests/l5-l6/lib/flow-helpers.sh.
# Run: bash tests/l5-l6/lib/flow-helpers.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
export PLUGIN_ROOT
. "$PLUGIN_ROOT/tests/lib/assert.sh"
. "$HERE/flow-helpers.sh"
set -e

export HOME
HOME=$(mktemp -d)
SCRATCH=()
cleanup() {
  rm -rf "$HOME" "${SCRATCH[@]}"
}
trap cleanup EXIT

new_project() {
  local fixture="$1" project
  project=$(l5_setup_scratch_project)
  SCRATCH+=("$project")
  l5_seed_db "$project" "$fixture" >/dev/null
  printf '%s\n' "$project"
}

for fixture in onboarding-named empty; do
  test_case "$fixture fixture: scratch project has no CLAUDE.md"
  PROJECT=$(new_project "$fixture")
  SCRATCH+=("$PROJECT")
  if [ -e "$PROJECT/CLAUDE.md" ]; then
    _fail "CLAUDE.md exists in $fixture-fixture project"
  else
    _pass
  fi
done

PREAMBLE=$(_l5_test_prompt_prefix)

test_case "compose: starts with the unchanged preamble"
COMPOSED=$(l5_compose_test_prompt "/roundtable topic")
assert_eq "$PREAMBLE" "${COMPOSED:0:${#PREAMBLE}}" "preamble prefix"

test_case "preamble pins the /onboard sandbox answer to no (GH 1549)"
assert_contains "$PREAMBLE" "sandbox_enforcement: 'no'" "sandbox pin"

test_case "preamble carries no /onboard token, which would suppress the reonboard hint (GH 1553)"
assert_not_contains "$PREAMBLE" "/onboard" "preamble /onboard token"

test_case "reonboard hook: composed remote-setup prompt on an onboarded DB emits the reonboard hint (GH 1553)"
if ! command -v sqlite3 >/dev/null 2>&1; then
  _pass "skipped: sqlite3 not installed"
else
  REONBOARD_PROJECT=$(mktemp -d)
  SCRATCH+=("$REONBOARD_PROJECT")
  mkdir -p "$REONBOARD_PROJECT/.claude/tmb"
  REONBOARD_DB="$REONBOARD_PROJECT/.claude/tmb/trajectory.db"
  sqlite3 "$REONBOARD_DB" "CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT); INSERT INTO plugin_config VALUES ('onboarded', 'true');"
  REONBOARD_OUT=$(jq -n --arg p "$(l5_compose_test_prompt "@bro this project needs to live on a remote — set it up.")" '{prompt:$p}' \
    | TRAJECTORY_DB_PATH="$REONBOARD_DB" CLAUDE_PROJECT_DIR="$REONBOARD_PROJECT" \
      bash "$PLUGIN_ROOT/scripts/hooks/prompt-intent-hints.sh" 2>/dev/null || true)
  assert_contains "$REONBOARD_OUT" "reonboard-intent hint" "hook output"
fi

test_case "compose: row prompt follows after exactly one blank line"
assert_eq "$PREAMBLE"$'\n\n'"/roundtable topic" "$COMPOSED" "preamble, blank line, prompt"

slash_rows() {
  sqlite3 "$1/.claude/tmb/trajectory.db" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';"
}

replay_hook() {
  local project="$1" composed="$2"
  jq -n --arg p "$composed" '{prompt:$p}' \
    | TRAJECTORY_DB_PATH="$project/.claude/tmb/trajectory.db" CLAUDE_PROJECT_DIR="$project" \
      bash "$PLUGIN_ROOT/scripts/hooks/roundtable-slash-detect.sh" >/dev/null 2>&1 || true
}

test_case "slash hook: composed /roundtable prompt writes one roundtable_slash_invoked row"
HOOK_PROJECT=$(new_project onboarding-named)
replay_hook "$HOOK_PROJECT" "$(l5_compose_test_prompt "/roundtable topic")"
assert_eq "1" "$(slash_rows "$HOOK_PROJECT")" "slash rows"

test_case "slash hook: composed plain prompt writes no roundtable_slash_invoked row"
PLAIN_PROJECT=$(new_project onboarding-named)
replay_hook "$PLAIN_PROJECT" "$(l5_compose_test_prompt "just a normal prompt")"
assert_eq "0" "$(slash_rows "$PLAIN_PROJECT")" "slash rows"

# --- deep_scan_completed deleters cascade audit_embeddings (GH 1460) ---
embedded_scan_project() {
  local project
  project=$(new_project onboarding-named)
  sqlite3 "$project/.claude/tmb/trajectory.db" \
    "INSERT INTO audit_embeddings (audit_id, embedding, model_id, embedded_at)
       SELECT id, X'00', 'test', datetime('now') FROM audit WHERE event_type = 'deep_scan_completed';"
  printf '%s\n' "$project"
}

assert_scan_row_dropped_cleanly() {
  local project="$1" db="$1/.claude/tmb/trajectory.db"
  assert_eq "" "$(sqlite3 "$db" "PRAGMA foreign_key_check;")" "foreign_key_check output"
  assert_eq "0" "$(sqlite3 "$db" "SELECT COUNT(*) FROM audit WHERE event_type = 'deep_scan_completed';")" "deep_scan_completed rows"
}

test_case "chain seed before-05: embedded deep_scan_completed row dropped without dangling FK rows"
SEEDED=$(embedded_scan_project)
assert_eq "1" "$(sqlite3 "$SEEDED/.claude/tmb/trajectory.db" "SELECT COUNT(*) FROM audit_embeddings;")" "embedding row before seed"
sqlite3 "$SEEDED/.claude/tmb/trajectory.db" < "$PLUGIN_ROOT/tests/l5-l6/l6-chain/seeds/before-05-first-task-hits-gate.sql"
assert_scan_row_dropped_cleanly "$SEEDED"

for row_setup in \
  "$PLUGIN_ROOT/tests/l5-l6/rows/05/05-first-task-hits-gate/setup-l5.sh" \
  "$PLUGIN_ROOT/tests/l5-l6/rows/05/05.03-codebase-memory-cold-start/setup-l5.sh"; do
  test_case "$(basename "$(dirname "$row_setup")") setup-l5: embedded deep_scan_completed row dropped without dangling FK rows"
  ROW_PROJECT=$(embedded_scan_project)
  bash "$row_setup" "$ROW_PROJECT" "$(dirname "$row_setup")" >/dev/null 2>&1
  assert_scan_row_dropped_cleanly "$ROW_PROJECT"
done
# --- end deep_scan_completed deleters ---

test_case "l6 chain helper: claude call disables the project-scoped trajectory-server"
assert_contains "$(cat "$HERE/l6-chain-helpers.sh")" "--settings '{\"disabledMcpjsonServers\":[\"trajectory-server\"]}'" "cc_args --settings flag"

summarize
