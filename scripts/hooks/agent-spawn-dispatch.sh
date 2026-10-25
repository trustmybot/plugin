#!/usr/bin/env bash
# PreToolUse hook — dispatcher for all Agent-matcher checks.
#
# Runs the nine Agent-spawn gates IN ORDER, short-circuiting on the
# first deny (emits that deny verbatim and exits). On a clean pass from
# all nine, emits the union of any additionalContext outputs (currently
# none of the nine produce context, but the union logic is future-proof).
#
# Hook order:
#   1. require-task-spec              — swe must cite a valid task_id
#   2. require-spawn-effort           — swe/pr-reviewer effort must match the DB
#   3. require-feature-branch-active  — task's branch must already exist
#   4. pr-reviewer-no-worktree        — pr-reviewer must not run in worktree
#   5. pr-reviewer-spawn-prompt-shape — pr-reviewer prompt must have seven anchors
#   6. pr-reviewer-after-atomic-close — pr-reviewer task must be status=closed
#   7. pr-reviewer-spawn-note         — TypeScript gate (dist/hooks.js): at most
#      300 chars of prose beyond the anchors; more goes into spawn_note via
#      bro_atomic_close (GH 1744)
#   8. pr-reviewer-preflight          — TypeScript gate (dist/hooks.js): the
#      task commit's five deterministic checks; denies {check, expected, actual}
#   9. rework-limit                   — TypeScript gate (dist/hooks.js): a swe
#      spawn after two review FAILs since the last pass needs a newer decision
#      row or a Human comment (GH 1738)
#
# Silent on success (no context gathered); emits deny verbatim on first block.
#
# After all gates pass, the PREPARE steps run: ensure-swe-worktree.sh creates
# swe's worktree at the canonical slug, then record-swe-spawn.sh moves a pending
# task to running and opens the spawn's swe agent_runs row. They ACT rather than
# gate: non-blocking and fail-open, so they never deny a spawn.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || { echo "agent-spawn-dispatch: jq not found" >&2; exit 1; }

HOOKS_JS="$SCRIPT_DIR/../../mcp/trajectory-server/dist/hooks.js"

HOOKS=(
  "$SCRIPT_DIR/require-task-spec.sh"
  "$SCRIPT_DIR/require-spawn-effort.sh"
  "$SCRIPT_DIR/require-feature-branch-active.sh"
  "$SCRIPT_DIR/pr-reviewer-no-worktree.sh"
  "$SCRIPT_DIR/pr-reviewer-spawn-prompt-shape.sh"
  "$SCRIPT_DIR/pr-reviewer-after-atomic-close.sh"
  pr-reviewer-spawn-note
  pr-reviewer-preflight
  rework-limit
)

CONTEXT_PARTS=()

for hook in "${HOOKS[@]}"; do
  case "$hook" in
    *.sh) [ -x "$hook" ] || continue; GATE_CMD=(bash "$hook") ;;
    *) { [ -f "$HOOKS_JS" ] && command -v node >/dev/null 2>&1; } || continue; GATE_CMD=(node "$HOOKS_JS" "$hook") ;;
  esac
  OUT=$(printf '%s' "$INPUT" | "${GATE_CMD[@]}" 2>/dev/null) || true
  [ -n "$OUT" ] || continue

  DECISION=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)
  if [ "$DECISION" = "deny" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi

  CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
  [ -n "$CTX" ] && CONTEXT_PARTS+=("$CTX")
done

# PREPARE steps — all gates passed. Create swe's worktree at the canonical slug
# (so the non-interactive `claude -p` path is isolated and the verification gate
# finds the right slug), then record the spawn. Fail-open: never deny the spawn.
for PREPARE in "$SCRIPT_DIR/ensure-swe-worktree.sh" "$SCRIPT_DIR/record-swe-spawn.sh"; do
  [ -x "$PREPARE" ] || continue
  printf '%s' "$INPUT" | bash "$PREPARE" >/dev/null 2>&1 || true
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
