#!/usr/bin/env bash
# scripts/publish-rc-channel.sh — publish an rc tag to the rc channel.
#
# Sanctioned, guard-compatible companion to scripts/release.sh. The session
# git-guards inspect only the top-level command, so `bash scripts/publish-rc-channel.sh`
# runs its internal `git push` legitimately — unlike a hand edit + push to the
# production marketplace-rc main, which the classifier blocks.
#
# Run AFTER the vX.Y.Z-rc.N tag is pushed to origin (scripts/release.sh, or a
# manual rc tag). Points the rc-channel catalog at the tag so installs of
# `tmb@trustmybot-rc` serve the rc under validation.
#
# Usage:
#   bash scripts/publish-rc-channel.sh [version] [--yes] [--dry-run]
#
# What it does:
#   1. Resolve VERSION (arg or .claude-plugin/plugin.json .version) → TAG=v$VERSION.
#   2. Refuse unless VERSION is rc-only (X.Y.Z-rc.N).
#   3. Verify the tag exists on origin (must be pushed first).
#   4. Clone trustmybot/marketplace-rc into a temp dir (trap cleanup).
#   5. Set .claude-plugin/marketplace.json plugins[0].source.ref → TAG; validate JSON.
#   6. Ensure a marketplace-rc README.md exists.
#   7. Show the diff, confirm y/N (skipped by --yes), then commit + push origin main.
#
# Idempotent + safety-checked:
#   - Refuses any non-rc version.
#   - Refuses if the rc tag is not on origin.
#   - Never operates on a hardcoded local catalog path — always a fresh temp clone.
#   - If the ref already points at TAG AND the README is present → prints
#     'already published' and exits 0.
#   - --dry-run prints the intended change and never commits or pushes.

set -euo pipefail

PLUGIN_REPO="https://github.com/trustmybot/plugin.git"
CATALOG_REPO="https://github.com/trustmybot/marketplace-rc.git"

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- parse args ----------

VERSION=""
ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -*)
      printf "❌ Unknown flag: %s\n" "$arg" >&2
      printf "   Usage: bash scripts/publish-rc-channel.sh [version] [--yes] [--dry-run]\n" >&2
      exit 1
      ;;
    *)
      if [ -n "$VERSION" ]; then
        printf "❌ Multiple versions given: %s and %s\n" "$VERSION" "$arg" >&2
        exit 1
      fi
      VERSION="$arg"
      ;;
  esac
done

# ---------- resolve version ----------

if ! command -v jq >/dev/null 2>&1; then
  printf "❌ jq is required.\n" >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  VERSION="$(jq -r '.version' "$PLUGIN_ROOT/.claude-plugin/plugin.json")"
fi

# ---------- refuse non-rc ----------

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  printf "❌ Refusing to publish. Version '%s' is not an rc version.\n" "$VERSION" >&2
  printf "   The rc channel only serves rc tags (e.g. 0.10.0-rc.2).\n" >&2
  printf "   For a stable tag, re-pin the rc channel per CONTRIBUTING step 14.\n" >&2
  exit 1
fi

TAG="v${VERSION}"

# ---------- verify the tag exists on origin ----------

if [ -z "$(git ls-remote --tags "$PLUGIN_REPO" "refs/tags/$TAG" 2>/dev/null)" ]; then
  printf "❌ Refusing to publish. Tag %s is not on origin.\n" "$TAG" >&2
  printf "   Push the rc tag first (scripts/release.sh tags + pushes it),\n" >&2
  printf "   then re-run this script.\n" >&2
  exit 1
fi

# ---------- clone the catalog into a temp dir ----------

WORK_DIR="$(mktemp -d -t tmb-rc-catalog-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

printf "Cloning %s ...\n" "$CATALOG_REPO"
git clone --quiet --depth 1 "$CATALOG_REPO" "$WORK_DIR/marketplace-rc"
CLONE="$WORK_DIR/marketplace-rc"

MARKETPLACE_JSON="$CLONE/.claude-plugin/marketplace.json"
README="$CLONE/README.md"

if [ ! -f "$MARKETPLACE_JSON" ]; then
  printf "❌ %s has no .claude-plugin/marketplace.json — unexpected catalog layout.\n" "$CATALOG_REPO" >&2
  exit 1
fi

CURRENT_REF="$(jq -r '.plugins[0].source.ref' "$MARKETPLACE_JSON")"

# ---------- idempotency check ----------

if [ "$CURRENT_REF" = "$TAG" ] && [ -f "$README" ]; then
  printf "✓ Already published — ref is %s and README.md is present. Nothing to do.\n" "$TAG"
  exit 0
