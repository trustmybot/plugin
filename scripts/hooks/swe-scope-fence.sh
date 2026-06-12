#!/usr/bin/env bash
# Hook: SWE scope fence — deny edits outside the task's ## Files dirs.
#
# Fires in SWE worktree contexts ($PWD inside .claude/worktrees/<slug>).
# Resolves the active task by worktree slug → branch_id, parses the spec_body's
# ## Files section into a dir allowlist, and DENY edits targeting paths outside
# every allowed dir.
#
# Dir-granularity rules:
#   - Each listed path contributes its containing directory.
#   - A path at repo root (no slash) contributes just that file exactly.
#   - A listed path that IS a directory contributes that directory itself.
#   - tests/ paths: always allowed when ## Files lists any tests/ path's parent.
#
# Fail-open policy: passes through when:
#   - not an SWE worktree context
#   - task row or spec_body unresolvable
#   - ## Files section absent or unparseable
#   - target is inside an allowed dir
#
# Fires on: PreToolUse — matcher: Edit|Write|MultiEdit|NotebookEdit
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
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

# Only fire when PWD is inside a worktree — we need the slug to resolve the task.
case "$PWD" in
  */.claude/worktrees/*)
    WORKTREE_SLUG=$(echo "$PWD" | sed -E 's|.*/.claude/worktrees/([^/]+).*|\1|')
    ;;
  *)
    exit 0
    ;;
esac

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || true)
[ -n "$TARGET" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0

# Resolve the active task by worktree slug (slug = branch_id without the type/ prefix,
# or more precisely the last component of branch_id: feat/<slug>).
SAFE_SLUG=$(tmb_sql_quote "$WORKTREE_SLUG")
SPEC_BODY=$(tmb_sqlite_ro "$DB" "
  SELECT spec_body FROM tasks
   WHERE branch_id LIKE '%/${SAFE_SLUG}'
     AND status IN ('pending','running','completed')
   ORDER BY id DESC
   LIMIT 1;
" 2>/dev/null || true)

# Fail open: no task row or no spec_body.
[ -n "$SPEC_BODY" ] || exit 0

# Parse the ## Files section from spec_body.
# Extract everything between "## Files" and the next "## " heading (or end of string).
FILES_SECTION=$(echo "$SPEC_BODY" | awk '
  /^## Files/ { in_section=1; next }
  in_section && /^## / { in_section=0 }
  in_section { print }
' 2>/dev/null || true)

# Fail open: no ## Files section.
[ -n "$FILES_SECTION" ] || exit 0

# Parse paths from bullet lines: "- path/to/file — description" or "- path/to/file"
# Extract the path token (first non-whitespace token after "- ").
ALLOWED_DIRS=()
HAS_TESTS_DIR=""

while IFS= read -r line; do
  # Match bullet lines: lines starting with optional whitespace + "- "
  case "$line" in
    "- "*|"  - "*|"   - "*)
      # Strip leading "- " or "  - " etc.
      path_part=$(echo "$line" | sed -E 's/^[[:space:]]*-[[:space:]]+//')
      # Take only the first token (path), strip any " — ..." or " - ..." description.
      path_token=$(echo "$path_part" | sed -E 's/[[:space:]]+(—|-)[[:space:]].*//' | awk '{print $1}')
      # Skip empty or non-path tokens.
      [ -n "$path_token" ] || continue
      case "$path_token" in
        */*) dir=$(dirname "$path_token") ;;
        *)   dir="$path_token" ;;  # root-level file → exact path
      esac
      ALLOWED_DIRS+=("$dir")
      case "$dir" in
        tests/*|tests) HAS_TESTS_DIR="yes" ;;
      esac
      ;;
  esac
done <<< "$FILES_SECTION"

# Fail open: no parseable paths.
[ "${#ALLOWED_DIRS[@]}" -gt 0 ] || exit 0

# Normalize target to a repo-relative path for comparison.
# Strip the worktree root prefix so we can compare against spec paths.
WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')

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
    REL_TARGET="${ABS_TARGET#${WORKTREE_ROOT}/}"
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

# Special case: if ## Files lists any tests/ parent, allow any tests/ path.
if [ "$HAS_TESTS_DIR" = "yes" ]; then
  case "$REL_TARGET" in
    tests/*|tests) exit 0 ;;
  esac
fi

# Target is out of scope — deny with recovery instructions.
DIRS_LIST=$(printf '%s\n' "${ALLOWED_DIRS[@]}" | sort -u | tr '\n' ' ')
DENY_MSG="BLOCKED (scope fence): '${REL_TARGET}' is outside this task's ## Files dirs. Allowed: ${DIRS_LIST%. }. To edit files outside scope, ask bro to extend the spec ## Files (or file a follow-up task) — do not edit out of scope."

jq -nc --arg r "$DENY_MSG" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$r}}'
exit 0
