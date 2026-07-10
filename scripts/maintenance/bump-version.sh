#!/usr/bin/env bash
# Atomic plugin-version bump. Updates the three manifests plus the bun.lock
# workspace entry that must stay in sync, or fails leaving every file
# unchanged. Idempotent — re-running with the same version is a no-op.
#
# Usage:
#   bash scripts/maintenance/bump-version.sh <new-version>
#
# Touches:
#   1. .claude-plugin/plugin.json                         "version"
#   2. package.json                                       "version"
#   3. mcp/trajectory-server/package.json                 "version"
#   4. bun.lock                                           workspace "version"
#
# mcp/trajectory-server/src/index.ts derives the version from package.json
# at runtime (readFileSync → packageVersion) and is not touched.

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
  "bun.lock"
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
  # Occurrence guard: exactly one version field must carry the current version.
  # A dependency line could coincidentally share the version string, so abort
  # on zero or multiple candidate lines — leaving every file untouched.
  local candidates
  candidates="$(grep -Ec "\"version\"[[:space:]]*:[[:space:]]*\"$CURRENT\"" "$src" || true)"
  if [ "$candidates" -ne 1 ]; then
    echo "Error: failed to bump $src — expected exactly one \"version\": \"$CURRENT\" line, found $candidates" >&2
    return 1
  fi
  # Match: "version": "X.Y.Z[-pre]" — only the version field; leading
  # indentation precedes the match and is preserved (bun.lock nests deeper).
  sed -E "s/\"version\"[[:space:]]*:[[:space:]]*\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$src" > "$dst"
  if ! grep -q "\"version\": \"$NEW_VERSION\"" "$dst"; then
    echo "Error: failed to bump $src — no version line matched" >&2
    return 1
  fi
}

bump_json    .claude-plugin/plugin.json                "$TMP_DIR/plugin.json"
bump_json    package.json                              "$TMP_DIR/root-package.json"
bump_json    mcp/trajectory-server/package.json        "$TMP_DIR/trajectory-package.json"
bump_json    bun.lock                                  "$TMP_DIR/bun.lock"

# All edits staged successfully — commit them.
mv "$TMP_DIR/plugin.json"             .claude-plugin/plugin.json
mv "$TMP_DIR/root-package.json"       package.json
mv "$TMP_DIR/trajectory-package.json" mcp/trajectory-server/package.json
mv "$TMP_DIR/bun.lock"                bun.lock

echo "Bumped $CURRENT → $NEW_VERSION across 4 files."
echo "Next: rebuild MCP server, run tests, commit."
