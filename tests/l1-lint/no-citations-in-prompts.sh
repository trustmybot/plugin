#!/usr/bin/env bash
# Catch parenthetical issue/MR/PR citations in prompt files.
# Captures: !2898 — (#NNNN), (GL #NNNN), (MR !NNNN), (PR !NNNN) are noise
#           that loads every turn.
#
# Scans: agents/, skills/, commands/, templates/agents/, top-level platform *.md.
#
# --self-test: scan fixtures/citations-in-prompts/has-citations.md and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

CITATION_REGEX='\((#|GL #|MR !|PR !)[0-9]+\)'

FAIL=0

check_files_in_dir() {
  local dir="$1" depth="${2:-1}"
  [ -d "$dir" ] || return 0
  while IFS= read -r -d '' f; do
    local rel="${f#"$PLUGIN_ROOT/"}"
    while IFS=: read -r lineno _; do
      [ -z "$lineno" ] && continue
      printf '%s:%s: citation in prompt\n' "$rel" "$lineno"
      FAIL=1
    done < <(grep -nE "$CITATION_REGEX" "$f" || true)
  done < <(find "$dir" -maxdepth "$depth" -name '*.md' -print0)
}

run_self_test() {
  local fixture="$HERE/fixtures/citations-in-prompts/has-citations.md"
  if [ ! -f "$fixture" ]; then
    printf 'no-citations-in-prompts --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local found
  found="$(grep -cE "$CITATION_REGEX" "$fixture" || true)"
  if [ "$found" -gt 0 ]; then
    printf 'no-citations-in-prompts --self-test: PASS (fixture caught %s citation(s))\n' "$found"
    exit 0
  else
    printf 'no-citations-in-prompts --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

check_files_in_dir "$PLUGIN_ROOT/agents" 1
check_files_in_dir "$PLUGIN_ROOT/commands" 1
check_files_in_dir "$PLUGIN_ROOT/templates/agents" 1

[ -d "$PLUGIN_ROOT/skills" ] && while IFS= read -r -d '' f; do
  local_rel="${f#"$PLUGIN_ROOT/"}"
  while IFS=: read -r lineno _; do
    [ -z "$lineno" ] && continue
    printf '%s:%s: citation in prompt\n' "$local_rel" "$lineno"
    FAIL=1
  done < <(grep -nE "$CITATION_REGEX" "$f" || true)
done < <(find "$PLUGIN_ROOT/skills" -name 'SKILL.md' -print0)

for name in CLAUDE.md CODEX.md CURSOR.md GEMINI.md; do
  f="$PLUGIN_ROOT/$name"
  [ -f "$f" ] || continue
  rel="${f#"$PLUGIN_ROOT/"}"
  while IFS=: read -r lineno _; do
    [ -z "$lineno" ] && continue
    printf '%s:%s: citation in prompt\n' "$rel" "$lineno"
    FAIL=1
  done < <(grep -nE "$CITATION_REGEX" "$f" || true)
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-citations-in-prompts: FAIL\n' >&2
  exit 1
fi

printf 'no-citations-in-prompts: PASS\n'
