#!/usr/bin/env bash
# Library: workspace-root resolution for TMB hooks.
# Sourced (not exec'd) by other hook scripts.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.

# tmb_workspace_root <db_path>
# Prints the workspace root: dirname of dirname of dirname of the DB path.
# DB lives at <workspace_root>/<host-dir>/<plugin>/<db-file>, so three
# dirname calls resolve back to the workspace root.
#
# Single-repo installs: DB at <repo>/<host-dir>/<plugin>/<db-file> →
# dirname×3 == repo root == workspace root. Unaffected.
tmb_workspace_root() {
  local db_path="${1:-}"
  if [ -z "$db_path" ]; then
    return 0
  fi
  dirname "$(dirname "$(dirname "$db_path")")" 2>/dev/null || true
}
