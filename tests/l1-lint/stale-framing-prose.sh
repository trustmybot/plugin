#!/usr/bin/env bash
# Catch stale framing prose: "no longer", "was previously", "retired",
# "deprecated", "formerly" in documentation prose.
# Captures: !2898 + !2901 — carve-out: if the word appears inside a backtick
#           span (e.g. `deprecated` in a table value column), it is an enum
#           literal and is allowed.
#
# Scans: docs/, agents/, skills/, commands/, templates/agents/, top-level *.md.
#
# Implementation: awk strips backtick spans before matching.
#
# --self-test:
#   - fixtures/stale-framing-prose/has-stale-prose.md → exit 1 (caught)
#   - fixtures/stale-framing-prose/has-enum-literal.md → exit 0 (carve-out)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

STALE_REGEX='\b(no longer|was previously|retired|deprecated|formerly)\b'

FAIL=0

check_file() {
  local file="$1"
  local rel="${file#"$PLUGIN_ROOT/"}"
  local lineno=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    # Strip backtick spans: replace `...` with empty string before matching
    stripped="$(printf '%s' "$line" | sed 's/`[^`]*`//g')"
    if printf '%s' "$stripped" | grep -qiE "$STALE_REGEX"; then
      printf '%s:%d: stale framing prose\n' "$rel" "$lineno"
      FAIL=1
    fi
  done < "$file"
}

run_self_test() {
  local fail_fixture="$HERE/fixtures/stale-framing-prose/has-stale-prose.md"
  local pass_fixture="$HERE/fixtures/stale-framing-prose/has-enum-literal.md"
  local self_fail=0

  if [ ! -f "$fail_fixture" ] || [ ! -f "$pass_fixture" ]; then
    printf 'stale-framing-prose --self-test: fixture(s) missing\n' >&2
    exit 1
  fi

  # Fail fixture should be caught
  local found_stale
  found_stale="$(grep -cE "$(printf '%s' "$STALE_REGEX")" "$fail_fixture" || true)"
  if [ "$found_stale" -gt 0 ]; then
    printf 'stale-framing-prose --self-test: PASS (has-stale-prose.md caught)\n'
  else
    printf 'stale-framing-prose --self-test: FAIL (has-stale-prose.md not caught)\n' >&2
    self_fail=1
  fi

  # Pass fixture: after stripping backtick spans, should have no matches
  local found_enum
  found_enum="$(sed 's/`[^`]*`//g' "$pass_fixture" | grep -icE "$STALE_REGEX" || true)"
  if [ "$found_enum" -eq 0 ]; then
    printf 'stale-framing-prose --self-test: PASS (has-enum-literal.md correctly allowed)\n'
  else
    printf 'stale-framing-prose --self-test: FAIL (has-enum-literal.md incorrectly caught)\n' >&2
    self_fail=1
  fi

  if [ "$self_fail" -eq 0 ]; then
    exit 0
  else
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

SCAN_DIRS=(
  "$PLUGIN_ROOT/docs"
  "$PLUGIN_ROOT/agents"
  "$PLUGIN_ROOT/commands"
  "$PLUGIN_ROOT/templates/agents"
)

FILES=()

for dir in "${SCAN_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$dir" -name '*.md' -print0)
done

[ -d "$PLUGIN_ROOT/skills" ] && while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$PLUGIN_ROOT/skills" -name 'SKILL.md' -print0)

for name in CLAUDE.md CODEX.md CURSOR.md GEMINI.md README.md CONTRIBUTING.md SECURITY.md; do
  [ -f "$PLUGIN_ROOT/$name" ] && FILES+=("$PLUGIN_ROOT/$name")
done

for f in "${FILES[@]}"; do
  check_file "$f"
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nstale-framing-prose: FAIL\n' >&2
  exit 1
fi

printf 'stale-framing-prose: PASS\n'
