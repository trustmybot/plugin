#!/usr/bin/env bash
# L1 lint: no `datetime('now'` under scripts/.
#
# SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" — a different shape from
# the 24-char ms-ISO every timestamp column holds, so string comparisons across
# rows silently misorder. Hooks and scripts stamp rows with tmb_now_iso
# (scripts/hooks/lib/db-write.sh).
#
# Exits 0 (PASS) when none are found, 1 (FAIL) listing each file:line.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

HITS=$(grep -rnF "datetime('now'" scripts 2>/dev/null || true)

if [ -z "$HITS" ]; then
  echo "No-datetime-now-in-hooks: PASS"
  exit 0
fi

COUNT=$(printf '%s\n' "$HITS" | grep -c .)
echo "No-datetime-now-in-hooks: FAIL — ${COUNT} datetime('now') use(s) under scripts/:" >&2
printf '%s\n' "$HITS" | sed 's/^/  /' >&2
echo "  Use tmb_now_iso (scripts/hooks/lib/db-write.sh) for timestamps." >&2
exit 1
