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
# LAST = the highest stable vX.Y.Z tag in the repo by version sort, reachable
# from REF or not: release tags sit on main merge commits that dev never
# contains. n = first-parent commits in LAST..REF, the dev commits not yet in
# that release, so n resets after each release; every first-parent commit when
# there is no stable tag. --next must be above LAST by SemVer.
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

TAG=""
while IFS= read -r t; do
  if [[ "$t" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    TAG="$t"
    break
  fi
done < <(git tag -l 'v[0-9]*' --sort=-v:refname)

semver_gt() {
  local a b i
  IFS=. read -ra a <<< "$1"
  IFS=. read -ra b <<< "$2"
  for i in 0 1 2; do
    if (( 10#${a[i]} != 10#${b[i]} )); then
      (( 10#${a[i]} > 10#${b[i]} ))
      return
    fi
  done
  return 1
}

if [ -n "$TAG" ]; then
  if ! semver_gt "$NEXT" "${TAG#v}"; then
    echo "Error: --next '$NEXT' is not above the latest release $TAG" >&2
    exit 1
  fi
  N="$(git rev-list --first-parent --count "$TAG..$REF")"
else
  N="$(git rev-list --first-parent --count "$REF")"
fi

printf '%s-dev.%s%s\n' "$NEXT" "$N" "${PR:+.gh$PR}"
