#!/usr/bin/env bash
# L1 lint: the trajectory-DB location rule lives in exactly two places — the
# server's findExistingClaudeDbUp (mcp/trajectory-server/src/platform.ts) and
# the hooks' tmb_db_path (scripts/hooks/lib/query-task.sh), documented once in
# docs/reference/TRAJECTORY_DB_LOCATION.md.
#
# A third copy starts with spelling the DB filename. This lint fails on any
# `trajectory.db` literal (code or comment) in a script under scripts/ other
# than query-task.sh; hooks call tmb_db_path / tmb_db_location instead.
# Markdown under scripts/ is prose, not resolution logic, and is skipped.
#
# Allowlist: tests/l1-lint/no-private-db-path.allowlist — one repo-relative
# path per line (# comments allowed) for scripts that name the file without
# resolving it.
#
# Exits 0 (PASS) when no private copy is found, 1 (FAIL) listing each site.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

OWNER="scripts/hooks/lib/query-task.sh"
ALLOWLIST="tests/l1-lint/no-private-db-path.allowlist"

allowed() {
  [ "$1" = "$OWNER" ] && return 0
  [ -f "$ALLOWLIST" ] || return 1
  grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -xF "$1" >/dev/null
}

VIOLATIONS=""
while IFS= read -r hit; do
  file="${hit%%:*}"
  allowed "$file" && continue
  VIOLATIONS="${VIOLATIONS}  ${hit}
"
done < <(grep -rnF --exclude='*.md' 'trajectory.db' scripts | sort)

if [ -n "$VIOLATIONS" ]; then
  printf 'no-private-db-path: FAIL — trajectory DB path spelled outside %s:\n%s' "$OWNER" "$VIOLATIONS"
  printf 'Resolve the DB with tmb_db_path (or name a location with tmb_db_location) from scripts/hooks/lib/query-task.sh.\n'
  exit 1
fi
printf 'no-private-db-path: PASS — the DB filename appears under scripts/ only in %s.\n' "$OWNER"
