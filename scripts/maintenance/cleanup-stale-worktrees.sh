#!/usr/bin/env bash
# No-op. Repo-rooted SWE worktrees (<repo>/.claude/worktrees/<slug>) are the
# CANONICAL layout — created by ensure-swe-worktree.sh / MCP task_provision and
# resolved by every closer. This script once pruned them as "stale" during the
# (now-reversed) #110 Phase 3 migration toward workspace-rooted paths; running
# that pruning today would delete LIVE worktrees, so it is intentionally inert.
#
# Usage:
#   bash scripts/maintenance/cleanup-stale-worktrees.sh
#
# Removes: nothing. Exits 0.

set -euo pipefail

echo "cleanup-stale-worktrees: no-op — repo-rooted worktrees are canonical (the #110 Phase 3 migration was reversed); nothing to clean."
exit 0
