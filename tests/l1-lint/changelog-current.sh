#!/usr/bin/env bash
# Lint: the CHANGELOG and its changelog.d/ fragments are current.
#
#   1. The top `## vX.Y.Z` section of CHANGELOG.md matches plugin.json.
#   2. Every changelog.d/ fragment is well formed (changelog.d/README.md).
#   3. On a feature branch (diff against origin/<TMB_PR_TARGET>, default dev):
#      - editing CHANGELOG.md and adding a fragment fails — pick one;
#      - after CUTOVER, any direct CHANGELOG.md edit fails, except on a version
#        bump branch and on the branches already in flight at the cut-over
#        (every GH issue its commits cite is in TRANSITION);
#      - each `GH <n>` cited in a branch commit subject needs a fragment
#        changelog.d/<n>-*.md or an entry in CHANGELOG.md.
#
# --root <dir> lints another checkout (tests). TMB_CHANGELOG_TODAY overrides
# today's date (YYYY-MM-DD, UTC) for the cut-over rule.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/maintenance/lib/changelog-fragments.sh"
if [ "${1:-}" = "--root" ]; then
  ROOT="$(cd "${2:?--root needs a directory}" && pwd)"
fi
cd "$ROOT"
# shellcheck source=scripts/maintenance/lib/changelog-fragments.sh
. "$LIB"

CUTOVER="2026-10-12"
TRANSITION="1226 1229 1245 1277 1294 1295"
TODAY="${TMB_CHANGELOG_TODAY:-$(date -u +%Y-%m-%d)}"
BASE_BRANCH="${TMB_PR_TARGET:-dev}"

failed=0
fail() { echo "  ✗ $1" >&2; failed=1; }

# ---- 1. top section matches plugin.json --------------------------------------

CANON=$(jq -r '.version' .claude-plugin/plugin.json)
EXPECTED_HEADER="## v${CANON}"
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
  echo "  or run scripts/maintenance/bump-version.sh, which writes the '$EXPECTED_HEADER — YYYY-MM-DD' section." >&2
  exit 1
fi
echo "  ✓ CHANGELOG top section matches plugin.json version: $CANON"

# ---- 2. fragments well formed ------------------------------------------------

n_frag=0
while IFS= read -r f; do
  n_frag=$((n_frag + 1))
  problems="$(tmb_fragment_validate "$f" || true)"
  if [ -n "$problems" ]; then
    while IFS= read -r p; do fail "$p"; done <<< "$problems"
  fi
done < <(tmb_fragment_list changelog.d)
[ "$failed" -ne 0 ] || echo "  ✓ $n_frag changelog.d/ fragment(s) well formed"

# ---- 3. feature-branch rules -------------------------------------------------

BRANCH="$(git symbolic-ref --short -q HEAD 2>/dev/null || true)"
BASE_REF="origin/$BASE_BRANCH"
case "$BRANCH" in
  ""|dev|main|master|"$BASE_BRANCH")
    echo "  ⊘ not on a feature branch (${BRANCH:-detached HEAD}) — branch rules skipped"
    BRANCH="" ;;
esac
if [ -n "$BRANCH" ] && ! git rev-parse --verify -q "$BASE_REF" >/dev/null; then
  echo "  ⊘ $BASE_REF not found — branch rules skipped (git fetch origin $BASE_BRANCH)"
  BRANCH=""
fi

if [ -n "$BRANCH" ]; then
  MB="$(git merge-base HEAD "$BASE_REF")"
  CHANGED="$( { git diff --name-only "$MB"; git ls-files --others --exclude-standard; } | LC_ALL=C sort -u)"

  changelog_edited=0
  printf '%s\n' "$CHANGED" | grep -x 'CHANGELOG.md' >/dev/null && changelog_edited=1

  branch_fragments=""
  while IFS= read -r p; do
    case "$p" in
      changelog.d/README.md) ;;
      changelog.d/*.md) [ -f "$p" ] && branch_fragments="$branch_fragments $p" ;;
    esac
  done <<< "$CHANGED"

  base_version="$(git show "$MB:.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' 2>/dev/null || true)"
  bump_branch=0
  [ -n "$base_version" ] && [ "$base_version" != "$CANON" ] && bump_branch=1

  cited="$(git log --format=%s "$MB..HEAD" | grep -oE 'GH [0-9]+' | awk '{print $2}' | LC_ALL=C sort -un || true)"

  if [ "$bump_branch" -eq 1 ]; then
    echo "  ⊘ version bump branch ($base_version → $CANON) — CHANGELOG.md is assembled here"
  else
    if [ "$changelog_edited" -eq 1 ] && [ -n "$branch_fragments" ]; then
      fail "branch $BRANCH edits CHANGELOG.md and adds fragment(s):$branch_fragments — pick one (a fragment)"
    fi
    if [ "$changelog_edited" -eq 1 ] && [[ "$TODAY" > "$CUTOVER" ]]; then
      in_flight=0
      if [ -n "$cited" ]; then
        in_flight=1
        for n in $cited; do
          case " $TRANSITION " in *" $n "*) ;; *) in_flight=0 ;; esac
        done
      fi
      if [ "$in_flight" -eq 0 ]; then
        fail "branch $BRANCH edits CHANGELOG.md directly; since $CUTOVER a change adds changelog.d/<gh-issue>-<slug>.md instead (changelog.d/README.md)"
      fi
    fi
  fi

  for n in $cited; do
    if ls changelog.d/"$n"-*.md >/dev/null 2>&1; then continue; fi
    if grep -Eq "GH ${n}([^0-9]|$)" CHANGELOG.md; then continue; fi
    fail "branch $BRANCH cites GH $n but there is no changelog.d/$n-<slug>.md fragment (and no CHANGELOG.md entry)"
  done
  [ "$failed" -ne 0 ] || echo "  ✓ branch $BRANCH: changelog rules hold vs $BASE_REF"
fi

echo ""
if [ "$failed" -ne 0 ]; then
  echo "Changelog-current: FAIL" >&2
  exit 1
fi
echo "Changelog-current: PASS"
