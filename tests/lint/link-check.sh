#!/usr/bin/env bash
# Lint: every relative markdown link `[text](path)` in tracked .md files
# must resolve to an existing file or directory.
#
# Catches: links to deleted files (e.g. docs/PERFORMANCE.md after we
# retired it), typos in path names, broken section refs to moved docs.
#
# What it does NOT check:
#   - http(s) URLs (we don't network in lint)
#   - mailto: / data: schemes
#   - Anchor-only refs (#section) — those don't have a file to verify
#   - Anchors on intra-doc links (foo.md#section) — we just verify foo.md exists

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Collect every .md file we own (skip vendored/installed dirs)
MD_FILES=$(find . -type f -name '*.md' \
  -not -path './node_modules/*' \
  -not -path './*/node_modules/*' \
  -not -path './*/*/node_modules/*' \
  -not -path './.git/*' \
  -not -path './*/dist/*' \
  | sort)

BROKEN=0
TOTAL=0

while IFS= read -r mdfile; do
  # Strip inline code spans (`...`) and fenced code blocks (```...```) before
  # scanning for links — a literal `[text](path)` inside backticks is example
  # text, not a real link, and shouldn't be path-checked.
  STRIPPED=$(awk '
    /^```/ { in_fence = !in_fence; next }
    in_fence { next }
    { gsub(/`[^`]*`/, ""); print }
  ' "$mdfile")
  # Extract every (link) — strip out images ![...](...) since they're equivalent here
  LINKS=$(echo "$STRIPPED" \
    | grep -oE '\]\([^)]+\)' \
    | sed -E 's/^\]\(([^)]+)\)/\1/' \
    || true)
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    # Skip URLs and special schemes
    case "$link" in
      http://*|https://*|mailto:*|data:*|tel:*) continue ;;
      \#*) continue ;;  # anchor-only, no path to verify
    esac
    # Strip anchor fragment + query string for filesystem resolution
    target="${link%%#*}"
    target="${target%%\?*}"
    [ -z "$target" ] && continue

    TOTAL=$((TOTAL + 1))

    # Resolve relative to the .md file's directory
    mddir="$(dirname "$mdfile")"
    resolved="$mddir/$target"

    # Use realpath if available, else fall back to plain check
    if command -v realpath >/dev/null 2>&1; then
      resolved=$(realpath -m "$resolved" 2>/dev/null || echo "$resolved")
    fi

    if [ ! -e "$resolved" ]; then
      printf "  ✗ %s → %s (resolved: %s) [missing]\n" "$mdfile" "$link" "$resolved" >&2
      BROKEN=$((BROKEN + 1))
    fi
  done <<< "$LINKS"
done <<< "$MD_FILES"

echo ""
if [ $BROKEN -gt 0 ]; then
  printf "Link-check: FAIL (%d broken / %d total)\n" "$BROKEN" "$TOTAL" >&2
  exit 1
fi
printf "Link-check: PASS (%d links resolve)\n" "$TOTAL"
