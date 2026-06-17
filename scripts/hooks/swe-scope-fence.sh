#!/usr/bin/env bash
# Hook: SWE scope fence — deny edits outside the task's typed files[] dirs.
#
# Fires in SWE worktree contexts ($PWD inside .claude/worktrees/<slug>).
# Resolves the active task by worktree slug → branch_id, reads the typed
# `files` column (a JSON array, Typed Rails #673) into a dir allowlist, and
# DENY edits targeting paths outside every allowed dir.
#
# Dir-granularity rules:
#   - Each listed path contributes its containing directory.
#   - A path at repo root (no slash) contributes just that file exactly.
#   - A listed path that IS a directory contributes that directory itself.
#   - tests/ paths: always allowed when files[] lists any tests/ path's parent.
#
# Typed Rails (#673): the scope fence reads the typed `files` column directly.
# A task with an empty files[] array (e.g. pre-migration tasks, or bro omitting
# the field) skips enforcement.
#
# Toolchain PATH (#673 audit): this hook performs only path-string comparison
# (jq/dirname/sqlite via libs) — it never execs user toolchains, so the
# toolchain-PATH resolution in swe-verification-gate.sh is not needed here.
#
# Fail-open policy: passes through when:
#   - not an SWE worktree context
#   - task row unresolvable
#   - typed files[] empty or unparseable
#   - target is inside an allowed dir
#
# Fires on: PreToolUse — matcher: Edit|Write|MultiEdit|NotebookEdit
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"

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

# Resolve the worktree root from the TARGET (or $PWD). Fail open when neither
# yields a worktree — we need it to scope the spec lookup and target comparison.
WORKTREE_ROOT=$(tmb_worktree_root_for_target "$TARGET")
[ -n "$WORKTREE_ROOT" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0

# Resolve the active task (worktree branch → slug → transcript), no status filter.
TASK_ID=$(tmb_resolve_task_id_for_target "$TARGET" "$INPUT" "$DB")
[ -n "$TASK_ID" ] || exit 0

# Read the typed `files` column (JSON array of path-like strings, Typed Rails
# #673). One path per line via jq; fail open if the column is absent, empty,
# or not a JSON array.
FILES_JSON=$(tmb_sqlite_ro "$DB" "
  SELECT COALESCE(files, '[]') FROM tasks
   WHERE id = ${TASK_ID}
   LIMIT 1;
" 2>/dev/null || true)

# Fail open: no task row.
[ -n "$FILES_JSON" ] || exit 0

# Parse the JSON array into path tokens (one per line). Empty array or invalid
# JSON yields no lines → fail open below.
FILE_PATHS=$(printf '%s' "$FILES_JSON" | jq -r '.[]?' 2>/dev/null || true)

# Build the dir allowlist from the typed paths.
ALLOWED_DIRS=()
HAS_TESTS_DIR=""

while IFS= read -r path_token; do
  [ -n "$path_token" ] || continue
  case "$path_token" in
    */*) dir=$(dirname "$path_token") ;;
    *)   dir="$path_token" ;;  # root-level file → exact path
  esac
  ALLOWED_DIRS+=("$dir")
  case "$dir" in
    tests/*|tests) HAS_TESTS_DIR="yes" ;;
  esac
done <<< "$FILE_PATHS"

# Empty typed files[] → skip enforcement.
if [ "${#ALLOWED_DIRS[@]}" -eq 0 ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: task has no typed files[] — scope fence skipped. Ask bro to set the task'"'"'s files[] field (Typed Rails #673) to enforce edit scope."}}'
  exit 0
fi

# Normalize target to a repo-relative path for comparison (strip WORKTREE_ROOT).
case "$TARGET" in
  /*) ABS_TARGET="$TARGET" ;;
  *)  ABS_TARGET="${PWD}/${TARGET}" ;;
esac

# Best-effort resolve of ../ and ./ without requiring realpath.
case "$ABS_TARGET" in
  *"/../"*|*"/./"*)
    _resolved=$(cd "$(dirname "$ABS_TARGET")" 2>/dev/null && pwd)/$(basename "$ABS_TARGET") || true
    [ -n "$_resolved" ] && ABS_TARGET="$_resolved"
    ;;
esac

# Strip the worktree root to get a repo-relative path.
case "$ABS_TARGET" in
  "${WORKTREE_ROOT}"/*)
    REL_TARGET="${ABS_TARGET#"${WORKTREE_ROOT}"/}"
    ;;
  *)
    # Target is outside the worktree entirely — swe-boundary.sh handles that deny.
    exit 0
    ;;
esac

# Check if target is under any allowed dir.
for allowed in "${ALLOWED_DIRS[@]}"; do
  case "$REL_TARGET" in
    "${allowed}/"*|"${allowed}")
      exit 0
      ;;
  esac
done

# Special case: if files[] lists any tests/ parent, allow any tests/ path.
if [ "$HAS_TESTS_DIR" = "yes" ]; then
  case "$REL_TARGET" in
    tests/*|tests) exit 0 ;;
  esac
fi

# Target is out of scope — deny with recovery instructions.
DIRS_LIST=$(printf '%s\n' "${ALLOWED_DIRS[@]}" | sort -u | tr '\n' ' ')
DENY_MSG="BLOCKED (scope fence): '${REL_TARGET}' is outside this task's files[] dirs. Allowed: ${DIRS_LIST%. }. To edit files outside scope, ask bro to extend the task's typed files[] field (or file a follow-up task) — do not edit out of scope."

jq -nc --arg r "$DENY_MSG" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$r}}'
exit 0
