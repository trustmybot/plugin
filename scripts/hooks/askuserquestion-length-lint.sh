#!/usr/bin/env bash
# PreToolUse hook for #96. Warns on AskUserQuestion options exceeding
# brevity targets (per feedback_ask_user_question.md).
# Never blocks — always allows the AskUserQuestion to proceed.
set -uo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL" = "AskUserQuestion" ] || { exit 0; }

LABEL_MAX_WORDS=5
DESC_MAX_WORDS=15
PREVIEW_MAX_LINES=4

WARNINGS=()

q_idx=0
while IFS= read -r q; do
  [ -n "$q" ] || continue
  o_idx=0
  while IFS= read -r option; do
    [ -n "$option" ] || continue
    label=$(echo "$option" | jq -r '.label // ""' 2>/dev/null)
    desc=$(echo "$option" | jq -r '.description // ""' 2>/dev/null)
    preview=$(echo "$option" | jq -r '.preview // ""' 2>/dev/null)

    label_words=$(echo "$label" | wc -w | tr -d ' ')
    desc_words=$(echo "$desc" | wc -w | tr -d ' ')
    if [ -n "$preview" ]; then
      preview_lines=$(printf '%s' "$preview" | grep -c '^' || true)
    else
      preview_lines=0
    fi

    if [ "$label_words" -gt "$LABEL_MAX_WORDS" ]; then
      WARNINGS+=("q${q_idx}.opt${o_idx} label is ${label_words} words (target ≤${LABEL_MAX_WORDS})")
    fi
    if [ "$desc_words" -gt "$DESC_MAX_WORDS" ]; then
      WARNINGS+=("q${q_idx}.opt${o_idx} description is ${desc_words} words (target ≤${DESC_MAX_WORDS})")
    fi
    if [ "$preview_lines" -gt "$PREVIEW_MAX_LINES" ]; then
      WARNINGS+=("q${q_idx}.opt${o_idx} preview is ${preview_lines} lines (target ≤${PREVIEW_MAX_LINES})")
    fi
    o_idx=$((o_idx + 1))
  done < <(echo "$q" | jq -c '.options // [] | .[]' 2>/dev/null)
  q_idx=$((q_idx + 1))
done < <(echo "$INPUT" | jq -c '.tool_input.questions // [] | .[]' 2>/dev/null)

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  message="AskUserQuestion brevity violations (per feedback_ask_user_question.md):"
  for w in "${WARNINGS[@]}"; do
    message="${message}"$'\n  - '"${w}"
  done
  message="${message}"$'\n\nTargets: label <=5 words, description <=15 words, preview <=4 lines. See #96.'
  jq -nc --arg ctx "$message" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
else
  exit 0
fi
