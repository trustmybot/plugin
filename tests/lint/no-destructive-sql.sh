#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

DESTRUCTIVE_REGEX='DROP TABLE|DELETE FROM|TRUNCATE'
SCAN_FILES=(
  "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"
  "$PLUGIN_ROOT/mcp/trajectory-server/src/db.ts"
)

fail=0
for f in "${SCAN_FILES[@]}"; do
  [ -f "$f" ] || continue
  # Match destructive SQL patterns (skip false positive: `is_truncated` column name)
  while IFS=: read -r linenum content; do
    [ -z "$linenum" ] && continue
    # Require LINT-ALLOW: marker on previous line
    prev=$(sed -n "$((linenum - 1))p" "$f")
    if echo "$prev" | grep -qE 'LINT-ALLOW:'; then
      continue
    fi
    printf '✗ %s:%s — destructive SQL without LINT-ALLOW marker\n' "$f" "$linenum" >&2
    printf '    %s\n' "$content" >&2
    fail=1
  done < <(grep -nE "$DESTRUCTIVE_REGEX" "$f" | grep -vE 'is_truncated' || true)
done

if [ "$fail" = "1" ]; then
  printf '\nDestructive SQL must be opt-in via a LINT-ALLOW: <reason> comment on the previous line.\n' >&2
  printf 'This guards against accidental data loss during schema migrations.\n' >&2
  exit 1
fi

echo "no-destructive-sql: PASS"