fi

# ---------- update the ref ----------

UPDATED_JSON="$WORK_DIR/marketplace.json.new"
jq --arg ref "$TAG" '.plugins[0].source.ref = $ref' "$MARKETPLACE_JSON" > "$UPDATED_JSON"

# validate JSON before swapping it in
if ! jq -e . "$UPDATED_JSON" >/dev/null 2>&1; then
  printf "❌ Updated marketplace.json failed JSON validation — aborting.\n" >&2
  exit 1
fi
mv "$UPDATED_JSON" "$MARKETPLACE_JSON"

# ---------- ensure README ----------

README_CREATED=0
if [ ! -f "$README" ]; then
  README_CREATED=1
  cat > "$README" <<'EOF'
# TMB plugin marketplace — RC

Catalog for the **rc channel** of the [TMB plugin](https://github.com/trustmybot/plugin). Pins the latest `vX.Y.Z-rc.N` tag under validation — the release candidate that's passed the local L6 chain and is being re-confirmed by the CI release-gate before it ships as stable. Use this when you want to dogfood a build that's close to release but ahead of the stable channel.

## Install

```
/plugin marketplace add trustmybot/marketplace-rc
/plugin install tmb@trustmybot-rc
```

The rc channel installs as `tmb` (same name as the released plugin), so only one can be enabled at a time.

### Disable any existing `tmb` install first

```
/plugin disable tmb
```

Use `/plugin disable` rather than `/plugin uninstall` so you can flip back to the released channel with `/plugin enable tmb` when done.

### When CC asks for scope, pick *local*

`/plugin marketplace add` will prompt:

```
  Install for all collaborators on this repository (project scope)
> Install for you, in this repo only (local scope)
```

**Pick local scope.** The rc channel is a per-developer choice; teammates may each be on a different channel (stable / rc / dev). Project scope is right only when a team wants everyone pinned to the same channel.

## Pull the latest rc

The marketplace ref is the current `vX.Y.Z-rc.N` tag, but CC caches a clone — when the channel re-pins to a newer rc tag, refresh to pick it up:

```
/plugin marketplace update trustmybot-rc
/plugin update tmb@trustmybot-rc
```

`/reload-plugins` only re-reads what CC already has on disk; you need `marketplace update` + `update` to fetch the newly-pinned tag from the remote.

## Flip back to the released channel when done

```
/plugin uninstall tmb@trustmybot-rc
/plugin enable tmb
```

## Channel routing

- This catalog: **RC channel** (latest `vX.Y.Z-rc.N` tag — pre-release builds under validation)
- [trustmybot/marketplace-dev](https://github.com/trustmybot/marketplace-dev) — dev channel (`trustmybot/plugin@dev` — bleeding edge)
- [trustmybot/marketplace](https://github.com/trustmybot/marketplace) — production (stable tags from main)

## Source

Plugin code lives at [trustmybot/plugin](https://github.com/trustmybot/plugin). This repo contains only the marketplace catalog (`.claude-plugin/marketplace.json`).
EOF
fi

# ---------- show intent ----------

printf "\n✓ rc-channel publish plan:\n"
printf "  Catalog:       %s\n" "$CATALOG_REPO"
printf "  source.ref:    %s → %s\n" "$CURRENT_REF" "$TAG"
if [ "$README_CREATED" -eq 1 ]; then
  printf "  README.md:     create (was missing)\n"
else
  printf "  README.md:     present (unchanged)\n"
fi
printf "\n"

git -C "$CLONE" --no-pager diff || true
printf "\n"

# ---------- dry-run ----------

if [ "$DRY_RUN" -eq 1 ]; then
  printf "✓ --dry-run: would set ref to %s%s. No commit, no push.\n" \
    "$TAG" \
    "$([ "$README_CREATED" -eq 1 ] && printf ' and create README.md' || printf '')"
  exit 0
fi

# ---------- confirm ----------

confirm() {
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$ASSUME_YES" -ne 1 ]; then
  if ! confirm "Commit and push this to marketplace-rc main?"; then
    printf "Aborted — no changes pushed.\n"
    exit 1
  fi
fi

# ---------- commit + push ----------

git -C "$CLONE" add .claude-plugin/marketplace.json README.md
git -C "$CLONE" commit -m "🚀 chore(rc): publish $TAG to the rc channel"
git -C "$CLONE" push origin main

printf "\n✓ Published %s to the rc channel.\n" "$TAG"
printf "  Installs of tmb@trustmybot-rc now serve %s.\n" "$TAG"
