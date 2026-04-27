#!/usr/bin/env bash
# PreToolUse hook (#170). Blocks `git worktree add -b|-B <branch> ...` calls.
# Branch authority belongs to bro: the branch must be created BEFORE the
# worktree (via `git branch <task.branch_id> HEAD` from bro's session), and
# `git worktree add` must attach the worktree to that pre-existing branch
# without creating its own.
#
# Without this hook, SWE creates the branch as part of `git worktree add -B
# <name> ...` and may abbreviate / mis-name it (observed in h5 dogfood:
# task spec `fix/foo-typo-receive` → SWE created `fix/typo-foo-ts`),
# breaking the push gate's `tasks.branch_id` ↔ git-branch lookup.
#
# Allowed:  git worktree add .claude/worktrees/<slug> <existing-branch>
# Blocked:  git worktree add -b NAME ... | git worktree add -B NAME ...
#
# Bypass: TMB_ALLOW_WORKTREE_BRANCH_CREATE=1 (emergency override).
#
# Silent pass-through when:
#   - tool isn't Bash
#   - command isn't `git worktree add ...`
#   - DB doesn't exist (not a TMB project)
#   - bypass env is set

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

if [ "${TMB_ALLOW_WORKTREE_BRANCH_CREATE:-0}" = "1" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$CMD" ] || exit 0

case "$CMD" in
  *"git worktree add"*) ;;
  *) exit 0 ;;
esac

case "$CMD" in
  *"git worktree add -b "*|*"git worktree add -B "*|*"git worktree add --create-branch "*) ;;
  *) exit 0 ;;
esac

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || REPO_ROOT="$PWD"
  DB_PATH="$REPO_ROOT/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0

REASON="BLOCKED: \`git worktree add\` cannot create a branch (-b/-B). Branch authority belongs to bro: bro creates the branch first via \`git branch <task.branch_id> HEAD\`, then SWE attaches the worktree with \`git worktree add <path> <branch>\` (no -b/-B). Without this rule, SWE may invent a different branch name than the spec (\`tasks.branch_id\`), breaking the push-gate lookup. Bypass: TMB_ALLOW_WORKTREE_BRANCH_CREATE=1."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
