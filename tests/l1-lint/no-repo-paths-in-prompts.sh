#!/usr/bin/env bash
# Catch this repository's own paths and scripts in shipped prompt files.
# TMB is general purpose: a prompt that names mcp/trajectory-server/src/, scripts/hooks/,
# changelog.d/ or regen-generated.sh describes the user's project with this repo's layout.
# Lines naming product internals every install has (CLAUDE_PLUGIN_ROOT, .claude/tmb/, the
# plugin cache) are allowed.
#
# Scans: agents/, commands/, templates/agents/ (depth 1) and every *.md under skills/.
#
# --self-test: has-paths.md must yield at least six findings, allowlisted.md none.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

REPO_PATH_REGEX='mcp/trajectory-server|scripts/hooks/|scripts/maintenance/|changelog\.d|tests/l[0-9]|regen-generated|dist-fresh|docs/architecture'
ALLOW_REGEX='CLAUDE_PLUGIN_ROOT|\.claude/tmb/|plugin cache'

FAIL=0

findings_in_file() {
  local f="$1"
  grep -nE "$REPO_PATH_REGEX" "$f" | grep -vE "$ALLOW_REGEX" | cut -d: -f1 || true
}

report_file() {
  local f="$1" rel lineno
  rel="${f#"$PLUGIN_ROOT/"}"
  while IFS= read -r lineno; do
    [ -z "$lineno" ] && continue
    printf '%s:%s: repository path in prompt\n' "$rel" "$lineno"
    FAIL=1
  done < <(findings_in_file "$f")
}

check_files_in_dir() {
  local dir="$1" depth="${2:-}"
  [ -d "$dir" ] || return 0
  local args=(-name '*.md')
  [ -n "$depth" ] && args=(-maxdepth "$depth" -name '*.md')
  while IFS= read -r -d '' f; do
    report_file "$f"
  done < <(find "$dir" "${args[@]}" -print0)
}

run_self_test() {
  local dir="$HERE/fixtures/repo-paths-in-prompts"
  local bad="$dir/has-paths.md" ok="$dir/allowlisted.md"
  local f
  for f in "$bad" "$ok"; do
    if [ ! -f "$f" ]; then
      printf 'no-repo-paths-in-prompts --self-test: fixture missing: %s\n' "$f" >&2
      exit 1
    fi
  done

  local found clean
  found="$(findings_in_file "$bad" | grep -c . || true)"
  clean="$(findings_in_file "$ok" | grep -c . || true)"
  if [ "$found" -ge 6 ] && [ "$clean" -eq 0 ]; then
    printf 'no-repo-paths-in-prompts --self-test: PASS (%s finding(s) in has-paths.md, %s in allowlisted.md)\n' "$found" "$clean"
    exit 0
  fi
  printf 'no-repo-paths-in-prompts --self-test: FAIL (has-paths.md %s finding(s), allowlisted.md %s)\n' "$found" "$clean" >&2
  exit 1
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

check_files_in_dir "$PLUGIN_ROOT/agents" 1
check_files_in_dir "$PLUGIN_ROOT/commands" 1
check_files_in_dir "$PLUGIN_ROOT/templates/agents" 1
check_files_in_dir "$PLUGIN_ROOT/skills"

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-repo-paths-in-prompts: FAIL\n' >&2
  exit 1
fi

printf 'no-repo-paths-in-prompts: PASS\n'
