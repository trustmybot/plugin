#!/usr/bin/env bash
# One-time cleanup: remove repo-rooted SWE worktrees left over from before
# #110 Phase 3 moved them to workspace-rooted paths. Idempotent — safe to
# re-run; no-ops once all stale worktrees are gone.
#
# Usage:
#   bash scripts/maintenance/cleanup-stale-worktrees.sh
#
# Removes:
#   - <repo>/.claude/worktrees/<slug>/ directories whose worktree refs point
#     to merged commits (i.e. their branches no longer exist or are merged
#     into the configured pr_target).
#   - The corresponding entries from <repo>/.git/worktrees/.
#
# Does NOT touch:
#   - Worktrees with active uncommitted changes
#   - Worktrees on branches that don't exist locally (pre-existing user state)
#   - Workspace-rooted worktrees (those are current; not stale)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not in a git repo"
  exit 1
}

WORKTREES_DIR="$REPO_ROOT/.claude/worktrees"
[ -d "$WORKTREES_DIR" ] || {
  echo "No $WORKTREES_DIR — nothing to clean"
  exit 0
}

echo "Scanning $WORKTREES_DIR for stale repo-rooted worktrees..."

removed=0
git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}' | \
while IFS= read -r wt_path; do
  # Only act on worktrees inside <repo>/.claude/worktrees/
  case "$wt_path" in
    "$WORKTREES_DIR"/*) ;;
    *) continue ;;
  esac

  # Skip if the worktree has uncommitted changes
  if [ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ]; then
    echo "  SKIP $wt_path — uncommitted changes"
    continue
  fi

  echo "  REMOVE $wt_path"
  git -C "$REPO_ROOT" worktree remove --force "$wt_path" 2>/dev/null || {
    echo "    git worktree remove failed; manual cleanup may be needed"
    continue
  }
  removed=$((removed + 1))
done

# Prune any leftover .git/worktrees/ entries
git -C "$REPO_ROOT" worktree prune
echo "Pruned dangling worktree refs"

# Final tidy: remove the worktrees dir if it's empty
if [ -d "$WORKTREES_DIR" ] && [ -z "$(ls -A "$WORKTREES_DIR" 2>/dev/null)" ]; then
  rmdir "$WORKTREES_DIR"
  echo "Removed empty $WORKTREES_DIR"
fi
