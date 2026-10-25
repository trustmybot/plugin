#!/usr/bin/env bash
# Tests for scripts/hooks/user-prompt-persona.sh.
# Covers: with no persona marker for the session (plugin hooks reloaded
# mid-session) the persona is injected once and the marker written;
# silence once session-start-persona.sh marked the session; the old-block note;
# silence at the plugin root and without a session_id; a once-only plain
# notice to start a new session when the plugin CLAUDE.md cannot be read; raw
# text without jq; and the project CLAUDE.md never written.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/user-prompt-persona.sh"
SESSION_START_HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-persona.sh"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-user-prompt-persona.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

FIXTURE_PLUGIN="$TMPDIR/plugin"
mkdir -p "$FIXTURE_PLUGIN/.claude-plugin"
echo '{"name":"tmb","version":"1.1.0"}' > "$FIXTURE_PLUGIN/.claude-plugin/plugin.json"
printf '# You are bro\n\nOrchestrate.\n' > "$FIXTURE_PLUGIN/CLAUDE.md"

PROJECT="$TMPDIR/project"
mkdir -p "$PROJECT"
HEADER="[Persona loaded by the TMB persona hook from the tmb plugin's CLAUDE.md, v1.1.0]"
NOTICE="TMB could not read the plugin CLAUDE.md that carries bro's persona, so this session runs without it. Start a new Claude Code session to load it."

payload() {
  printf '{"session_id":"%s","hook_event_name":"UserPromptSubmit","prompt":"hello"}' "$1"
}

run_hook() {
  local project="$1" input="$2" plugin="$3"; shift 3
  (cd "$project" && printf '%s' "$input" | env CLAUDE_PLUGIN_ROOT="$plugin" CLAUDE_PROJECT_DIR="$project" "$@" bash "$HOOK" 2>/dev/null) || true
}

context_of() {
  printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null || true
}

checksum() {
  if [ -f "$1" ]; then cksum < "$1"; else echo absent; fi
}

marker() {
  printf '%s/.claude/tmb/sessions/%s.%s' "$PROJECT" "$1" "${2:-persona}"
}

test_case "no marker: the persona is injected once and the marker written"
OUT=$(run_hook "$PROJECT" "$(payload s-mid)" "$FIXTURE_PLUGIN")
assert_eq "UserPromptSubmit" "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)" "event name"
CTX=$(context_of "$OUT")
assert_eq "$HEADER" "$(printf '%s\n' "$CTX" | head -1)" "header line"
assert_contains "$CTX" "# You are bro" "persona body"
assert_eq "Project root (<project> in TMB prompts): $PROJECT" "$(printf '%s\n' "$CTX" | sed -n 2p)" "project root line"
if [ -f "$(marker s-mid)" ]; then _pass; else _fail "no persona marker written"; fi
assert_eq "" "$(run_hook "$PROJECT" "$(payload s-mid)" "$FIXTURE_PLUGIN")" "second prompt silent"
assert_eq "absent" "$(checksum "$PROJECT/CLAUDE.md")" "no CLAUDE.md created"

test_case "a session SessionStart already marked: silent"
printf '{"session_id":"s-start","source":"startup"}' \
  | (cd "$PROJECT" && env CLAUDE_PLUGIN_ROOT="$FIXTURE_PLUGIN" CLAUDE_PROJECT_DIR="$PROJECT" bash "$SESSION_START_HOOK" >/dev/null 2>&1) || true
if [ -f "$(marker s-start)" ]; then _pass; else _fail "session-start-persona wrote no marker"; fi
assert_eq "" "$(run_hook "$PROJECT" "$(payload s-start)" "$FIXTURE_PLUGIN")" "marked session"

