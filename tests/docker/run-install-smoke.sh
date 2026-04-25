#!/usr/bin/env bash
# Local convenience wrapper for the L0 install-smoke Docker test.
#
# Usage:
#   bash tests/docker/run-install-smoke.sh
#
# Builds tests/docker/install-smoke.Dockerfile from the plugin root.
# Build success = a fresh marketplace install would boot cleanly.
# Build failure = release-blocker; a real user would hit it.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PLUGIN_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  printf "❌ docker not found. Install Docker Desktop or run via CI.\n" >&2
  exit 1
fi

IMAGE_TAG="tmb-install-smoke:$(jq -r '.version' .claude-plugin/plugin.json)"

printf "Building %s from a clean tree (this strips dist/ + node_modules first)...\n\n" "$IMAGE_TAG"
docker build \
  -f tests/docker/install-smoke.Dockerfile \
  -t "$IMAGE_TAG" \
  --progress=plain \
  .

printf "\n✓ Layer 0 install-smoke passed. A fresh marketplace install would boot.\n"
