#!/usr/bin/env bash
# Library: workspace-root resolution for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.

# tmb_workspace_root <db_path>
# Prints the workspace root: dirname of dirname of dirname of the DB path.
# DB lives at <workspace_root>/.claude/<plugin>/trajectory.db, so three
# dirname calls resolve back to the workspace root.
#
# Sentinel fallback: if the DB-derived workspace does not have the expected
# .claude/worktrees/<slug> directory, the caller should fall back to the
# active-workspace sentinel file at ${HOME}/.claude/${plugin}-active-workspace
# (first line = workspace root). That fallback belongs to the caller because
# it requires a slug to verify — this function only does the DB-path math.
#
# Single-repo installs: DB at <repo>/.claude/<plugin>/trajectory.db →
# dirname×3 == repo root == workspace root. Unaffected.
tmb_workspace_root() {
  local db_path="${1:-}"
  if [ -z "$db_path" ]; then
    return 0
  fi
  dirname "$(dirname "$(dirname "$db_path")")" 2>/dev/null || true
}
