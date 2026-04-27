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

# Manual smoke gate (formerly 'L5 manual dogfood'). The release script refuses
# to tag without an explicit signed-off env var matching this exact version.
# See tests/manual/scenarios.md for the checklist that produces this sign-off.
#
# Note: Release canary (was 'L5+L6 combined') replaces manual smoke for almost
# everything. Manual smoke remains as a fallback for UX scenarios that the
# automated layer can't model (e.g. interactive AskUserQuestion responses).
#
# Bypass for hotfix releases that don't change Claude-side behavior:
# set BYPASS_DOGFOOD=1 with a justification in the commit log.
if [ "${BYPASS_DOGFOOD:-0}" = "1" ]; then
  printf "⚠️  Manual smoke gate BYPASSED (BYPASS_DOGFOOD=1).\n"
  printf "    This is acceptable for hotfix releases that don't touch Claude-side\n"
  printf "    behavior (agents/skills/CLAUDE.md). Document the bypass reason in the\n"
  printf "    release commit message.\n\n"
elif [ "${MANUAL_DOGFOOD_PASSED:-}" = "$NEW_TAG" ]; then
  printf "✓ Manual smoke passed for %s (MANUAL_DOGFOOD_PASSED matches).\n\n" "$NEW_TAG"
else
  printf "❌ Refusing to tag. Manual smoke not signed off for %s.\n" "$NEW_TAG" >&2
  printf "\n" >&2
  printf "   Walk through the checklist at tests/manual/scenarios.md, then re-run with:\n" >&2
  printf "     export MANUAL_DOGFOOD_PASSED=%s && bash scripts/release.sh\n" "$NEW_TAG" >&2
  printf "\n" >&2
  printf "   For hotfix releases that don't change Claude-side behavior:\n" >&2
  printf "     BYPASS_DOGFOOD=1 bash scripts/release.sh    # justify in commit message\n" >&2
  if [ -n "${MANUAL_DOGFOOD_PASSED:-}" ]; then
    printf "\n   (MANUAL_DOGFOOD_PASSED is set to '%s' but plugin version is '%s' — version drift.)\n" \
      "$MANUAL_DOGFOOD_PASSED" "$NEW_TAG" >&2
  fi
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
    # The local tag exists but points elsewhere. Before offering to move it,
    # check whether it's already published to the remote. If yes — REFUSE.
    # Re-tagging a published release is the antipattern that breaks every
    # downstream consumer's pinning + the marketplace cache. The discipline
    # is "bump the version and ship a new tag" (e.g. v0.2.0 broken → v0.2.1).
    REMOTE_TAG_SHA="$(git ls-remote --tags origin "refs/tags/$NEW_TAG" 2>/dev/null | awk '{print $1}')"
    if [ -n "$REMOTE_TAG_SHA" ]; then
      printf "❌ Refusing to re-tag a PUBLISHED release.\n" >&2
      printf "\n" >&2
      printf "  %s is already on origin (sha=%s).\n" "$NEW_TAG" "${REMOTE_TAG_SHA:0:8}" >&2
      printf "  Re-tagging breaks every consumer that pinned to this version,\n" >&2
      printf "  silently corrupts marketplace caches, and destroys the audit trail.\n" >&2
      printf "\n" >&2
      printf "  If you found a bug in %s, ship a NEW version with the fix:\n" "$NEW_TAG" >&2
      printf "    1. Bump plugin.json + mcp pkg.json + root pkg.json to v%s.<next-patch>\n" "${NEW_VERSION%.*}" >&2
      printf "    2. Add a CHANGELOG section for the new version\n" >&2
      printf "    3. PR through dev → main → bash scripts/release.sh\n" >&2
      printf "\n" >&2
      printf "  Optionally annotate the broken release on GitHub:\n" >&2
      printf "    gh release edit %s --notes \"⚠️  Known bug: <describe>. Upgrade to v...\"\n" "$NEW_TAG" >&2
      exit 1
    fi
    printf "  ⚠️  Local-only %s exists at %s but points at %s, not main HEAD %s.\n" \
      "$NEW_TAG" "${EXISTING_TAG_TARGET:0:8}" "${EXISTING_TAG_TARGET:0:8}" "${LOCAL_HEAD:0:8}"
    printf "      (Not on origin yet — local-only retag is safe.)\n"
    if confirm "  Move $NEW_TAG to current main HEAD?"; then
      git tag -d "$NEW_TAG"
      git tag -a "$NEW_TAG" -m "$NEW_TAG"
      printf "  ✓ %s re-tagged locally on %s\n\n" "$NEW_TAG" "${LOCAL_HEAD:0:8}"
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

# ---------- step 4: L5 release canary (post-tag verify) ----------
#
# Re-clones the freshly-tagged release into a temp dir and runs the
# install-smoke Dockerfile against it. Catches "the published artifact
# differs from what we tested locally" — e.g. a .gitignore that excluded
# something the install needs.
#
# Skipped if Docker is unavailable; warning instead of failure since the
# release is already public at this point.

if confirm "Step 4: Run L5 release canary (re-clone tag in Docker, run install-smoke)?"; then
  if ! command -v docker >/dev/null 2>&1; then
    printf "  ⊘ docker not available — skipping canary. Run manually before announcing the release:\n"
    printf "      bash tests/docker/run-install-smoke.sh\n"
  else
    CANARY_DIR=$(mktemp -d -t tmb-canary-XXXX)
    trap 'rm -rf "$CANARY_DIR"' EXIT
    printf "  Cloning %s into %s ...\n" "$NEW_TAG" "$CANARY_DIR"
    if git clone --quiet --depth 1 --branch "$NEW_TAG" \
        "https://github.com/trustmybot/plugin.git" "$CANARY_DIR/plugin"; then
      if (cd "$CANARY_DIR/plugin" && docker build \
            -f tests/docker/install-smoke.Dockerfile \
            -t "tmb-canary-$NEW_VERSION" \
            --quiet .); then
        printf "  ✓ Canary PASSED — published %s installs cleanly from a fresh clone\n\n" "$NEW_TAG"
      else
        printf "\n  ⚠️  CANARY FAILED — published %s does NOT install cleanly!\n" "$NEW_TAG" >&2
        printf "     The release is public but broken. Investigate before announcing.\n" >&2
        printf "     Likely causes: .gitignore excluded something needed; postinstall regression;\n" >&2
        printf "     bun.lock out of sync; etc.\n" >&2
        exit 1
      fi
    else
      printf "  ⚠️  Could not clone tag %s — release exists but git clone failed.\n" "$NEW_TAG" >&2
    fi
  fi
else
  printf "  Skipped — run 'bash tests/docker/run-install-smoke.sh' manually before announcing.\n\n"
fi

# ---------- summary ----------

printf "Done. Verify:\n"
printf "  - https://github.com/trustmybot/plugin/releases/tag/%s\n" "$NEW_TAG"
printf "  - git ls-remote --tags origin | grep %s\n" "$NEW_TAG"
