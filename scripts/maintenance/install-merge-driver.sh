#!/usr/bin/env bash
# Installs the tmb-regen git merge driver into one repo's own config
# (.git/config, shared by its worktrees) — never --global.
#
# Usage: bash scripts/maintenance/install-merge-driver.sh [repo-dir]
#   (default: the main checkout of the repo holding this script, never the cwd)
#
# .gitattributes routes the generated artefacts (mcp/trajectory-server/dist/**,
# scripts/hooks/lib/audit-events.txt, scripts/hooks/lib/data-contracts.json)
# to merge=tmb-regen. On a merge, rebase or cherry-pick that touches them on
# both sides, the driver keeps ours (%A already holds it, so the result is %A
# unchanged), exits 0 and names the file on stderr; one
# `bash scripts/maintenance/regen-generated.sh` then rebuilds every artefact
# from the merged sources. Idempotent.

set -euo pipefail

REPO="${1:-}"
if [ -z "$REPO" ]; then
  SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  COMMON_DIR="$(git -C "$SELF_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -z "$COMMON_DIR" ]; then
    echo "install-merge-driver: $SELF_ROOT is not in a git repository; pass the repo dir" >&2
    exit 1
  fi
  REPO="$(dirname "$COMMON_DIR")"
fi
if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-merge-driver: $REPO is not a git repository" >&2
  exit 1
fi

git -C "$REPO" config --local merge.tmb-regen.name \
  'TMB generated artefact: keep ours, regenerate after the merge'
git -C "$REPO" config --local merge.tmb-regen.driver \
  "sh -c 'echo \"tmb-regen: kept ours for \$1 — run: bash scripts/maintenance/regen-generated.sh\" >&2' tmb-regen %P"

echo "install-merge-driver: merge.tmb-regen installed in $(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git -C "$REPO" rev-parse --git-common-dir)/config"
