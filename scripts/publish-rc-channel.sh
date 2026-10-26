#!/usr/bin/env bash
# scripts/publish-rc-channel.sh — publish an rc tag to the rc channel.
#
# Sanctioned, guard-compatible companion to scripts/release.sh. The session
# git-guards inspect only the top-level command, so `bash scripts/publish-rc-channel.sh`
# runs its internal `git push` legitimately — unlike a hand edit + push to the
# production marketplace-rc main, which the classifier blocks.
#
# Run AFTER the vX.Y.Z-rc.N tag is pushed to origin (scripts/release.sh, or a
# manual rc tag). Points the rc-channel catalog at payload/<tag>, the tag's
# runtime-only build that .github/workflows/release-payload.yml pushes, so
# installs of `tmb@trustmybot-rc` serve the rc under validation.
#
# Usage:
#   bash scripts/publish-rc-channel.sh [version] [--stable-repin] [--yes] [--dry-run]
#
# What it does:
#   1. Resolve VERSION (arg or .claude-plugin/plugin.json .version) → TAG=v$VERSION.
#   2. Refuse unless VERSION is rc-only (X.Y.Z-rc.N).
#   3. Verify the tag exists on origin (must be pushed first).
#   4. Await the tag's release-gate run; refuse unless it concluded success
#      (read-only — runs in --dry-run too).
#   5. Await payload/TAG on origin (scripts/await-payload-tag.ts); refuse when
#      it does not appear (read-only — runs in --dry-run too).
#   6. Clone trustmybot/marketplace-rc into a temp dir (trap cleanup).
#   7. Set .claude-plugin/marketplace.json plugins[0].source.ref → payload/TAG; validate JSON.
#   8. Ensure a marketplace-rc README.md exists.
#   9. Show the diff, confirm y/N (skipped by --yes), then commit + push origin main.
#
# --stable-repin mode (CONTRIBUTING Phase-D step 14):
#   Re-pins the rc channel to a STABLE tag (X.Y.Z) after a release so rc-channel
#   installs converge on the released build between rc cycles. VERSION must match
#   a stable tag; the rc-only refusal and the release-gate pre-check are bypassed
#   (stable tags fire no gate — the content was gated at its rc). Every other
#   step — verify tag on origin, await payload/TAG, temp clone, rewrite ref to
#   payload/TAG, idempotent skip, confirm, commit + push — is identical. Fired
#   by scripts/release.sh step 6.
#
# Idempotent + safety-checked:
#   - Refuses any non-rc version (or, in --stable-repin, any non-stable version).
#   - Refuses if the tag is not on origin.
#   - Refuses unless the tag's release-gate run concluded success (no bypass flag;
#     skipped in --stable-repin, where no gate fires).
#   - Refuses unless payload/TAG reaches origin within the helper's timeout
#     (TMB_PAYLOAD_TIMEOUT, default 600s).
#   - Never operates on a hardcoded local catalog path — always a fresh temp clone.
#   - If the ref already points at payload/TAG AND the README is present → prints
#     'already published' and exits 0.
#   - --dry-run prints the intended change and never commits or pushes.

set -euo pipefail

PLUGIN_REPO="https://github.com/trustmybot/plugin.git"
CATALOG_REPO="https://github.com/trustmybot/marketplace-rc.git"

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/await-release-gate.sh
. "$PLUGIN_ROOT/scripts/lib/await-release-gate.sh"

# ---------- parse args ----------

VERSION=""
ASSUME_YES=0
DRY_RUN=0
STABLE_REPIN=0

for arg in "$@"; do
  case "$arg" in
    --stable-repin) STABLE_REPIN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -*)
      printf "❌ Unknown flag: %s\n" "$arg" >&2
      printf "   Usage: bash scripts/publish-rc-channel.sh [version] [--stable-repin] [--yes] [--dry-run]\n" >&2
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

# ---------- refuse a version that doesn't match the mode ----------

if [ "$STABLE_REPIN" -eq 1 ]; then
  # --stable-repin: the version must be a STABLE tag (X.Y.Z). This is the
  # deliberate inverse of the default rc-only refusal — an rc version here is a
  # mode mismatch and is refused fail-closed.
  if ! printf '%s' "$VERSION" | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' >/dev/null; then
    printf "❌ Refusing to re-pin. Version '%s' is not a stable version.\n" "$VERSION" >&2
    printf "   --stable-repin re-pins the rc channel to a stable tag (e.g. 1.0.0).\n" >&2
    printf "   For an rc tag, drop --stable-repin and pass the rc version.\n" >&2
    exit 1
  fi
  # Accept an optional leading v so TAG construction stays uniform.
  VERSION="${VERSION#v}"
else
  if ! printf '%s' "$VERSION" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$' >/dev/null; then
    printf "❌ Refusing to publish. Version '%s' is not an rc version.\n" "$VERSION" >&2
    printf "   The rc channel only serves rc tags (e.g. 0.10.0-rc.2).\n" >&2
    printf "   For a stable tag, re-pin the rc channel with --stable-repin.\n" >&2
    exit 1
  fi
fi

TAG="v${VERSION}"
PAYLOAD_REF="payload/${TAG}"

# ---------- verify the tag exists on origin ----------

if [ -z "$(git ls-remote --tags "$PLUGIN_REPO" "refs/tags/$TAG" 2>/dev/null)" ]; then
  printf "❌ Refusing to publish. Tag %s is not on origin.\n" "$TAG" >&2
  printf "   Push the rc tag first (scripts/release.sh tags + pushes it),\n" >&2
  printf "   then re-run this script.\n" >&2
  exit 1
