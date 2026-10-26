#!/usr/bin/env bash
# Catch stale framing prose: "no longer", "was previously", "retired",
# "deprecated", "formerly" in documentation prose.
# Captures: !2898 + !2901 — carve-out: if the word appears inside a backtick
#           span (e.g. `deprecated` in a table value column), it is an enum
#           literal and is allowed.
#
# Scans: docs/, agents/, skills/, commands/, templates/agents/, top-level *.md.
#
# Implementation: lines inside fenced code blocks (``` or ~~~, optionally
# indented, with an info string) are skipped; sed strips inline backtick
# spans before matching.
#
# --self-test runs each fixture through check_file:
#   - fixtures/stale-framing-prose/has-stale-prose.md → caught
#   - fixtures/stale-framing-prose/has-enum-literal.md → allowed (carve-out)
#   - fixtures/stale-framing-prose/has-fenced-code.md → fences allowed, prose after caught

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

STALE_REGEX='\b(no longer|was previously|retired|deprecated|formerly)\b'

FAIL=0

check_file() {
  local file="$1"
  local rel="${file#"$PLUGIN_ROOT/"}"
  local lineno=0 fence_char="" fence_len=0 marker rest stripped
  local fence_re='^[[:space:]]*(```+|~~~+)(.*)$'

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    if [[ "$line" =~ $fence_re ]]; then
      marker="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[2]}"
      if [[ -z "$fence_char" ]]; then
        if [[ "${marker:0:1}" == '~' || "$rest" != *'`'* ]]; then
          fence_char="${marker:0:1}"
          fence_len=${#marker}
          continue
        fi
      elif [[ "${marker:0:1}" == "$fence_char" && ${#marker} -ge $fence_len && "$rest" =~ ^[[:space:]]*$ ]]; then
        fence_char=""
        fence_len=0
        continue
      fi
    fi
    [[ -n "$fence_char" ]] && continue
    stripped="$(printf '%s' "$line" | sed 's/`[^`]*`//g')"
    if printf '%s' "$stripped" | grep -iE "$STALE_REGEX" >/dev/null; then
      printf '%s:%d: stale framing prose\n' "$rel" "$lineno"
      FAIL=1
    fi
  done < "$file"
}

expect_flagged_lines() {
  local name="$1" want="$2" fixture got
  fixture="$HERE/fixtures/stale-framing-prose/$name"
  if [ ! -f "$fixture" ]; then
    printf 'stale-framing-prose --self-test: FAIL (%s missing)\n' "$name" >&2
    return 1
  fi
  got="$(check_file "$fixture" | sed -n 's/^.*:\([0-9][0-9]*\): stale framing prose$/\1/p' | tr '\n' ' ')"
  got="${got% }"
  if [ "$got" == "$want" ]; then
    printf 'stale-framing-prose --self-test: PASS (%s flags lines [%s])\n' "$name" "$want"
    return 0
  fi
  printf 'stale-framing-prose --self-test: FAIL (%s flags lines [%s], expected [%s])\n' "$name" "$got" "$want" >&2
  return 1
}

run_self_test() {
  local self_fail=0
  expect_flagged_lines has-stale-prose.md "3 4" || self_fail=1
  expect_flagged_lines has-enum-literal.md "" || self_fail=1
  expect_flagged_lines has-fenced-code.md "11" || self_fail=1
  exit "$self_fail"
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
