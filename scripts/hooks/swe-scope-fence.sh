#!/usr/bin/env bash
# Hook: SWE scope note — tell the swe when an Edit/Write lands outside the
# task's typed files[] dirs. Never denies: scope is judged at close, where
# bro_atomic_close diffs the task's own commits against files[] and records
# the extras bro accepts.
#
# Fires for a swe caller. The task and worktree are the caller's own
# (tmb_agent_context in lib/agent-context.sh: the task_id in its spawn
# transcript → tasks.repo → repos.path → the derived worktree; never the cwd,
# GH 1550). A relative target joins the payload cwd. Reads that
# task's typed `files` column through lib/scope-fence.sh (the classifier
# swe-boundary.sh shares for Bash writes), and for a path outside every
# listed dir emits
# additionalContext "<path> is outside this task's files[] (<dirs>); list it
# and why in your report" — once per path per task.
#
# Silent when: not an SWE context, an unresolved context, no DB, an empty
# files[], a DB read error, the path inside files[], or the path already
# noted. Paths outside the worktree, prompt-surface paths and CLAUDE.md are swe-boundary.sh's and
# containment-guard.sh's denies.
#
# Fires on: PreToolUse — matcher: Edit|Write|MultiEdit|NotebookEdit
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/hooks/lib/scope-fence.sh disable=SC1091
. "$SCRIPT_DIR/lib/scope-fence.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh disable=SC1091
. "$SCRIPT_DIR/lib/cmd-analysis.sh"
# shellcheck source=scripts/hooks/lib/agent-context.sh disable=SC1091
. "$SCRIPT_DIR/lib/agent-context.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)

case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")
SWE_CTX=$(tmb_swe_context "$AGENT_TYPE")

[ "$SWE_CTX" = "yes" ] || exit 0

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || true)
[ -n "$TARGET" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0

tmb_agent_context "$INPUT" "$DB" || exit 0
TASK_ID="$TMB_CTX_TASK_ID"

tmb_scope_fence_load "$DB" "$TASK_ID"
[ "$TMB_FENCE_STATE" = "ok" ] || exit 0

case "$TARGET" in
  /*) ABS_TARGET="$TARGET" ;;
  *)  ABS_TARGET="$(tmb_payload_cwd "$INPUT")/${TARGET}" ;;
esac
ABS_TARGET=$(tmb_path_canonical "$ABS_TARGET")
WORKTREE_C=$(tmb_path_canonical "$TMB_CTX_WORKTREE")

case "$ABS_TARGET" in
  "${WORKTREE_C%/}"/*) REL_TARGET="${ABS_TARGET#"${WORKTREE_C%/}"/}" ;;
  *) exit 0 ;;
esac

tmb_scope_fence_allows "$REL_TARGET" && exit 0

NOTE=$(tmb_scope_fence_note "$TASK_ID" "$REL_TARGET")
[ -n "$NOTE" ] || exit 0
jq -nc --arg c "TMB: $NOTE" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$c}}'
exit 0
