#!/usr/bin/env bash
# PreToolUse hook (#141). Validates AskUserQuestion batch shape when a
# roundtable is in state='awaiting_human' with no human vote yet recorded.
# Blocks malformed batches; passes through otherwise.
set -uo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL" = "AskUserQuestion" ] || { exit 0; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/query-task.sh"

DB=$(tmb_db_path 2>/dev/null) || true
if [ -z "$DB" ]; then
  exit 0
fi

tmb_have_sqlite || { exit 0; }

RT_ID=$(sqlite3 "$DB" "
  SELECT r.id FROM roundtables r
  WHERE r.state = 'awaiting_human'
    AND NOT EXISTS (
      SELECT 1 FROM roundtable_votes v
      WHERE v.roundtable_id = r.id AND v.participant = 'human'
    )
  ORDER BY r.id DESC LIMIT 1;
" 2>/dev/null) || true

[ -z "$RT_ID" ] && { exit 0; }

QUESTIONS=$(echo "$INPUT" | jq -c '.tool_input.questions // []' 2>/dev/null || true)
Q_COUNT=$(echo "$QUESTIONS" | jq 'length' 2>/dev/null || true)

if [ -z "$Q_COUNT" ] || [ "$Q_COUNT" -eq 0 ]; then
  exit 0
fi

VIOLATIONS=()

if [ "$Q_COUNT" -gt 4 ]; then
  VIOLATIONS+=("AUQ has ${Q_COUNT} questions; max 4 allowed during ratification")
fi

Q1_MULTI=$(echo "$QUESTIONS" | jq '.[0].multiSelect // false' 2>/dev/null)
if [ "$Q1_MULTI" != "true" ]; then
  VIOLATIONS+=("Q1 must have multiSelect:true (agreements checkbox) during ratification")
fi

if [ "$Q_COUNT" -gt 1 ]; then
  idx=1
  while [ "$idx" -lt "$Q_COUNT" ]; do
    Q_MULTI=$(echo "$QUESTIONS" | jq ".[${idx}].multiSelect // false" 2>/dev/null)
    if [ "$Q_MULTI" = "true" ]; then
      VIOLATIONS+=("Q$((idx + 1)) must not use multiSelect (disagreement radios only) during ratification")
    fi
    idx=$((idx + 1))
  done
fi

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  message="roundtable-auq-shape: AskUserQuestion shape is invalid for ratification (roundtable #${RT_ID} awaiting human)."
  for v in "${VIOLATIONS[@]}"; do
    message="${message}"$'\n  - '"${v}"
  done
  message="${message}"$'\n\nExpected shape: Q1 multiSelect=true (agreements); Q2..Qn radio (disagreements); total ≤4.'
  jq -nc --arg msg "$message" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      additionalContext: $msg
    }
  }'
else
  exit 0
fi
