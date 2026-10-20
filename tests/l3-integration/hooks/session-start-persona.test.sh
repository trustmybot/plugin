#!/usr/bin/env bash
# Tests for scripts/hooks/session-start-persona.sh.
# Covers: the plugin CLAUDE.md as additionalContext behind a header line on
# every SessionStart source (startup, resume, clear, compact), whatever the
# project CLAUDE.md holds; the one-line note for an old tmb:persona block; the
# per-session persona marker; silence for the plugin-root project; raw text
# without jq; silence without a readable source; and the project CLAUDE.md left
# byte-identical.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-persona.sh"

TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/tmb-session-start-persona.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

FIXTURE_PLUGIN="$TMPDIR/plugin"
mkdir -p "$FIXTURE_PLUGIN/.claude-plugin"
echo '{"name":"tmb","version":"1.1.0"}' > "$FIXTURE_PLUGIN/.claude-plugin/plugin.json"
printf '# You are bro\n\nOrchestrate.\n' > "$FIXTURE_PLUGIN/CLAUDE.md"

PROJECT="$TMPDIR/project"
mkdir -p "$PROJECT"
HEADER="[Persona loaded by the TMB persona hook from the tmb plugin's CLAUDE.md, v1.1.0]"
NOTE="[The project's CLAUDE.md still holds a <!-- tmb:persona --> block from an older /onboard. It is no longer needed, since this hook delivers the persona; tell the Human they may delete it.]"

payload() {
  printf '{"session_id":"%s","hook_event_name":"SessionStart","source":"%s"}' "$1" "$2"
}

run_hook() {
  local project="$1" input="$2"; shift 2
  (cd "$project" && printf '%s' "$input" | env CLAUDE_PLUGIN_ROOT="$FIXTURE_PLUGIN" CLAUDE_PROJECT_DIR="$project" "$@" bash "$HOOK" 2>/dev/null) || true
}

context_of() {
  printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null || true
}

checksum() {
  if [ -f "$1" ]; then cksum < "$1"; else echo absent; fi
}

marker() {
  printf '%s/.claude/tmb/sessions/%s.persona' "$PROJECT" "$1"
}

assert_persona_emitted() {
  local label="$1" sid="$2" source="$3" before out ctx
  before=$(checksum "$PROJECT/CLAUDE.md")
  rm -f "$(marker "$sid")"
  out=$(run_hook "$PROJECT" "$(payload "$sid" "$source")")
  assert_eq "SessionStart" "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)" "$label: event name"
  ctx=$(context_of "$out")
  assert_eq "$HEADER" "$(printf '%s\n' "$ctx" | head -1)" "$label: header line"
  assert_contains "$ctx" "# You are bro" "$label: persona body"
  assert_contains "$ctx" "Project root (<project> in TMB prompts): $PROJECT" "$label: project root line"
  assert_eq "$before" "$(checksum "$PROJECT/CLAUDE.md")" "$label: project CLAUDE.md byte-identical"
  if [ -f "$(marker "$sid")" ]; then _pass; else _fail "$label: no persona marker for $sid"; fi
}

test_case "every SessionStart source injects the persona and writes the marker"
for source in startup resume clear compact; do
  assert_persona_emitted "$source" "s-$source" "$source"
done
assert_eq "absent" "$(checksum "$PROJECT/CLAUDE.md")" "no CLAUDE.md created"

test_case "project CLAUDE.md without a block: persona, no note"
printf '# Mine\n\nOur rules.\n' > "$PROJECT/CLAUDE.md"
assert_persona_emitted "no block" s-plain startup
assert_not_contains "$(context_of "$(run_hook "$PROJECT" "$(payload s-plain startup)")")" "tmb:persona" "no block: no note"

test_case "an old tmb:persona block, any version: persona plus the one-line note"
for version in 1.0.3 1.1.0; do
  printf '# Mine\r\n\r\n<!-- tmb:persona start v%s -->\r\n# You are bro\r\n<!-- tmb:persona end -->\r\n' "$version" > "$PROJECT/CLAUDE.md"
  assert_persona_emitted "block v$version" "s-block-$version" resume
  CTX=$(context_of "$(run_hook "$PROJECT" "$(payload "s-block-$version" resume)")")
  assert_eq "$NOTE" "$(printf '%s\n' "$CTX" | sed -n 2p)" "block v$version: note on line 2"
  assert_contains "$CTX" "Orchestrate." "block v$version: persona body still sent"
