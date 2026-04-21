#!/usr/bin/env bash
# WorktreeCreate hook — branches from current HEAD, not origin/main.
# Workaround for Claude Code issues #27134 and #44965: worktree_add defaults
# to origin/HEAD which is main, not the current branch the user is on.
#
# Receives JSON on stdin with a "name" field, prints worktree path on stdout.
set -euo pipefail

WORKTREE_NAME=$(jq -r '.name')
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.claude/worktrees/${WORKTREE_NAME}"
BRANCH_NAME="worktree-${WORKTREE_NAME}"

mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" HEAD

echo "$WORKTREE_DIR"
