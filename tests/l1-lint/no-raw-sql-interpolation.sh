#!/usr/bin/env bash
# L1 lint: no unguarded shell variable interpolations inside sqlite3 SQL strings.
#
# Heuristic: greps hook scripts for patterns of the form
#   sqlite3 ... "... ${VAR} ..."  or  sqlite3 ... <<SQL ... ${VAR} ... SQL
# and flags lines where neither of the two safe patterns appears within
# N lines before the interpolation:
#   (a) tmb_sql_int / tmb_sql_quote call (shared helper guard), or
#   (b) a case-guard on the same variable (e.g. case "$VAR" in ''|*[!0-9]*)
#
# Allowlist: tests/l1-lint/no-raw-sql-interpolation.allowlist
# One relative-path pattern per line (grep -F match against the file:line output).
# Use a comment line (starting with #) for annotations.
#
# Exits 0 (PASS) when no unguarded interpolations found.
# Exits 1 (FAIL) with diagnostic output listing each violation.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

ALLOWLIST="$ROOT/tests/l1-lint/no-raw-sql-interpolation.allowlist"

VIOLATIONS=()

HOOK_FILES=$(find scripts/hooks scripts/hooks/lib -maxdepth 1 -name '*.sh' -type f | sort)

for script in $HOOK_FILES; do
  line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Only examine lines that contain a ${ interpolation inside what looks like a SQL string.
    # Match: sqlite3 heredocs (previous lines) or inline sqlite3 "..." with ${VAR}.
    case "$line" in
      *'${'*) ;;
      *) continue ;;
    esac

    # Extract the variable name from ${VAR} or ${VAR:-...}
    VAR=$(echo "$line" | grep -oE '\$\{[A-Z_][A-Z_0-9]*' | head -1 | sed 's/\${//')
    [ -n "$VAR" ] || continue

    # Only flag lines that are part of a sqlite3 SQL context.
    # Heuristic 1: line itself contains sqlite3 (inline string interpolation).
    # Heuristic 2: a sqlite3 heredoc was opened in the preceding 20 lines
    #   (only counts if the heredoc opener is a sqlite3 command, not a plain cat/echo).
    IN_SQL_CONTEXT=0
    case "$line" in
      *sqlite3*) IN_SQL_CONTEXT=1 ;;
    esac
    if [ "$IN_SQL_CONTEXT" -eq 0 ]; then
      CONTEXT_LINES=$(sed -n "$((line_num > 20 ? line_num - 20 : 1)),$((line_num - 1))p" "$script" 2>/dev/null || true)
      if echo "$CONTEXT_LINES" | grep -qE 'sqlite3[^#]*<<'; then
        IN_SQL_CONTEXT=1
      fi
    fi
    [ "$IN_SQL_CONTEXT" -eq 1 ] || continue

    # Check for safe guard within N=10 preceding lines.
    GUARD_WINDOW=$((line_num > 10 ? line_num - 10 : 1))
    PRECEDING=$(sed -n "${GUARD_WINDOW},$((line_num - 1))p" "$script" 2>/dev/null || true)

    GUARDED=0

    # Guard type A: tmb_sql_int or tmb_sql_quote call referencing this variable.
    if echo "$PRECEDING" | grep -qE "tmb_sql_int.*${VAR}|tmb_sql_quote.*${VAR}"; then
      GUARDED=1
    fi
    # Guard type A (alt): if this variable name starts with SAFE_ it was
    # already processed by tmb_sql_int/tmb_sql_quote.
    case "$VAR" in SAFE_*) GUARDED=1 ;; esac
    # Guard type B: case-guard on the same variable within preceding lines.
    if echo "$PRECEDING" | grep -qE "case.*\\\$${VAR}|case.*\\\${${VAR}}|tmb_sql_int.*\\\$${VAR}"; then
      GUARDED=1
    fi
    # Guard type B (alt): printf '%d' sanitization for numeric fields.
    if echo "$PRECEDING" | grep -qE "printf '%d'.*\\\$${VAR}|printf '%d'.*\\\${${VAR}}"; then
      GUARDED=1
    fi

    [ "$GUARDED" -eq 1 ] && continue

    LOCATION="${script}:${line_num}"

    # Check allowlist.
    ALLOWED=0
    if [ -f "$ALLOWLIST" ]; then
      while IFS= read -r allow_entry; do
        case "$allow_entry" in '#'*|'') continue ;; esac
        if echo "$LOCATION" | grep -qF "$allow_entry"; then
          ALLOWED=1
          break
        fi
      done < "$ALLOWLIST"
    fi
    [ "$ALLOWED" -eq 1 ] && continue

    VIOLATIONS+=("$LOCATION: unguarded \${${VAR}} in SQL context — use tmb_sql_int/tmb_sql_quote or a case-guard")
  done < "$script"
done

if [ "${#VIOLATIONS[@]}" -eq 0 ]; then
  echo "No-raw-sql-interpolation: PASS"
  exit 0
fi

echo "No-raw-sql-interpolation: FAIL — ${#VIOLATIONS[@]} violation(s):" >&2
for v in "${VIOLATIONS[@]}"; do
  printf "  %s\n" "$v" >&2
done
exit 1
