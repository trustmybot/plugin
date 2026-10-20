#!/usr/bin/env bash
# Prints the dev-build version for REF: X.Y.Z-dev.<n>[.gh<PR>].
#
# Usage:
#   bash scripts/maintenance/dev-build-version.sh --next X.Y.Z [--pr N] [--ref REF]
#
#   --next  the version the dev line is heading for (e.g. the open milestone)
#   --pr    the PR that produced REF; a label only, never used for ordering
#   --ref   the commit to stamp (default: HEAD)
#
# n = first-parent commits from the last stable (non-prerelease) v* tag
# reachable from REF to REF; every first-parent commit when there is no such tag.
# Operates on the cwd's git repo. Prints exactly one line.

set -euo pipefail

usage() {
  echo "Usage: $0 --next X.Y.Z [--pr N] [--ref REF]" >&2
  exit 1
}

NEXT=""
PR=""
REF="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --next) [ $# -ge 2 ] || usage; NEXT="$2"; shift 2 ;;
    --pr)   [ $# -ge 2 ] || usage; PR="$2"; shift 2 ;;
    --ref)  [ $# -ge 2 ] || usage; REF="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$NEXT" ] || usage
if ! [[ "$NEXT" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Error: --next '$NEXT' is not X.Y.Z" >&2
  exit 1
fi
if [ -n "$PR" ] && ! [[ "$PR" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --pr '$PR' is not a PR number" >&2
  exit 1
fi

git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || {
  echo "Error: '$REF' is not a commit" >&2
  exit 1
}

TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' "$REF" 2>/dev/null || true)"
if [ -n "$TAG" ]; then
  N="$(git rev-list --first-parent --count "$TAG..$REF")"
else
  N="$(git rev-list --first-parent --count "$REF")"
fi

printf '%s-dev.%s%s\n' "$NEXT" "$N" "${PR:+.gh$PR}"
