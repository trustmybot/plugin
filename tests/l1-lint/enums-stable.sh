#!/usr/bin/env bash
# Lint: docs/contributing/ENUMS.md and the code agree, both ways, on eight
# controlled vocabularies: audit.event_type, audit.from_node, tasks.status,
# issues.status, validation_attempts.verdict, discussions.kind,
# milestones.state and agent_runs.usage_source.
#
#   code → doc  every value found in mcp/trajectory-server/src/ (the schema.sql
#               CHECK lists and the literals written or compared) and scripts/
#               (including the event types hooks pass to tmb_audit_append /
#               tmb_audit_sql) is a documented value.
#   doc → code  every documented value appears in that code, unless its row is
#               marked `reserved`.
#
# src/test/ is not code for this purpose; audit-events.ts and the generated
# scripts/hooks/lib/audit-events.txt are the enum's own source and are skipped
# so a documented event must be written or read somewhere else.
#
# Usage: enums-stable.sh [<root>]   check <root> (default: this repo), after
#                                   the self-test
#        enums-stable.sh --self-test   only the fixtures under
#                                      fixtures/enums-stable/

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURES="$HERE/fixtures/enums-stable"

# section_rows <doc> <section> — the table rows of "### `<section>`".
section_rows() {
  awk -v section="### \`$2\`" '
    index($0, section) == 1 { in_section=1; next }
    in_section && /^### / { in_section=0 }
    in_section && /^\| `/ { print }
  ' "$1"
}

# doc_values <doc> <section> [reserved] — the documented values, or only the
# rows marked reserved; <placeholder> rows are skipped.
doc_values() {
  local rows
  rows=$(section_rows "$1" "$2")
  [ "${3:-}" = reserved ] && rows=$(printf '%s\n' "$rows" | grep -E '\| reserved( |$|—)' || true)
  printf '%s\n' "$rows" | grep -oE '^\| `[^`]+`' | sed -E 's/^\| `([^`]+)`/\1/' | grep -v '<' | sort -u
}

# code_files <root> — the files scanned as code, one per line.
code_files() {
  local root="$1"
  {
    [ -d "$root/mcp/trajectory-server/src" ] && find "$root/mcp/trajectory-server/src" -type f \( -name '*.ts' -o -name '*.sql' \) \
      -not -path '*/src/test/*' -not -name 'audit-events.ts'
    [ -d "$root/scripts" ] && find "$root/scripts" -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.js' -o -name '*.sql' \) \
      -not -name 'audit-events.txt'
  } | sort
}

# extract <enum> <schema.sql> <file>... — prints "<value>\t<file>" for every
# literal of <enum> the code holds (enums-stable-extract.pl).
extract() {
  perl "$HERE/enums-stable-extract.pl" "$@"
}

# check_tree <root> — runs every check; failures go to stderr; returns 1 on any.
check_tree() {
  local root="$1"
  local doc="$root/docs/contributing/ENUMS.md"
  local schema="$root/mcp/trajectory-server/src/schema.sql"
  local lib="$root/scripts/hooks/lib/db-write.sh"
  local failed=0 section documented reserved found value file files
  if [ ! -f "$doc" ]; then
    echo "  ✗ ENUMS.md missing at $doc" >&2
    return 1
  fi
  files=()
  while IFS= read -r file; do files+=("$file"); done < <(code_files "$root")

  for section in audit.event_type audit.from_node tasks.status issues.status validation_attempts.verdict discussions.kind milestones.state agent_runs.usage_source; do
    documented=$(doc_values "$doc" "$section")
    reserved=$(doc_values "$doc" "$section" reserved)
    if [ -z "$documented" ]; then
      echo "  ✗ ENUMS.md has no \`$section\` table" >&2
      failed=1
      continue
    fi
    found=$(extract "$section" "$schema" "${files[@]}")
    if [ "$section" = audit.from_node ] && [ -f "$lib" ]; then
      for value in $(grep -E '^[[:space:]]+[a-z|-]+\) return 0 ;;' "$lib" | head -1 | sed -E 's/^[[:space:]]+//; s/\).*//' | tr '|' ' '); do
        found=$(printf '%s\n%s\t%s' "$found" "$value" "$lib")
      done
    fi

    while IFS=$'\t' read -r value file; do
      [ -n "$value" ] || continue
      if [ "$section" = audit.from_node ] && [ "${value#hook:}" != "$value" ]; then
        if ! printf '%s' "$value" | grep -E '^hook:[a-z0-9-]+$' >/dev/null; then
          echo "  ✗ from_node '$value' in ${file#"$root"/} does not match hook:[a-z0-9-]+" >&2
          failed=1
        elif ! section_rows "$doc" "$section" | grep '`hook:<name>`' >/dev/null; then
          echo "  ✗ ENUMS.md \`audit.from_node\` is missing the hook:<name> convention row" >&2
          failed=1
        fi
        continue
      fi
      if ! printf '%s\n' "$documented" | grep -xF -- "$value" >/dev/null; then
        echo "  ✗ $section '$value' used in ${file#"$root"/} but missing from ENUMS.md" >&2
        failed=1
      fi
    done <<< "$found"

    for value in $documented; do
      printf '%s\n' "$reserved" | grep -xF -- "$value" >/dev/null && continue
      printf '%s\n' "$found" | cut -f1 | grep -xF -- "$value" >/dev/null && continue
      if [ "$section" = audit.from_node ] && [ "${#files[@]}" -gt 0 ]; then
        grep -qE "['\"]${value}['\"]" "${files[@]}" 2>/dev/null && continue
      fi
      echo "  ✗ $section '$value' documented in ENUMS.md but not found in src/ or scripts/ (remove it, or mark its row reserved)" >&2
      failed=1
    done
  done
  return "$failed"
}

# self_test — each fixture tree is base/ with one overlay applied; base passes,
# every overlay must fail naming its value.
self_test() {
  local tmp ok=0 name want
  tmp=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-enums-stable-XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  for name in base undocumented unused; do
    rm -rf "${tmp:?}/$name"
    cp -R "$FIXTURES/base" "$tmp/$name"
    [ "$name" = base ] || cp -R "$FIXTURES/$name/." "$tmp/$name/"
  done
  if ! check_tree "$tmp/base" 2>"$tmp/base.err"; then
    echo "  ✗ self-test: fixtures/enums-stable/base should pass:" >&2
    cat "$tmp/base.err" >&2
    ok=1
  fi
  for name in undocumented unused; do
    want=$(cat "$FIXTURES/$name/EXPECT")
    if check_tree "$tmp/$name" 2>"$tmp/$name.err"; then
      echo "  ✗ self-test: fixtures/enums-stable/$name should fail" >&2
      ok=1
    elif ! grep -qF -- "$want" "$tmp/$name.err"; then
      echo "  ✗ self-test: fixtures/enums-stable/$name failed without naming: $want" >&2
      cat "$tmp/$name.err" >&2
      ok=1
    fi
  done
  return "$ok"
}

if [ "${1:-}" = --self-test ]; then
  self_test || { echo "Enums-stable: FAIL (self-test)" >&2; exit 1; }
  echo "  ✓ self-test: base passes; undocumented literal and unused documented value fail"
  exit 0
fi

ROOT="${1:-$REPO_ROOT}"
self_test || { echo "Enums-stable: FAIL (self-test)" >&2; exit 1; }

if ! check_tree "$ROOT"; then
  echo "" >&2
  echo "  Document the value in docs/contributing/ENUMS.md (audit.event_type: add it to mcp/trajectory-server/src/audit-events.ts and regenerate), or remove the stale row." >&2
  echo "Enums-stable: FAIL" >&2
  exit 1
fi

N_EVENTS=$(doc_values "$ROOT/docs/contributing/ENUMS.md" audit.event_type | grep -c .)
echo "  ✓ self-test: fixtures fail on an undocumented literal and an unused documented value"
echo "  ✓ 8 enums agree between ENUMS.md and src/ + scripts/ both ways ($N_EVENTS audit event types)"
echo ""
echo "Enums-stable: PASS"