test_case "an old tmb:persona block: the fallback carries the note, file byte-identical"
printf '# Mine\r\n\r\n<!-- tmb:persona start v1.0.3 -->\r\n# You are bro\r\n<!-- tmb:persona end -->\r\n' > "$PROJECT/CLAUDE.md"
BEFORE=$(checksum "$PROJECT/CLAUDE.md")
CTX=$(context_of "$(run_hook "$PROJECT" "$(payload s-block)" "$FIXTURE_PLUGIN")")
assert_contains "$(printf '%s\n' "$CTX" | sed -n 2p)" "tell the Human they may delete it" "note on line 2"
assert_contains "$CTX" "Orchestrate." "persona body"
assert_eq "$BEFORE" "$(checksum "$PROJECT/CLAUDE.md")" "project CLAUDE.md byte-identical"
rm -f "$PROJECT/CLAUDE.md"

test_case "plugin root as the project: silent, no marker"
assert_eq "" "$(run_hook "$FIXTURE_PLUGIN" "$(payload s-root)" "$FIXTURE_PLUGIN")" "plugin-root project"
assert_eq "absent" "$(checksum "$FIXTURE_PLUGIN/.claude/tmb/sessions/s-root.persona")" "no marker in the plugin root"

test_case "no or unsafe session_id: silent"
assert_eq "" "$(run_hook "$PROJECT" '{"prompt":"hello"}' "$FIXTURE_PLUGIN")" "no session_id"
assert_eq "" "$(run_hook "$PROJECT" "$(payload ../escape)" "$FIXTURE_PLUGIN")" "unsafe session_id"

test_case "unreadable plugin CLAUDE.md: a plain notice once, exit 0, no persona marker"
EMPTY_PLUGIN="$TMPDIR/empty-plugin"
mkdir -p "$EMPTY_PLUGIN/.claude-plugin"
echo '{"name":"tmb","version":"1.1.0"}' > "$EMPTY_PLUGIN/.claude-plugin/plugin.json"
set +e
OUT=$(cd "$PROJECT" && payload s-gone | env CLAUDE_PLUGIN_ROOT="$EMPTY_PLUGIN" CLAUDE_PROJECT_DIR="$PROJECT" bash "$HOOK" 2>&1)
RC=$?
set -e
assert_exit_code 0 "$RC" "exit code"
assert_eq "$NOTICE" "$(printf '%s' "$OUT" | jq -r '.systemMessage' 2>/dev/null)" "notice as systemMessage"
assert_eq "absent" "$(checksum "$(marker s-gone)")" "no persona marker"
assert_eq "" "$(run_hook "$PROJECT" "$(payload s-gone)" "$EMPTY_PLUGIN")" "notice shown once"
OUT=$(run_hook "$PROJECT" "$(payload s-gone)" "$FIXTURE_PLUGIN")
assert_contains "$(context_of "$OUT")" "# You are bro" "persona once the file is readable again"

test_case "jq off PATH: raw text once, then silent; the notice still parses"
. "$HERE/fixtures/no-jq-path.sh"
NOJQ=$(no_jq_path "$TMPDIR/nojq")
OUT=$(run_hook "$PROJECT" "$(payload s-nojq)" "$FIXTURE_PLUGIN" PATH="$NOJQ")
assert_eq "$HEADER" "$(printf '%s\n' "$OUT" | head -1)" "no-jq header"
assert_contains "$OUT" "# You are bro" "no-jq body"
assert_eq "" "$(run_hook "$PROJECT" "$(payload s-nojq)" "$FIXTURE_PLUGIN" PATH="$NOJQ")" "no-jq second prompt silent"
OUT=$(run_hook "$PROJECT" "$(payload s-nojq-gone)" "$EMPTY_PLUGIN" PATH="$NOJQ")
assert_eq "$NOTICE" "$(printf '%s' "$OUT" | jq -r '.systemMessage' 2>/dev/null)" "no-jq notice is valid JSON"

test_case "the hooks never wrote the project CLAUDE.md"
assert_eq "absent" "$(checksum "$PROJECT/CLAUDE.md")" "still absent"

summarize
