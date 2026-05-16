#!/usr/bin/env bash
# Atomic plugin-version bump. Updates the four locations that must stay in
# sync, or fails leaving every file unchanged. Idempotent — re-running with
# the same version is a no-op.
#
# Usage:
#   bash scripts/maintenance/bump-version.sh <new-version>
#
# Touches:
#   1. .claude-plugin/plugin.json                         "version"
#   2. package.json                                       "version"
#   3. mcp/trajectory-server/package.json                 "version"
#   4. mcp/trajectory-server/src/index.ts                 serverLog startup version
#
# Does NOT touch the MCP `Server({version: 'X.Y.Z'})` literal in index.ts —
# that's the trajectory-server protocol-handshake version, independent of
# the plugin version.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <new-version>" >&2
  exit 1
fi

NEW_VERSION="$1"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
if ! [[ "$NEW_VERSION" =~ $SEMVER_RE ]]; then
  echo "Error: '$NEW_VERSION' is not valid SemVer (X.Y.Z or X.Y.Z-pre)" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FILES=(
  ".claude-plugin/plugin.json"
  "package.json"
  "mcp/trajectory-server/package.json"
  "mcp/trajectory-server/src/index.ts"
)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "Error: missing $f" >&2; exit 1; }
done

# Read current version from plugin.json as the source of truth.
# BSD sed (macOS) does not support `\s`; use [[:space:]] for portability.
CURRENT="$(grep -E '"version"[[:space:]]*:[[:space:]]*"' .claude-plugin/plugin.json | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ -z "$CURRENT" ]; then
  echo "Error: could not read current version from .claude-plugin/plugin.json" >&2
  exit 1
fi

if [ "$CURRENT" = "$NEW_VERSION" ]; then
  echo "Already at $NEW_VERSION — no changes needed."
  exit 0
fi

# Stage edits to tempfiles, then move them all into place atomically.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

bump_json() {
  local src="$1" dst="$2"
  # Match: "version": "X.Y.Z[-pre]" — only the version field at the top level.
  sed -E "s/\"version\"[[:space:]]*:[[:space:]]*\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$src" > "$dst"
  if ! grep -q "\"version\": \"$NEW_VERSION\"" "$dst"; then
    echo "Error: failed to bump $src — no version line matched" >&2
    return 1
  fi
}

bump_index_ts() {
  local src="$1" dst="$2"
  # Match the serverLog startup version literal only — leaves the MCP
  # Server constructor's version untouched.
  sed -E "s/(serverLog\(\{[^}]*version:[[:space:]]*)'$CURRENT'/\1'$NEW_VERSION'/" "$src" > "$dst"
  if ! grep -q "version: '$NEW_VERSION'" "$dst"; then
    echo "Error: failed to bump $src — no serverLog version matched" >&2
    return 1
  fi
}

bump_json    .claude-plugin/plugin.json                "$TMP_DIR/plugin.json"
bump_json    package.json                              "$TMP_DIR/root-package.json"
bump_json    mcp/trajectory-server/package.json        "$TMP_DIR/trajectory-package.json"
bump_index_ts mcp/trajectory-server/src/index.ts       "$TMP_DIR/index.ts"

# All edits staged successfully — commit them.
mv "$TMP_DIR/plugin.json"             .claude-plugin/plugin.json
mv "$TMP_DIR/root-package.json"       package.json
mv "$TMP_DIR/trajectory-package.json" mcp/trajectory-server/package.json
mv "$TMP_DIR/index.ts"                mcp/trajectory-server/src/index.ts

echo "Bumped $CURRENT → $NEW_VERSION across 4 files."
echo "Next: rebuild MCP server, run tests, commit."
