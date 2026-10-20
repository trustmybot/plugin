#!/usr/bin/env bash
# L1 lint: no unguarded shell variable interpolations inside sqlite3 SQL strings.
#
# Heuristic: greps hook scripts, scripts/lib/, and scripts/scan.sh for patterns
# of the form
#   sqlite3 ... "... ${VAR} ..."  or  sqlite3 ... "... $var ..."  or
#   sqlite3 ... <<SQL ... ${VAR} ... SQL  or
#   tmb_db_write|tmb_gate_read "$DB" [\ newline] "... ${VAR} ..."
# (braced or bare, upper- or lowercase) and flags lines where neither of the
# two safe patterns appears within N lines before the interpolation:
#   (a) tmb_sql_int / tmb_sql_quote call (shared helper guard), or
#   (b) a case-guard on the same variable (e.g. case "$VAR" in ''|*[!0-9]*)
# The db-path argument ("$DB" right after sqlite3 + flags, or after
# tmb_db_write / tmb_gate_read) sits outside the SQL string — it is stripped
# before extraction, not exempted by name.
#
# Allowlist: tests/l1-lint/no-raw-sql-interpolation.allowlist
# One entry per line, repo-relative; comment lines start with #.
#   <file>@<function>  every line of the shell function, located by scanning
#                      `^<function>() {` to its closing `^}` — survives line shifts
#   <file>:<line>      exactly that line
#   <file>             the whole file
# A <file>@<function> entry whose file or function no longer exists is a FAIL.
#
# Every run first runs the self-test against fixtures/no-raw-sql-interpolation/
# (`--self-test` runs only that).
#
# Exits 0 (PASS) when no unguarded interpolations found.
# Exits 1 (FAIL) with diagnostic output listing each violation.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-raw-sql-interpolation"

# resolve_allowlist <allowlist> — run from the scan root. Prints one resolved
# entry per line: "file" (whole file) or "file:line"; a file@function entry
# expands to one file:line per line of the function. Prints each stale entry
# to stderr and returns 1 when any entry names a missing file or function.
resolve_allowlist() {
  local allowlist="$1" entry file fn range start end stale=0 n
  [ -f "$allowlist" ] || return 0
  while IFS= read -r entry; do
    case "$entry" in '#'*|'') continue ;; esac
    case "$entry" in
      *@*)
        file="${entry%@*}"
        fn="${entry##*@}"
        range=""
        [ -f "$file" ] && range=$(awk -v fn="$fn" '
          !start && index($0, fn "() {") == 1 { start = NR; next }
          start && /^}[[:space:]]*$/ { print start, NR; exit }
        ' "$file")
        if [ -z "$range" ]; then
          printf '  %s: stale allowlist entry — function %s() not found in %s\n' "$entry" "$fn" "$file" >&2
          stale=1
          continue
        fi
        start="${range% *}"
        end="${range#* }"
        for ((n = start; n <= end; n++)); do printf '%s:%s\n' "$file" "$n"; done
        ;;
      *) printf '%s\n' "$entry" ;;
    esac
  done < "$allowlist"
  return "$stale"
}

