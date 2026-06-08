#!/usr/bin/env bash
# Catch audit_log() calls that are missing from_node=.
# Captures: !2892 BLOCKER 1 — 6 prompt files crashed bro on first call.
#
# Scans: agents/*.md, skills/*/SKILL.md, commands/*.md, templates/agents/*.md,
#         top-level platform *.md (CLAUDE.md, CODEX.md, CURSOR.md, GEMINI.md).
#
# Logic: find every line containing audit_log(. Collect the multi-line call
# (up to the closing ')' or the next blank line). If the collected slice
# does not contain from_node= → FAIL.
#
# --self-test: scan fixtures/audit-log-from-node/missing.md and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0

check_file() {
  local file="$1"
  local rel="${file#"$PLUGIN_ROOT/"}"
  local lineno=0
  local in_call=0
  local call_start=0
  local call_buf=""

  flush_call() {
    if [ "$in_call" -eq 1 ]; then
      if ! printf '%s\n' "$call_buf" | grep -q 'from_node='; then
        printf '%s:%d: audit_log() missing from_node=\n' "$rel" "$call_start"
        FAIL=1
      fi
      in_call=0
      call_buf=""
      call_start=0
    fi
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))

    if [ "$in_call" -eq 1 ]; then
      call_buf="${call_buf}
${line}"
      if printf '%s\n' "$line" | grep -q ')'; then
        flush_call
      fi
      continue
    fi

    if printf '%s\n' "$line" | grep -q 'audit_log('; then
      in_call=1
      call_start="$lineno"
      call_buf="$line"
      if printf '%s\n' "$line" | grep -q ')'; then
        flush_call
      fi
    fi
  done < "$file"

  flush_call
}

run_self_test() {
  local fixture="$HERE/fixtures/audit-log-from-node/missing.md"
  if [ ! -f "$fixture" ]; then
    printf 'no-audit-log-without-from-node --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  PLUGIN_ROOT="$HERE/fixtures/audit-log-from-node" check_file "$fixture"
  if [ "$FAIL" -ne 0 ]; then
    printf 'no-audit-log-without-from-node --self-test: PASS (fixture caught as expected)\n'
    exit 0
  else
    printf 'no-audit-log-without-from-node --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

SCAN_DIRS=(
  "$PLUGIN_ROOT/agents"
  "$PLUGIN_ROOT/commands"
  "$PLUGIN_ROOT/templates/agents"
)
SCAN_SKILLS_GLOB="$PLUGIN_ROOT/skills"
TOP_LEVEL_MDS=("CLAUDE.md" "CODEX.md" "CURSOR.md" "GEMINI.md")

FILES=()

for dir in "${SCAN_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$dir" -maxdepth 1 -name '*.md' -print0)
done

[ -d "$SCAN_SKILLS_GLOB" ] && while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$SCAN_SKILLS_GLOB" -name 'SKILL.md' -print0)

for name in "${TOP_LEVEL_MDS[@]}"; do
  [ -f "$PLUGIN_ROOT/$name" ] && FILES+=("$PLUGIN_ROOT/$name")
done

for f in "${FILES[@]}"; do
  check_file "$f"
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-audit-log-without-from-node: FAIL\n' >&2
  exit 1
fi

printf 'no-audit-log-without-from-node: PASS\n'
