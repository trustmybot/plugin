#!/usr/bin/env bash
# PreToolUse hook. Blocks two foot-gun forms of `git worktree add`:
#
# 1. `--branch -b|-B|--create-branch` (#170). Branch authority belongs to bro:
#    the branch must be created BEFORE the worktree (via `git branch
#    <task.branch_id> HEAD` from bro's session). `git worktree add` must
#    attach the worktree to that pre-existing branch without creating its
#    own — otherwise SWE may invent a different branch name (observed:
#    spec `fix/foo-typo-receive` → SWE created `fix/typo-foo-ts`),
#    breaking the push gate's `tasks.branch_id` ↔ git-branch lookup.
#
# 2. `--detach` (#2869). Detached-HEAD worktrees strand SWE's commits off
#    the branch ref: pushes upload empty branches, MRs open with no diff.
#    Force a plain `git worktree add <path> <branch>` so commits advance
#    the branch ref naturally.
#
# Allowed:  git worktree add .claude/worktrees/<slug> <existing-branch>
# Blocked:  git worktree add -b|-B|--create-branch NAME ... |
#           git worktree add --detach ...
#
# Bypass:
#   - TMB_ALLOW_WORKTREE_BRANCH_CREATE=1 — bypass branch-create check (#170)
#   - TMB_ALLOW_WORKTREE_DETACH=1         — bypass detach check (#2869)
#
# Silent pass-through when:
#   - tool isn't Bash
#   - command isn't `git worktree add ...`
#   - DB doesn't exist (not a TMB project)

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$CMD" ] || exit 0

case "$CMD" in
  *"git worktree add"*) ;;
  *) exit 0 ;;
esac

VIOLATION=""
case "$CMD" in
  *"git worktree add -b "*|*"git worktree add -B "*|*"git worktree add --create-branch "*)
    [ "${TMB_ALLOW_WORKTREE_BRANCH_CREATE:-0}" = "1" ] || VIOLATION="branch-create"
    ;;
esac

if [ -z "$VIOLATION" ]; then
  case "$CMD" in
    *"git worktree add"*"--detach"*)
      [ "${TMB_ALLOW_WORKTREE_DETACH:-0}" = "1" ] || VIOLATION="detach"
      ;;
  esac
fi

[ -n "$VIOLATION" ] || exit 0

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

if [ "$VIOLATION" = "branch-create" ]; then
  REASON="BLOCKED: \`git worktree add\` cannot create a branch (-b/-B/--create-branch). Branch authority belongs to bro: bro creates the branch first via \`git branch <task.branch_id> HEAD\`, then SWE attaches the worktree with \`git worktree add <path> <branch>\` (no -b/-B). Without this rule, SWE may invent a different branch name than the spec (\`tasks.branch_id\`), breaking the push-gate lookup. Bypass: TMB_ALLOW_WORKTREE_BRANCH_CREATE=1."
else
  REASON="BLOCKED: \`git worktree add --detach\` strands SWE's commits on a detached HEAD instead of advancing the branch ref. Pushes then upload an empty branch and MRs open with no diff (#2869). Use a plain \`git worktree add <path> <branch>\` so commits advance the named branch naturally. Bypass: TMB_ALLOW_WORKTREE_DETACH=1."
fi

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