# scan <allowlist> <file>... — run from the scan root; prints one violation
# per line. Returns 2 when the allowlist has a stale entry.
scan() {
  local allowlist="$1"
  shift
  local resolved
  resolved=$(resolve_allowlist "$allowlist") || return 2
  local VIOLATIONS=()
  local script line_num prev_line line PREV_LINE SCAN_LINE VARS IN_SQL_CONTEXT PROBE_LINE CONTEXT_LINES GUARD_WINDOW PRECEDING LOCATION VAR GUARDED ALLOWED

  for script in "$@"; do
    line_num=0
    prev_line=""
    while IFS= read -r line; do
      line_num=$((line_num + 1))
      PREV_LINE="$prev_line"
      prev_line="$line"

      # Only examine lines that contain a $ interpolation inside what looks like a SQL string.
      # Match: sqlite3 heredocs (previous lines) or inline sqlite3 "..." with ${VAR}/$var.
      case "$line" in
        *'$'*) ;;
        *) continue ;;
      esac

      # Strip the sqlite3 db-path argument (the first quoted var after sqlite3 +
      # flags) — it is a shell argument, not part of the SQL string this lint guards.
      SCAN_LINE=$(printf '%s' "$line" | sed -E 's/(sqlite3|tmb_db_write|tmb_gate_read)[^"]*"\$\{?[A-Za-z_][A-Za-z_0-9]*\}?"//')

      # Extract every variable name: ${VAR}, ${VAR:-...}, $VAR — bare and lowercase included.
      VARS=$(printf '%s\n' "$SCAN_LINE" | grep -oE '\$\{?[A-Za-z_][A-Za-z_0-9]*' | sed 's/^\$//;s/^{//' | sort -u)
      [ -n "$VARS" ] || continue

      # Only flag lines that are part of a sqlite3 SQL context.
      # Heuristic 1: line itself contains sqlite3 (inline string interpolation).
      #   `command -v sqlite3` availability probes are not SQL contexts — drop them first.
      # Heuristic 2: a sqlite3 heredoc was opened in the preceding 20 lines
      #   (only counts if the heredoc opener is a sqlite3 command, not a plain cat/echo).
      IN_SQL_CONTEXT=0
      #   `sqlite3-<name>` tokens (e.g. the sqlite3-fallback lib's messages) are
      #   names, not invocations — drop them too.
      PROBE_LINE="${line//command -v sqlite3/}"
      PROBE_LINE="${PROBE_LINE//sqlite3-/}"
      case "$PROBE_LINE" in
        *sqlite3*|*tmb_db_write*|*tmb_gate_read*) IN_SQL_CONTEXT=1 ;;
      esac
      # Heuristic 1b: the SQL argument on the line after a `tmb_db_write "$DB" \`
      # or `tmb_gate_read "$DB" \` continuation.
      case "$PREV_LINE" in
        *tmb_db_write*\\|*tmb_gate_read*\\) IN_SQL_CONTEXT=1 ;;
      esac
      if [ "$IN_SQL_CONTEXT" -eq 0 ]; then
        CONTEXT_LINES=$(sed -n "$((line_num > 20 ? line_num - 20 : 1)),$((line_num - 1))p" "$script" 2>/dev/null || true)
        if echo "$CONTEXT_LINES" | grep -E 'sqlite3[^#]*<<' >/dev/null; then
          IN_SQL_CONTEXT=1
        fi
      fi
      [ "$IN_SQL_CONTEXT" -eq 1 ] || continue

      # Check for safe guard within N=10 preceding lines.
      GUARD_WINDOW=$((line_num > 10 ? line_num - 10 : 1))
      PRECEDING=$(sed -n "${GUARD_WINDOW},$((line_num - 1))p" "$script" 2>/dev/null || true)
      LOCATION="${script}:${line_num}"

      while IFS= read -r VAR; do
        [ -n "$VAR" ] || continue

        GUARDED=0

        # Guard type A: tmb_sql_int or tmb_sql_quote call referencing this variable,
        # or this variable assigned from a tmb_sql_int/tmb_sql_quote substitution.
        if echo "$PRECEDING" | grep -E "tmb_sql_int.*${VAR}|tmb_sql_quote.*${VAR}|${VAR}=\\\$\\(tmb_sql_(int|quote)" >/dev/null; then
          GUARDED=1
        fi
        # Guard type A (alt): if this variable name starts with SAFE_ it was
        # already processed by tmb_sql_int/tmb_sql_quote.
        case "$VAR" in SAFE_*) GUARDED=1 ;; esac
        # Guard type B: case-guard on the same variable within preceding lines.
        if echo "$PRECEDING" | grep -E "case.*\\\$${VAR}|case.*\\\${${VAR}}|tmb_sql_int.*\\\$${VAR}" >/dev/null; then
          GUARDED=1
        fi
        # Guard type B (alt): printf '%d' sanitization for numeric fields.
        if echo "$PRECEDING" | grep -E "printf '%d'.*\\\$${VAR}|printf '%d'.*\\\${${VAR}}" >/dev/null; then
          GUARDED=1
        fi

        [ "$GUARDED" -eq 1 ] && continue

        # Check allowlist.
        ALLOWED=0
        if printf '%s\n' "$resolved" | grep -xF -e "$LOCATION" -e "$script" >/dev/null; then
          ALLOWED=1
        fi
        [ "$ALLOWED" -eq 1 ] && continue

        VIOLATIONS+=("$LOCATION: unguarded \$${VAR} in SQL context — use tmb_sql_int/tmb_sql_quote or a case-guard")
      done <<< "$VARS"
    done < "$script"
  done

  [ "${#VIOLATIONS[@]}" -eq 0 ] || printf '%s\n' "${VIOLATIONS[@]}"
  return 0
}

