#!/usr/bin/env bash
# scripts/release.sh — cut a release from main.
#
# Run AFTER `dev` is merged into `main` and the merge has landed
# the version bump in plugin.json + a matching CHANGELOG entry.
#
# Usage:
#   git checkout main && git pull origin main
#   bash scripts/release.sh
#
# What it does (each step asks for explicit y/N + skips if already done):
#   1. Tag main HEAD as v<plugin.json version>
#   2. Push the tag to origin
#   3. Create the GitHub release with notes extracted from CHANGELOG.md
#
# Idempotent + safety-checked:
#   - Refuses to run unless current branch is `main`.
#   - Refuses to run unless the tree is clean and synced with origin/main.
#   - Refuses to run unless plugin.json version matches a v<version>
#     section in CHANGELOG.md (catches release-prep merges that didn't land).
#   - Refuses to run if mcp pkg.json version disagrees with plugin.json.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PLUGIN_ROOT"

# ---------- read version from plugin.json (single source of truth) ----------

if ! command -v jq >/dev/null 2>&1; then
  printf "❌ jq is required.\n" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  printf "❌ gh CLI is required.\n" >&2
  exit 1
fi

NEW_VERSION="$(jq -r '.version' .claude-plugin/plugin.json)"
NEW_TAG="v${NEW_VERSION}"

# ---------- safety checks ----------

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  printf "❌ Refusing to run. Current branch: %s — must be 'main'.\n" "$CURRENT_BRANCH" >&2
  printf "   Run: git checkout main && git pull origin main\n" >&2
  exit 1
fi

if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  printf "❌ Refusing to run. Working tree has uncommitted changes.\n" >&2
  exit 1
fi

git fetch origin --quiet
LOCAL_HEAD="$(git rev-parse main)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  printf "❌ Refusing to run. Local main (%s) != origin/main (%s).\n" "${LOCAL_HEAD:0:8}" "${REMOTE_HEAD:0:8}" >&2
  printf "   Run: git pull origin main\n" >&2
  exit 1
fi

MCP_VERSION="$(jq -r '.version' mcp/trajectory-server/package.json)"
if [ "$MCP_VERSION" != "$NEW_VERSION" ]; then
  printf "❌ Refusing to run. mcp/trajectory-server/package.json version is %s — expected %s (from plugin.json).\n" "$MCP_VERSION" "$NEW_VERSION" >&2
  printf "   Bump both in the same release-prep PR.\n" >&2
  exit 1
fi

if ! grep -q "^## ${NEW_TAG} " CHANGELOG.md; then
  printf "❌ Refusing to run. CHANGELOG.md has no '## %s' section.\n" "$NEW_TAG" >&2
  printf "   Either the dev → main merge didn't land the release-prep commit,\n" >&2
  printf "   or you forgot to add the CHANGELOG entry.\n" >&2
  exit 1
fi

confirm() {
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

printf "✓ Pre-flight checks passed.\n"
printf "  Branch:        main @ %s\n" "${LOCAL_HEAD:0:8}"
printf "  Version:       %s (plugin.json + mcp pkg.json agree)\n" "$NEW_VERSION"
printf "  Tag to create: %s\n\n" "$NEW_TAG"

# ---------- step 1: tag main HEAD ----------

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  EXISTING_TAG_SHA="$(git rev-parse "$NEW_TAG")"
  EXISTING_TAG_TARGET="$(git rev-parse "${NEW_TAG}^{commit}" 2>/dev/null || echo "$EXISTING_TAG_SHA")"
  if [ "$EXISTING_TAG_TARGET" = "$LOCAL_HEAD" ]; then
    printf "  Step 1: %s already points at HEAD — skipping retag.\n\n" "$NEW_TAG"
  else
    printf "  ⚠️  %s exists but points at %s, not main HEAD %s.\n" "$NEW_TAG" "${EXISTING_TAG_TARGET:0:8}" "${LOCAL_HEAD:0:8}"
    if confirm "  Move $NEW_TAG to current main HEAD?"; then
      git tag -d "$NEW_TAG"
      git push origin ":refs/tags/$NEW_TAG" 2>/dev/null || true
      git tag -a "$NEW_TAG" -m "$NEW_TAG"
      printf "  ✓ %s re-tagged on %s\n\n" "$NEW_TAG" "${LOCAL_HEAD:0:8}"
    else
      printf "  Skipped — %s left where it is.\n\n" "$NEW_TAG"
    fi
  fi
else
  if confirm "Step 1: Tag main HEAD as $NEW_TAG?"; then
    git tag -a "$NEW_TAG" -m "$NEW_TAG"
    printf "  ✓ %s tagged on %s\n\n" "$NEW_TAG" "${LOCAL_HEAD:0:8}"
  else
    printf "  Skipped — exiting (downstream steps depend on the tag).\n"
    exit 1
  fi
fi

# ---------- step 2: push the tag ----------

REMOTE_TAG_SHA="$(git ls-remote --tags origin "refs/tags/$NEW_TAG" 2>/dev/null | awk '{print $1}')"
if [ -z "$REMOTE_TAG_SHA" ]; then
  if confirm "Step 2: Push $NEW_TAG to origin?"; then
    git push origin "$NEW_TAG"
    printf "  ✓ %s pushed\n\n" "$NEW_TAG"
  else
    printf "  Skipped — exiting (release-create needs the remote tag).\n"
    exit 1
  fi
else
  printf "  Step 2: %s already pushed to origin — skipping.\n\n" "$NEW_TAG"
fi

# ---------- step 3: create the GitHub release ----------

if gh release view "$NEW_TAG" >/dev/null 2>&1; then
  printf "  Step 3: GitHub release %s already exists — skipping.\n\n" "$NEW_TAG"
else
  if confirm "Step 3: Create GitHub release $NEW_TAG with the CHANGELOG body?"; then
    NOTES_FILE="$(mktemp -t tmb-release-notes.XXXXXX)"
    trap 'rm -f "$NOTES_FILE"' EXIT
    awk -v target="^## ${NEW_TAG} " '
      $0 ~ target { active = 1; next }
      active && /^## v[0-9]/ { exit }
      active && /^---[[:space:]]*$/ { next }
      active { print }
    ' CHANGELOG.md > "$NOTES_FILE"

    if [ ! -s "$NOTES_FILE" ]; then
      printf "❌ Failed to extract %s notes from CHANGELOG.md — aborting.\n" "$NEW_TAG" >&2
      exit 1
    fi

    gh release create "$NEW_TAG" \
      --title "$NEW_TAG" \
      --notes-file "$NOTES_FILE"
    printf "  ✓ GitHub release %s created\n\n" "$NEW_TAG"
  else
    printf "  Skipped.\n\n"
  fi
fi

# ---------- summary ----------

printf "Done. Verify:\n"
printf "  - https://github.com/trustmybot/plugin/releases/tag/%s\n" "$NEW_TAG"
printf "  - git ls-remote --tags origin | grep %s\n" "$NEW_TAG"
