#!/usr/bin/env bash
# Lint: top CHANGELOG.md section's version must match plugin.json.
#
# Catches: release-prep PRs that bump plugin.json but forget to add the
# matching `## v<X.Y.Z>` section, OR forget to bump plugin.json after
# adding a new section.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CANON=$(jq -r '.version' .claude-plugin/plugin.json)
EXPECTED_HEADER="## v${CANON}"

# First `## vX.Y.Z` line in CHANGELOG (top of file)
TOP_HEADER=$(grep -m 1 -E '^## v[0-9]' CHANGELOG.md || true)

if [ -z "$TOP_HEADER" ]; then
  echo "✗ CHANGELOG.md has no '## v<X.Y.Z>' section at all" >&2
  exit 1
fi

# Extract just the "## vX.Y.Z" prefix (drops " — YYYY-MM-DD ..." trailer)
TOP_VERSION=$(echo "$TOP_HEADER" | awk '{print $1, $2}')

if [ "$TOP_VERSION" != "$EXPECTED_HEADER" ]; then
  echo "✗ CHANGELOG.md top section is '$TOP_HEADER'" >&2
  echo "  but plugin.json version is $CANON" >&2
  echo "  Expected top section to begin with: $EXPECTED_HEADER" >&2
  echo "" >&2
  echo "  Either bump plugin.json to match the top CHANGELOG section," >&2
  echo "  or add a new '$EXPECTED_HEADER — YYYY-MM-DD' entry to CHANGELOG." >&2
  exit 1
fi

echo "  ✓ CHANGELOG top section matches plugin.json version: $CANON"
echo ""
echo "Changelog-current: PASS"