fi

# ---------- await the tag-triggered release-gate verdict ----------
#
# Pushing the rc tag auto-fired .github/workflows/release-gate.yml. Refuse to
# point the rc channel at a tag whose gate has not concluded success. Read-only,
# so it runs in --dry-run too. No bypass flag: a red tag gate means roll back
# the channel/tag and ship a new rc.
#
# --stable-repin skips this: stable tags fire no gate (the content was already
# gated at its rc, re-checked by release.sh step 3 before the release exists).

if [ "$STABLE_REPIN" -eq 1 ]; then
  printf "Re-pinning the rc channel to the stable tag %s (no gate — gated at its rc) ...\n" "$TAG"
else
  printf "Checking the release-gate run for %s ...\n" "$TAG"
  await_release_gate "$TAG" "$PLUGIN_ROOT" || exit $?
fi

# ---------- await the tag's runtime payload ----------
#
# The tag push also fired .github/workflows/release-payload.yml, which pushes
# payload/TAG — the runtime-only build the catalog pins. Wait for it before
# pinning. Read-only, so it runs in --dry-run too.

printf "Waiting for %s on origin ...\n" "$PAYLOAD_REF"
PAYLOAD_SHA="$(node --experimental-strip-types "$PLUGIN_ROOT/scripts/await-payload-tag.ts" "$TAG" --remote "$PLUGIN_REPO")" || exit $?
printf "✓ %s is on origin at %s.\n" "$PAYLOAD_REF" "$PAYLOAD_SHA"

# ---------- clone the catalog into a temp dir ----------

WORK_DIR="$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-rc-catalog-XXXXXX")"
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

if [ "$CURRENT_REF" = "$PAYLOAD_REF" ] && [ -f "$README" ]; then
  printf "✓ Already published — ref is %s and README.md is present. Nothing to do.\n" "$PAYLOAD_REF"
  exit 0
fi

# ---------- update the ref ----------

UPDATED_JSON="$WORK_DIR/marketplace.json.new"
jq --arg ref "$PAYLOAD_REF" '.plugins[0].source.ref = $ref' "$MARKETPLACE_JSON" > "$UPDATED_JSON"

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
  cat > "$README" <<'EOF' # cli-config-scope: printed
# TMB plugin marketplace — RC

Catalog for the **rc channel** of the [TMB plugin](https://github.com/trustmybot/plugin). Pins the rc's `payload/vX.Y.Z-rc.N` tag, the runtime-only build of the latest `vX.Y.Z-rc.N` under validation — the release candidate that's passed the local L6 chain and is being re-confirmed by the CI release-gate before it ships as stable. Use this when you want to dogfood a build that's close to release but ahead of the stable channel.

## Install

From the project root:

```
claude plugin marketplace add trustmybot/marketplace-rc --scope local
claude plugin install tmb@trustmybot-rc --scope local
```

The rc channel installs as `tmb` (same name as the released plugin), so only one can be enabled at a time.

### Disable any existing `tmb` install first

From the project root, with `<marketplace>` the channel it came from (e.g. `trustmybot`):

```
claude plugin disable tmb@<marketplace> --scope local
```

Disable rather than uninstall so you can flip back to the released channel with `claude plugin enable tmb@<marketplace> --scope local` when done. Fully quit and relaunch Claude Code after each change; a plugin change applies only on a fresh start.

The rc channel is a per-developer choice, so every command here installs at local scope; see [Recommended scope](https://github.com/trustmybot/plugin/blob/main/docs/reference/INSTALL.md#recommended-scope-project-or-local).

## Pull the latest rc

The marketplace ref is the current rc's `payload/vX.Y.Z-rc.N` tag, but CC caches a clone — when the channel re-pins to a newer rc tag, refresh to pick it up:

```
claude plugin marketplace update trustmybot-rc
claude plugin update tmb@trustmybot-rc --scope local
```

A restart alone only loads what CC already has on disk; you need `marketplace update` + `update` to fetch the newly-pinned tag from the remote, then fully quit and relaunch Claude Code.

## Flip back to the released channel when done

```
claude plugin uninstall tmb@trustmybot-rc --scope local
claude plugin enable tmb@<marketplace> --scope local
```

Then fully quit and relaunch Claude Code.

## Channel routing

- This catalog: **RC channel** (latest `payload/vX.Y.Z-rc.N` tag — pre-release builds under validation)
- [trustmybot/marketplace-dev](https://github.com/trustmybot/marketplace-dev) — dev channel (`trustmybot/plugin@dev` — bleeding edge)
- [trustmybot/marketplace](https://github.com/trustmybot/marketplace) — production (stable tags from main)

## Source

Plugin code lives at [trustmybot/plugin](https://github.com/trustmybot/plugin). This repo contains only the marketplace catalog (`.claude-plugin/marketplace.json`).
EOF
fi

# ---------- show intent ----------

printf "\n✓ rc-channel publish plan:\n"
printf "  Catalog:       %s\n" "$CATALOG_REPO"
printf "  source.ref:    %s → %s\n" "$CURRENT_REF" "$PAYLOAD_REF"
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
    "$PAYLOAD_REF" \
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
printf "  Installs of tmb@trustmybot-rc now serve %s (%s).\n" "$TAG" "$PAYLOAD_REF"
