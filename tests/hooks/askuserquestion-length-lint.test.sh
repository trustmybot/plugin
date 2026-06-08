#!/usr/bin/env bash
# Tests for scripts/hooks/askuserquestion-length-lint.sh
# Hook contract: warn (via additionalContext) when AskUserQuestion option
# labels/descriptions/previews exceed brevity targets. Never blocks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/askuserquestion-length-lint.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_input() {
  local tool="$1"
  local questions_json="$2"
  jq -nc --arg t "$tool" --argjson q "$questions_json" '{tool_name: $t, tool_input: {questions: $q}}'
}

make_question() {
  local label="$1" desc="$2" preview="$3"
  jq -nc --arg l "$label" --arg d "$desc" --arg p "$preview" \
    '{options: [{label: $l, description: $d, preview: $p}]}'
}

# Case 1: non-AskUserQuestion tool passes silently
test_case "non-AskUserQuestion tool exits silently"
input=$(jq -nc '{tool_name: "Bash", tool_input: {command: "echo hi"}}')
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for non-AskUserQuestion"

# Case 2: AskUserQuestion within brevity targets — silent
test_case "AskUserQuestion within brevity targets passes silently"
q=$(make_question "Short label" "Brief description here" "line1")
input=$(make_input "AskUserQuestion" "[$q]")
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for within-target call"

# Case 3: label exceeds 5 words — emits additionalContext about label
test_case "AskUserQuestion with overlong label emits additionalContext"
q=$(make_question "This label is way too many words here" "Fine desc" "line1")
input=$(make_input "AskUserQuestion" "[$q]")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_contains "$out" "label" "warning mentions label"
assert_contains "$out" "words" "warning cites word count"

# Case 4: description exceeds 15 words — emits additionalContext about description
test_case "AskUserQuestion with overlong description emits additionalContext"
q=$(make_question "Ok label" "This description is much too long and has way more than fifteen words total in it" "line1")
input=$(make_input "AskUserQuestion" "[$q]")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_contains "$out" "description" "warning mentions description"
assert_contains "$out" "words" "warning cites word count"

# Case 5: preview exceeds 4 lines — emits additionalContext about preview
test_case "AskUserQuestion with overlong preview emits additionalContext"
LONG_PREVIEW="line1
line2
line3
line4
line5"
q=$(jq -nc --arg p "$LONG_PREVIEW" '{options: [{label: "Ok", description: "Fine", preview: $p}]}')
input=$(make_input "AskUserQuestion" "[$q]")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_contains "$out" "preview" "warning mentions preview"
assert_contains "$out" "lines" "warning cites line count"

# Case 6: multiple violations — single message listing all
test_case "multiple violations produce single message listing all"
LONG_PREVIEW2="a
b
c
d
e"
q=$(jq -nc --arg p "$LONG_PREVIEW2" \
  '{options: [{label: "This is a very long label indeed", description: "This description is also way too long and exceeds the fifteen word limit significantly", preview: $p}]}')
input=$(make_input "AskUserQuestion" "[$q]")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "additionalContext key present"
assert_contains "$out" "label" "warning mentions label violation"
assert_contains "$out" "description" "warning mentions description violation"
assert_contains "$out" "preview" "warning mentions preview violation"
assert_contains "$out" "#96" "warning cites issue #96"

summarize