# self_test — the fixture helper's line number shifts when a comment is
# inserted above it: the @function entry still covers it, a :line entry
# pinned to the old position goes stale, and a missing function fails.
self_test() {
  local tmp fail=0 out rc pinned
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/tmb-no-raw-sql-interpolation.XXXXXX") || return 1
  cp "$FIXTURES/helper.sh" "$tmp/helper.sh"
  pinned=$(grep -n '"\$sql"' "$tmp/helper.sh" | head -1 | cut -d: -f1)
  { echo '# shifted'; cat "$FIXTURES/helper.sh"; } > "$tmp/helper.sh"
  (
    cd "$tmp" || exit 1
    echo 'helper.sh@fixture_sqlite_ro' > function.allowlist
    echo "helper.sh:${pinned}" > line.allowlist
    echo 'helper.sh@fixture_gone' > stale.allowlist
    out=$(scan function.allowlist helper.sh); rc=$?
    [ "$rc" -eq 0 ] && [ -z "$out" ] || { echo "self-test: @function entry did not cover the shifted helper (rc=$rc): $out" >&2; exit 1; }
    out=$(scan line.allowlist helper.sh); rc=$?
    [ "$rc" -eq 0 ] && [ -n "$out" ] || { echo "self-test: stale :line entry still passed the shifted helper (rc=$rc)" >&2; exit 1; }
    scan stale.allowlist helper.sh >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 2 ] || { echo "self-test: allowlist entry naming a missing function did not fail (rc=$rc)" >&2; exit 1; }
  ) || fail=1
  rm -rf "$tmp"
  return "$fail"
}

if ! self_test; then
  echo "No-raw-sql-interpolation: FAIL — self-test" >&2
  exit 1
fi
if [ "${1:-}" = "--self-test" ]; then
  echo "No-raw-sql-interpolation self-test: PASS"
  exit 0
fi

cd "$ROOT" || exit 1
HOOK_FILES=$( { find scripts/hooks scripts/hooks/lib scripts/lib -maxdepth 1 -name '*.sh' -type f; echo scripts/scan.sh; } | sort)
# shellcheck disable=SC2086
FOUND=$(scan tests/l1-lint/no-raw-sql-interpolation.allowlist $HOOK_FILES)
rc=$?
if [ "$rc" -eq 2 ]; then
  echo "No-raw-sql-interpolation: FAIL — stale allowlist entries above" >&2
  exit 1
fi

if [ -z "$FOUND" ]; then
  echo "No-raw-sql-interpolation: PASS"
  exit 0
fi

echo "No-raw-sql-interpolation: FAIL — $(printf '%s\n' "$FOUND" | wc -l | tr -d ' ') violation(s):" >&2
printf '%s\n' "$FOUND" | sed 's/^/  /' >&2
exit 1
