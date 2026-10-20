#!/usr/bin/env bash
# Local wrapper for the L0 upgrade smoke (GH 1465).
#
# Usage:
#   bash tests/l0-install/run-upgrade-smoke.sh
#
# Archives the v1.0.2 tag from this repo into a temp dir, passes it to
# tests/l0-install/upgrade-smoke.Dockerfile as the `v102` build context, and
# builds from the plugin root. Build success = a real-shape v1.0.2 DB upgraded
# by the current server passes trajectory-doctor.

set -euo pipefail

OLD_TAG=v1.0.2
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PLUGIN_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  printf "❌ docker not found. Install Docker Desktop or run via CI.\n" >&2
  exit 1
fi

if ! git rev-parse -q --verify "refs/tags/${OLD_TAG}" >/dev/null; then
  printf "❌ tag %s not found. Run: git fetch origin tag %s\n" "$OLD_TAG" "$OLD_TAG" >&2
  exit 1
fi

OLD_TREE="$(mktemp -d "${TMPDIR:-/tmp}/tmb-run-upgrade-smoke.XXXXXX")"
trap 'rm -rf "$OLD_TREE"' EXIT
git archive "$OLD_TAG" | tar -x -C "$OLD_TREE"

IMAGE_TAG="tmb-upgrade-smoke:$(jq -r '.version' .claude-plugin/plugin.json)"

printf "Building %s: %s DB upgraded by the current tree...\n\n" "$IMAGE_TAG" "$OLD_TAG"
DOCKER_BUILDKIT=1 docker build \
  -f tests/l0-install/upgrade-smoke.Dockerfile \
  --build-context "v102=${OLD_TREE}" \
  -t "$IMAGE_TAG" \
  --progress=plain \
  .

printf "\n✓ Layer 0 upgrade-smoke passed. A %s DB upgrades cleanly.\n" "$OLD_TAG"