done
rm -f "$PROJECT/CLAUDE.md"

test_case "plugin root as the project: silent, no marker"
assert_eq "" "$(run_hook "$FIXTURE_PLUGIN" "$(payload s-root startup)")" "plugin-root project"
ln -s "$FIXTURE_PLUGIN" "$TMPDIR/plugin-link"
assert_eq "" "$(run_hook "$TMPDIR/plugin-link" "$(payload s-root startup)")" "plugin root through a symlink"
assert_eq "absent" "$(checksum "$FIXTURE_PLUGIN/.claude/tmb/sessions/s-root.persona")" "no marker in the plugin root"

test_case "no or unsafe session_id: persona still injected, no marker"
OUT=$(run_hook "$PROJECT" '{"source":"startup"}')
assert_contains "$(context_of "$OUT")" "# You are bro" "no session_id"
OUT=$(run_hook "$PROJECT" "$(payload ../escape startup)")
assert_contains "$(context_of "$OUT")" "# You are bro" "unsafe session_id"
assert_eq "absent" "$(checksum "$PROJECT/.claude/tmb/escape.persona")" "no marker outside sessions/"

test_case "CLAUDE_PROJECT_DIR unset: falls back to the working directory"
OUT=$( (cd "$FIXTURE_PLUGIN" && payload s-cwd startup | env -u CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT="$FIXTURE_PLUGIN" bash "$HOOK" 2>/dev/null) || true)
assert_eq "" "$OUT" "cwd = plugin root"
OUT=$( (cd "$PROJECT" && payload s-cwd startup | env -u CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT="$FIXTURE_PLUGIN" bash "$HOOK" 2>/dev/null) || true)
assert_contains "$(context_of "$OUT")" "# You are bro" "cwd = project"

test_case "jq off PATH: raw text with the header, marker still written"
. "$HERE/fixtures/no-jq-path.sh"
NOJQ=$(no_jq_path "$TMPDIR/nojq")
rm -f "$(marker s-nojq)"
OUT=$(run_hook "$PROJECT" "$(payload s-nojq startup)" PATH="$NOJQ")
assert_eq "$HEADER" "$(printf '%s\n' "$OUT" | head -1)" "no-jq header"
assert_contains "$OUT" "# You are bro" "no-jq body"
if [ -f "$(marker s-nojq)" ]; then _pass; else _fail "no-jq: no persona marker"; fi
printf '# Mine\n<!-- tmb:persona start v1.0.3 -->\n# bro\n<!-- tmb:persona end -->\n' > "$PROJECT/CLAUDE.md"
assert_eq "$NOTE" "$(run_hook "$PROJECT" "$(payload s-nojq startup)" PATH="$NOJQ" | sed -n 2p)" "no-jq note"
rm -f "$PROJECT/CLAUDE.md"

test_case "no readable plugin CLAUDE.md: silent, exit 0, no marker"
EMPTY_PLUGIN="$TMPDIR/empty-plugin"
mkdir -p "$EMPTY_PLUGIN"
rm -f "$(marker s-empty)"
set +e
OUT=$(cd "$PROJECT" && payload s-empty startup | env CLAUDE_PLUGIN_ROOT="$EMPTY_PLUGIN" CLAUDE_PROJECT_DIR="$PROJECT" bash "$HOOK" 2>&1)
RC=$?
set -e
assert_exit_code 0 "$RC" "exit code"
assert_eq "" "$OUT" "output"
assert_eq "absent" "$(checksum "$(marker s-empty)")" "no marker without a persona"

test_case "the shipped plugin CLAUDE.md fits the hook context cap"
SHIPPED=$( (cd "$PROJECT" && payload s-shipped startup | env CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$PROJECT" bash "$HOOK" 2>/dev/null) || true)
SHIPPED_CTX=$(context_of "$SHIPPED")
assert_contains "$SHIPPED_CTX" "# You are bro" "shipped persona"
if [ "${#SHIPPED_CTX}" -lt 10000 ]; then _pass; else _fail "shipped context is ${#SHIPPED_CTX} chars, over the 10k cap"; fi

summarize
