#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): Stay-on-base guard.
#
# The main checkout (workspace repo root, not a worktree) must stay on the
# base branch (pr_target, typically 'dev') while SWE tasks are in flight.
# Switching the main checkout to a task branch while SWE work is open would
# cause bro to operate on the wrong HEAD — PR targets, branch comparisons,
# and world-model scans all break silently.
#
# DENY when ALL of these hold:
#   1. The command is a branch-switching git subcommand (git checkout <branch>
#      / git switch <branch>) that is NOT a new-branch creation (-b/-B/-c/-C).
#   2. The target branch matches a branch_id of an open task (status IN
#      ('pending','running','needs_validation')).
#   3. The CWD is the MAIN checkout (not inside .claude/worktrees/*).
#
# ALLOW:
#   - New-branch creation (-b/-B/-c/-C) — bro creates branches legitimately.
#   - Switches to non-task branches (base branches, pr_target pulls, etc.).
#   - Any command run from inside a worktree (.claude/worktrees/*).
#   - Commands that switch to a branch not referenced by any open task.
#
# Pattern follows #428 hardening: numeric task_id validation, RO sqlite
# wrapper from lib/query-task.sh, early-exit for non-checkout commands.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
[ -n "$CMD" ] || exit 0

# Early-exit: only care about git checkout / git switch.
_is_branch_switch() {
  printf '%s' "$1" | grep -qE '(^|[[:space:]]*([;&]|[|][|]|[&][&])[[:space:]]*)git[[:space:]]+(checkout|switch)([[:space:]]|$)'
}
_is_branch_switch "$CMD" || exit 0

# Early-exit: new-branch creation is always allowed (bro creates branches).
case "$CMD" in
  *" -b "*|*" -B "*|*" -c "*|*" -C "*|*" --create "*)
    exit 0
    ;;
esac

# Early-exit: command run from inside a worktree — SWE operates in worktrees.
# Check both PWD (hook's CWD) and any `cd <path> &&` prefix in the command.
_cmd_cwd() {
  local cd_path
  cd_path=$(printf '%s' "$1" | sed -nE 's|^[[:space:]]*cd[[:space:]]+"([^"]+)".*|\1|p' | head -1)
  [ -z "$cd_path" ] && cd_path=$(printf '%s' "$1" | sed -nE "s|^[[:space:]]*cd[[:space:]]+'([^']+)'.*|\1|p" | head -1)
  [ -z "$cd_path" ] && cd_path=$(printf '%s' "$1" | sed -nE 's|^[[:space:]]*cd[[:space:]]+([^[:space:]&;]+).*|\1|p' | head -1)
  [ -n "$cd_path" ] && echo "$cd_path" && return
  echo "$PWD"
}

EFFECTIVE_CWD=$(_cmd_cwd "$CMD")
case "$EFFECTIVE_CWD" in
  */.claude/worktrees/*) exit 0 ;;
esac
case "$PWD" in
  */.claude/worktrees/*) exit 0 ;;
esac

# Extract the target branch name from the switch/checkout command.
# Supports: git checkout <branch>, git switch <branch>,
#           git checkout -- is a file restore (no branch), skip it.
_target_branch() {
  local cmd="$1"
  # Strip leading cd ... &&
  local bare
  bare=$(printf '%s' "$cmd" | sed -E 's|^[[:space:]]*cd[[:space:]]+[^[:space:]&;]+[[:space:]]*&&[[:space:]]*||')
  # git checkout -- <file> is a file restore, not a branch switch.
  printf '%s' "$bare" | grep -qE 'git[[:space:]]+checkout[[:space:]]+--[[:space:]]' && echo "" && return
  # Extract last non-flag token after checkout/switch.
  printf '%s' "$bare" | grep -oE 'git[[:space:]]+(checkout|switch)[[:space:]]+.*' | \
    sed -E 's/git[[:space:]]+(checkout|switch)[[:space:]]+//' | \
    tr ' ' '\n' | grep -v '^-' | tail -1 || true
}

TARGET_BRANCH=$(_target_branch "$CMD")
[ -n "$TARGET_BRANCH" ] || exit 0

# Reject non-printable / suspicious branch names before handing to sqlite3.
if ! printf '%s' "$TARGET_BRANCH" | grep -qE '^[a-zA-Z0-9_./:@^~-]+$'; then
  exit 0
fi

# Check the DB for open tasks referencing this branch_id.
tmb_have_sqlite || exit 0
DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] && [ -f "$DB" ] || exit 0

OPEN_TASK_ID=$(tmb_sqlite_ro "$DB" "
  SELECT id FROM tasks
   WHERE branch_id = '${TARGET_BRANCH}'
     AND status IN ('pending','running','needs_validation')
   LIMIT 1;
")

[ -n "$OPEN_TASK_ID" ] || exit 0

# Safety: numeric guard — task ids are always integers.
if ! printf '%s' "$OPEN_TASK_ID" | grep -qE '^[0-9]+$'; then
  exit 0
fi

# Determine the worktree slug so we can tell the user where to go.
SLUG=$(printf '%s' "$TARGET_BRANCH" | sed 's|.*/||')

jq -nc --arg reason \
  "the main checkout stays on the base; SWE work lives in worktrees — use the worktree at .claude/worktrees/${SLUG}. Branch '${TARGET_BRANCH}' belongs to open task #${OPEN_TASK_ID}. Switch to the worktree instead: cd .claude/worktrees/${SLUG}" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
