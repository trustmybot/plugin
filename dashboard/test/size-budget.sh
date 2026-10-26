#!/usr/bin/env bash
# Size budget for dashboard/dist/web (or the directory in $1): app.js + app.css
# plus the chunks app.js imports statically stay under 250 KiB gzipped, and
# every .js/.css file other than app.js and app.css stays under 60 KiB gzipped.
# Prints each file's gzipped size and exits 1 on any breach.
set -euo pipefail

WEB="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/web}"
ENTRY_BUDGET=$((250 * 1024))
CHUNK_BUDGET=$((60 * 1024))

[ -d "$WEB" ] || { echo "✗ $WEB missing; run bun run build in dashboard/" >&2; exit 1; }
[ -f "$WEB/app.js" ] || { echo "✗ $WEB/app.js missing" >&2; exit 1; }

gz() { gzip -9 -c "$1" | wc -c | tr -d ' '; }

failed=0
entry=0
for f in "$WEB/app.js" "$WEB/app.css"; do
  [ -f "$f" ] || continue
  size=$(gz "$f")
  printf '  %-40s %7d B gz (entry)\n' "${f#"$WEB"/}" "$size"
  entry=$((entry + size))
done

static=$(grep -oE '(from|import) ?"\./chunks/[^"]+"' "$WEB/app.js" | grep -oE 'chunks/[^"]+' | sort -u || true)

while IFS= read -r -d '' f; do
  rel="${f#"$WEB"/}"
  case "$rel" in app.js | app.css) continue ;; esac
  size=$(gz "$f")
  note=""
  if printf '%s\n' "$static" | grep -qxF "$rel"; then
    entry=$((entry + size))
    note=" (loaded by app.js)"
  fi
  printf '  %-40s %7d B gz%s\n' "$rel" "$size" "$note"
  if [ "$size" -gt "$CHUNK_BUDGET" ]; then
    echo "✗ $rel is $size B gzipped, over the $CHUNK_BUDGET B per-chunk budget" >&2
    failed=1
  fi
done < <(find "$WEB" -type f \( -name '*.js' -o -name '*.css' \) -print0 | sort -z)

if [ "$entry" -gt "$ENTRY_BUDGET" ]; then
  echo "✗ dashboard entry bundle is $entry B gzipped, over the $ENTRY_BUDGET B budget" >&2
  failed=1
fi
[ "$failed" = 0 ] || exit 1
echo "✓ dashboard entry bundle $entry B gzipped (budget $ENTRY_BUDGET B); every other chunk under $CHUNK_BUDGET B"
