#!/usr/bin/env bash
# L1 lint: every trajectory-DB write under scripts/ goes through
# scripts/hooks/lib/db-write.sh (tmb_db_write / tmb_audit_append).
#
# A direct `sqlite3` write runs with foreign keys OFF, no busy timeout, outside
# a transaction, and usually behind `2>/dev/null || true` — a dropped write
# nobody sees. This lint finds every `sqlite3` CLI invocation under scripts/,
# collects its SQL (the rest of the command: inline string, quoted multi-line
# string, `\` continuations, or heredoc body) and fails when that SQL contains
# INSERT, UPDATE, or DELETE. A non-readonly invocation whose SQL is a bare
# shell variable ("$SQL") is flagged too — its statement cannot be inspected.
# The write library itself is the only exemption.
#
# Exits 0 (PASS) when no direct write is found, 1 (FAIL) listing each site.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

EXEMPT="scripts/hooks/lib/db-write.sh"

VIOLATIONS=""
while IFS= read -r file; do
  [ "$file" = "$EXEMPT" ] && continue
  hits=$(awk '
    function quotes(s,   t) { t = s; gsub(/\\"/, "", t); return gsub(/"/, "", t) }
    function flush() {
      if (start && toupper(buf) ~ /(^|[^A-Z_])(INSERT|UPDATE|DELETE)([^A-Z_]|$)/) {
        printf "%s:%d\n", FILENAME, start
      }
      start = 0; buf = ""; delim = ""; open = 0; cont = 0
    }
    {
      line = $0
      if (start) {
        buf = buf "\n" line
        if (delim != "") {
          t = line; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
          if (t == delim) flush()
          next
        }
        if (quotes(line) % 2 == 1) open = !open
        cont = (line ~ /\\[ \t]*$/)
        if (!open && !cont) flush()
        next
      }
      if (line ~ /^[ \t]*#/) next
      probe = line
      gsub(/command -v sqlite3/, "", probe)
      if (probe !~ /(^|[^A-Za-z0-9_.-])sqlite3[ \t]+(-|"|\$|<)/) next
      if (line !~ /-readonly/ && line ~ /sqlite3[^"]*"[^"]*"[ \t]+"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"/) {
        printf "%s:%d\n", FILENAME, FNR
        next
      }
      start = FNR; buf = line
      if (match(line, /<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        d = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*["\047]?/, "", d)
        delim = d
        next
      }
      open = (quotes(line) % 2 == 1)
      cont = (line ~ /\\[ \t]*$/)
      if (!open && !cont) flush()
    }
    END { flush() }
  ' "$file")
  [ -n "$hits" ] && VIOLATIONS="${VIOLATIONS}${hits}
"
done < <(find scripts -type f \( -name '*.sh' -o -name '*.bash' -o ! -name '*.*' \) | sort)

VIOLATIONS="${VIOLATIONS%
}"
if [ -z "$VIOLATIONS" ]; then
  echo "No-direct-sqlite-write: PASS"
  exit 0
fi

COUNT=$(printf '%s\n' "$VIOLATIONS" | grep -c .)
echo "No-direct-sqlite-write: FAIL — ${COUNT} direct sqlite3 write(s) outside ${EXEMPT}:" >&2
printf '%s\n' "$VIOLATIONS" | sed 's/^/  /' >&2
echo "  Route writes through tmb_db_write / tmb_audit_append (scripts/hooks/lib/db-write.sh)." >&2
exit 1
