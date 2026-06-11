#!/usr/bin/env bash
# PreToolUse hook — dispatcher for all Agent-matcher checks.
#
# Runs the five Agent-spawn gate hooks IN ORDER, short-circuiting on the
# first deny (emits that deny verbatim and exits). On a clean pass from
# all five, emits the union of any additionalContext outputs (currently
# none of the five produce context, but the union logic is future-proof).
#
# Hook order (preserved from the five individual hooks.json entries):
#   1. require-task-spec              — swe must cite a valid task_id
#   2. require-feature-branch-active  — task's branch must already exist
#   3. pr-reviewer-no-worktree        — pr-reviewer must not run in worktree
#   4. pr-reviewer-spawn-prompt-shape — pr-reviewer prompt must have four anchors
#   5. pr-reviewer-after-atomic-close — pr-reviewer task must be status=closed
#
# Silent on success (no context gathered); emits deny verbatim on first block.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

HOOKS=(
  "$SCRIPT_DIR/require-task-spec.sh"
  "$SCRIPT_DIR/require-feature-branch-active.sh"
  "$SCRIPT_DIR/pr-reviewer-no-worktree.sh"
  "$SCRIPT_DIR/pr-reviewer-spawn-prompt-shape.sh"
  "$SCRIPT_DIR/pr-reviewer-after-atomic-close.sh"
)

CONTEXT_PARTS=()

for hook in "${HOOKS[@]}"; do
  [ -x "$hook" ] || continue
  OUT=$(printf '%s' "$INPUT" | bash "$hook" 2>/dev/null) || true
  [ -n "$OUT" ] || continue

  DECISION=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)
  if [ "$DECISION" = "deny" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi

  CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
  [ -n "$CTX" ] && CONTEXT_PARTS+=("$CTX")
done

if [ "${#CONTEXT_PARTS[@]}" -gt 0 ]; then
  MERGED=""
  for part in "${CONTEXT_PARTS[@]}"; do
    if [ -n "$MERGED" ]; then
      MERGED="${MERGED}

---

${part}"
    else
      MERGED="$part"
    fi
  done
  jq -nc --arg ctx "$MERGED" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
fi

exit 0
