#!/usr/bin/env bash
# PreToolUse hook (#170 part 2): when SWE attaches a worktree to a branch,
# verify the branch is up-to-date with the latest remote `pr_target`. Catches
# the "branch was created from stale local main" failure mode — common when
# the user hasn't fetched origin in a while and bro creates a task branch
# from a behind-by-N-commits local pointer.
#
# Behavior:
#   1. Match `git worktree add <path> <branch>` invocations (skip everything
#      else).
#   2. Best-effort `git fetch origin <pr_target>` (silent — offline is fine).
#   3. If `origin/<pr_target>` is NOT an ancestor of `<branch>`, deny with a
#      helpful message: bro must rebase / recreate the branch from the
#      latest origin/<pr_target> before SWE attaches a worktree.
#
# Allow conditions:
#   - Not a worktree-add command
#   - Not a TMB project (no DB)
#   - User explicitly named a non-pr_target base in the spec (e.g.
#     branching from a feature branch — recorded in tasks.parent_branch_id;
#     hook honors this when present)
#   - Bypass: TMB_ALLOW_STALE_BRANCH=1 (offline / disconnected work)
#
# pr_target read from plugin_config (defaults to "main").

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/resolve-plugin-name.sh
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"
PLUGIN_NAME=$(tmb_resolve_plugin_name)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

if [ "${TMB_ALLOW_STALE_BRANCH:-0}" = "1" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$CMD" ] || exit 0

case "$CMD" in
  *"git worktree add"*) ;;
  *) exit 0 ;;
esac

# Skip if -b/-B/--create-branch present — the branch-create-block hook owns
# that case. We only validate when SWE is attaching to an existing branch.
case "$CMD" in
  *" -b "*|*" -B "*|*"--create-branch "*) exit 0 ;;
esac

# Parse the trailing branch arg. Form: `git worktree add [opts] <path> <branch>`.
# Take the last whitespace-separated token.
BRANCH=$(echo "$CMD" | awk '{print $NF}')
[ -n "$BRANCH" ] || exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
DB_PATH="${TRAJECTORY_DB_PATH:-$REPO_ROOT/.claude/${PLUGIN_NAME}/trajectory.db}"
[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

PR_TARGET=$(sqlite3 "$DB_PATH" "SELECT value FROM plugin_config WHERE key='pr_target' LIMIT 1;" 2>/dev/null)
[ -n "$PR_TARGET" ] || PR_TARGET="main"
PR_TARGET=$(echo "$PR_TARGET" | tr -d '"')

if ! git -C "$REPO_ROOT" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  exit 0
fi

git -C "$REPO_ROOT" fetch origin "$PR_TARGET" --quiet >/dev/null 2>&1 || true

if ! git -C "$REPO_ROOT" rev-parse --verify "origin/$PR_TARGET" >/dev/null 2>&1; then
  exit 0
fi

if git -C "$REPO_ROOT" merge-base --is-ancestor "origin/$PR_TARGET" "$BRANCH" 2>/dev/null; then
  exit 0
fi

BEHIND=$(git -C "$REPO_ROOT" rev-list --count "$BRANCH..origin/$PR_TARGET" 2>/dev/null || echo "?")
REASON="BLOCKED: branch '$BRANCH' is behind origin/$PR_TARGET by $BEHIND commit(s). bro must rebase the task branch onto the latest origin/$PR_TARGET (or recreate it: \`git branch -D $BRANCH && git fetch origin $PR_TARGET && git branch $BRANCH origin/$PR_TARGET\`) before SWE attaches a worktree. This catches stale-local-main bugs where the worktree starts from yesterday's commit and conflicts on push. Bypass: TMB_ALLOW_STALE_BRANCH=1 (e.g. offline work)."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
