#!/usr/bin/env bash
# L1 lint: no `datetime('now'` under scripts/ or mcp/trajectory-server/src/.
#
# SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" — a different shape from
# the 24-char ms-ISO every timestamp column holds, so string comparisons across
# rows silently misorder. Hooks and scripts stamp rows with tmb_now_iso
# (scripts/hooks/lib/db-write.sh); server code binds nowISO() (src/db.ts); SQL
# DEFAULTs use strftime('%Y-%m-%dT%H:%M:%fZ','now').
#
# Scope: every file under scripts/, and every *.ts / *.sql under
# mcp/trajectory-server/src/ that ships in the server. Exempt: the body of a
# migrateV* function in src/db.ts, and the src/test/ fixtures — both reproduce
# the historical schemas and row shapes a migration upgrades from.
#
# Exits 0 (PASS) when none are found, 1 (FAIL) listing each file:line.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

SRC="mcp/trajectory-server/src"
PATTERN="datetime('now'"

HITS=$(
  {
    grep -rnF "$PATTERN" scripts 2>/dev/null
    grep -rnF --include='*.ts' --include='*.sql' "$PATTERN" "$SRC" 2>/dev/null \
      | grep -v -e "^${SRC}/db\.ts:" -e "^${SRC}/test/"
    awk -v pat="$PATTERN" -v file="$SRC/db.ts" '
      /^(export )?(async )?function / { fn = $0; sub(/^(export )?(async )?function /, "", fn); sub(/\(.*/, "", fn) }
      index($0, pat) && fn !~ /^migrateV/ { print file ":" NR ":" $0 }
    ' "$SRC/db.ts" 2>/dev/null
  } || true
)

if [ -z "$HITS" ]; then
  echo "No-datetime-now-in-hooks: PASS"
  exit 0
fi

COUNT=$(printf '%s\n' "$HITS" | grep -c .)
echo "No-datetime-now-in-hooks: FAIL — ${COUNT} datetime('now') use(s) outside db.ts migrations:" >&2
printf '%s\n' "$HITS" | sed 's/^/  /' >&2
echo "  Use tmb_now_iso (scripts/hooks/lib/db-write.sh), nowISO() (src/db.ts), or strftime('%Y-%m-%dT%H:%M:%fZ','now') in SQL." >&2
exit 1
