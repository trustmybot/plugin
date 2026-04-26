#!/usr/bin/env bash
# Lint: GH labels match docs/contributing/LABELS.md canonical list.
#
# Catches: someone runs `gh label create` with a new name that's not in
# the doctrine, OR removes a canonical label without updating LABELS.md.
#
# Skipped automatically if `gh` is unavailable or unauthenticated (lets
# the lint pass on dev machines without GH access; CI always has gh).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="$ROOT/docs/contributing/LABELS.md"

if ! command -v gh >/dev/null 2>&1; then
  echo "  ⊘ skip: gh CLI not installed"
  exit 0
fi

# Probe with a low-impact call rather than `gh auth status` which can exit
# non-zero on legitimate sessions (known gh CLI quirk on some platforms).
if ! gh api user --jq '.login' >/dev/null 2>&1; then
  echo "  ⊘ skip: gh CLI not authenticated or no network"
  exit 0
fi

# Pull canonical names from the doc.
CANONICAL_FILE=$(mktemp)
LIVE_FILE=$(mktemp)
trap 'rm -f "$CANONICAL_FILE" "$LIVE_FILE"' EXIT
# Match label rows from any canonical-list table — heading-agnostic so the
# parser keeps working as the doc evolves. A label row is `| **Name** | ...`
# (canonical-list tables) — bold-wrapped so it's distinguishable from the
# table header rows like `| Label | Means |`.
grep -oE '^\| \*\*[^*]+\*\*' "$DOC" | sed -E 's/^\| \*\*([^*]+)\*\*/\1/' | sort -u > "$CANONICAL_FILE"

if [ ! -s "$CANONICAL_FILE" ]; then
  echo "  ✗ LABELS.md has no parseable canonical names" >&2
  exit 1
fi

# Pull current GH labels
gh label list --limit 100 --json name --jq '.[].name' 2>/dev/null | sort -u > "$LIVE_FILE" || true

if [ ! -s "$LIVE_FILE" ]; then
  echo "  ⊘ skip: no GH labels returned (network or repo issue)"
  exit 0
fi

failed=0

# Labels in GH but not in doc (uncatalogued).
ONLY_GH=$(comm -23 "$LIVE_FILE" "$CANONICAL_FILE")
if [ -n "$ONLY_GH" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] && echo "  ✗ GH label '$label' is not documented in LABELS.md" >&2 && failed=1
  done <<< "$ONLY_GH"
fi

# Labels in doc but not in GH (missing on the repo).
ONLY_DOC=$(comm -13 "$LIVE_FILE" "$CANONICAL_FILE")
if [ -n "$ONLY_DOC" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] && echo "  ✗ LABELS.md lists '$label' but it does not exist on GitHub" >&2 && failed=1
  done <<< "$ONLY_DOC"
fi

LIVE_COUNT=$(wc -l < "$LIVE_FILE" | tr -d ' ')

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "  Either run gh label create/delete to align GH with LABELS.md," >&2
  echo "  OR update LABELS.md to reflect the actual repo label set." >&2
  exit 1
fi

echo "  ✓ $LIVE_COUNT GH labels match LABELS.md canonical list"
echo ""
echo "Labels-stable: PASS"
