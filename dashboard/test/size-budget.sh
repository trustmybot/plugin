#!/usr/bin/env bash
# Size budget: the gzipped JS + CSS of dashboard/dist/web stays under 250 KB.
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/web"
BUDGET=$((250 * 1024))

[ -d "$WEB" ] || { echo "✗ $WEB missing; run bun run build in dashboard/" >&2; exit 1; }

total=0
while IFS= read -r -d '' f; do
  size=$(gzip -9 -c "$f" | wc -c | tr -d ' ')
  printf '  %-12s %7d B gz\n' "$(basename "$f")" "$size"
  total=$((total + size))
done < <(find "$WEB" -type f \( -name '*.js' -o -name '*.css' \) -print0)

if [ "$total" -gt "$BUDGET" ]; then
  echo "✗ dashboard web bundle is $total B gzipped, over the $BUDGET B budget" >&2
  exit 1
fi
echo "✓ dashboard web bundle $total B gzipped (budget $BUDGET B)"
