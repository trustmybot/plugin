#!/usr/bin/env bash
# Local convenience wrapper for the Release canary Docker test (formerly L5+L5 combined, #112).
#
# Usage:
#   export CLAUDE_CODE_OAUTH_TOKEN=...    # required for the L5 piece
#   bash tests/docker/run-release-canary.sh
#
# Without the token: builds the image (L0 install assertions only),
#   skips the L5 run with a notice. Useful for verifying install changes
#   without burning Claude tokens.
#
# With the token: full L0 install + L5 multi-scorer flows. The token is
#   passed via Docker BuildKit secret (mounted at /run/secrets/cc_token,
#   not baked into image layers).
#
# Build success = release shippable + workflow doctrine intact.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PLUGIN_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  printf "❌ docker not found. Install Docker Desktop or run via CI.\n" >&2
  exit 1
fi

VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
IMAGE_TAG="tmb-release-canary:${VERSION}"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "⚠️  CLAUDE_CODE_OAUTH_TOKEN not set — building install-only (L0 piece).\n"
  printf "   To run the L5 piece too, export the token first.\n\n"

  DOCKER_BUILDKIT=1 docker build \
    --build-arg "PLUGIN_VERSION=${VERSION}" \
    -f tests/docker/release-canary.Dockerfile \
    -t "$IMAGE_TAG" \
    --progress=plain \
    .
else
  printf "Building %s with CLAUDE_CODE_OAUTH_TOKEN secret (L0 + L5 flows)...\n\n" "$IMAGE_TAG"

  DOCKER_BUILDKIT=1 docker build \
    --secret id=cc_token,env=CLAUDE_CODE_OAUTH_TOKEN \
    --build-arg "PLUGIN_VERSION=${VERSION}" \
    -f tests/docker/release-canary.Dockerfile \
    -t "$IMAGE_TAG" \
    --progress=plain \
    .
fi

printf "\n✓ Release canary check passed.\n"
