#!/usr/bin/env bash
# Tests for the persona-block helpers in tests/l5-l6/lib/flow-helpers.sh.
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
  if l5_fixture_is_onboarded "$project"; then
    l5_write_persona_block "$project"
  fi
  printf '%s\n' "$project"
}

persona_line() {
  local project="$1"
  ( (cd "$project" && env TRAJECTORY_DB_PATH="$project/.claude/tmb/trajectory.db" TMB_SKIP_AUTO_PRESCAN=1 \
      TMB_INSTALLED_JSON="$HOME/none.json" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$project" \
      bash "$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh" 2>/dev/null) || true) \
    | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep '^Persona:' || true
}

VERSION=$(jq -r .version "$PLUGIN_ROOT/.claude-plugin/plugin.json")
FIRST_LINE=$(grep -m1 -v '^[[:space:]]*$' "$PLUGIN_ROOT/CLAUDE.md" | tr -d '\r')

ONBOARDED=$(new_project onboarding-named)

test_case "onboarded fixture: CLAUDE.md carries the versioned start marker"
assert_contains "$(cat "$ONBOARDED/CLAUDE.md")" "<!-- tmb:persona start v$VERSION -->" "start marker"

test_case "onboarded fixture: CLAUDE.md carries the end marker"
assert_contains "$(cat "$ONBOARDED/CLAUDE.md")" "<!-- tmb:persona end -->" "end marker"

test_case "onboarded fixture: CLAUDE.md carries the plugin persona body"
assert_contains "$(cat "$ONBOARDED/CLAUDE.md")" "$FIRST_LINE" "first non-empty plugin CLAUDE.md line"

test_case "onboarded fixture: block ends with the end marker and one newline"
assert_eq "<!-- tmb:persona end -->" "$(tail -n 1 "$ONBOARDED/CLAUDE.md")" "last line"

test_case "onboarded fixture: session-start prescan prints no Persona line"
assert_eq "" "$(persona_line "$ONBOARDED")" "Persona line"

test_case "existing CLAUDE.md: block appended after one blank line"
APPEND=$(l5_setup_scratch_project)
SCRATCH+=("$APPEND")
printf '# project\n' > "$APPEND/CLAUDE.md"
l5_write_persona_block "$APPEND"
assert_eq "" "$(sed -n 2p "$APPEND/CLAUDE.md")" "blank separator line"
assert_eq "<!-- tmb:persona start v$VERSION -->" "$(sed -n 3p "$APPEND/CLAUDE.md")" "start marker line"

EMPTY=$(new_project empty)

test_case "empty fixture: not onboarded"
if l5_fixture_is_onboarded "$EMPTY"; then
  _fail "empty fixture reported onboarded"
else
  _pass
fi

test_case "empty fixture: no CLAUDE.md"
if [ -e "$EMPTY/CLAUDE.md" ]; then
  _fail "CLAUDE.md exists in empty-fixture project"
else
  _pass
fi

PREAMBLE=$(_l5_test_prompt_prefix)

test_case "compose: starts with the unchanged preamble"
COMPOSED=$(l5_compose_test_prompt "/roundtable topic")
assert_eq "$PREAMBLE" "${COMPOSED:0:${#PREAMBLE}}" "preamble prefix"

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

summarize
