#!/usr/bin/env bash
# Keeps L2 unit tests from reaching the live trajectory DB through scan.sh.
#
# Rule: every *.ts file under mcp/trajectory-server/src/test/, except the data
# modules under src/test/fixtures/ (schema snapshots that only name scan_run in
# SQL comments), whose text contains `scan.sh`, `scan_run` or `project_scan`
# (the Codex tool that runs scan_run) must also, outside comments, call
# `pinScanEnv(` (the src/test/helpers.ts export that pins TRAJECTORY_DB_PATH,
# TMB_SCAN_MCP_JSON and TMB_FORBID_LIVE_SYNC=1) or assign `TRAJECTORY_DB_PATH`
# (`TRAJECTORY_DB_PATH: ...`, `env['TRAJECTORY_DB_PATH'] = ...`). A mention —
# an import, a comment — is not a pin. Without the pin, a forked scan.sh run
# outside the test flags resolves its DB by walking up from cwd — to the
# project's live .claude/tmb/trajectory.db for any checkout inside the project.
#
# Usage: bash tests/l1-lint/no-unpinned-scan-in-tests.sh [--self-test]
# --self-test: fixtures/unpinned-scan/unpinned.test.ts and mentioned.test.ts
# must be flagged and fixtures/unpinned-scan/pinned.test.ts must pass.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FORKS_SCAN='scan\.sh|scan_run|project_scan'
PINNED='pinScanEnv\(|TRAJECTORY_DB_PATH['"'"'"]?\]?[[:space:]]*(:|=[^=])'

# code_only <file> — the file with comment lines and trailing // comments
# removed (a `://` URL is kept).
code_only() {
  sed -E -e 's#^[[:space:]]*(/\*|\*).*##' -e 's#(^|[^:])//.*$#\1#' "$1"
}

# unpinned_files <dir> [<excluded-dir>] — prints each *.ts file under <dir>,
# outside <excluded-dir>, that references scan.sh/scan_run/project_scan unpinned.
unpinned_files() {
  local f
  while IFS= read -r -d '' f; do
    case "$f" in "${2:-//}"/*) continue ;; esac
    grep -Eq "$FORKS_SCAN" "$f" || continue
    code_only "$f" | grep -E "$PINNED" >/dev/null && continue
    printf '%s\n' "$f"
  done < <(find "$1" -type f -name '*.ts' -print0)
}

if [ "${1:-}" = "--self-test" ]; then
  fixtures="$HERE/fixtures/unpinned-scan"
  ok=1
  for f in unpinned.test.ts mentioned.test.ts pinned.test.ts; do
    [ -f "$fixtures/$f" ] || { printf 'no-unpinned-scan-in-tests --self-test: fixture missing: %s\n' "$f" >&2; exit 1; }
  done
  out=$(unpinned_files "$fixtures")
  case "$out" in
    *unpinned.test.ts*) printf 'no-unpinned-scan-in-tests --self-test: PASS (unpinned fixture caught)\n' ;;
    *) printf 'no-unpinned-scan-in-tests --self-test: FAIL (unpinned fixture not caught)\n' >&2; ok=0 ;;
  esac
  case "$out" in
    *mentioned.test.ts*) printf 'no-unpinned-scan-in-tests --self-test: PASS (mention-only fixture caught)\n' ;;
    *) printf 'no-unpinned-scan-in-tests --self-test: FAIL (mention-only fixture not caught)\n' >&2; ok=0 ;;
  esac
  case "$out" in
    *"/pinned.test.ts"*) printf 'no-unpinned-scan-in-tests --self-test: FAIL (pinned fixture flagged)\n' >&2; ok=0 ;;
    *) printf 'no-unpinned-scan-in-tests --self-test: PASS (pinned fixture passes)\n' ;;
  esac
  [ "$ok" = 1 ] && exit 0
  exit 1
fi

TEST_DIR="$PLUGIN_ROOT/mcp/trajectory-server/src/test"
[ -d "$TEST_DIR" ] || { printf 'no-unpinned-scan-in-tests: %s missing\n' "$TEST_DIR" >&2; exit 1; }

out=$(unpinned_files "$TEST_DIR" "$TEST_DIR/fixtures")
if [ -n "$out" ]; then
  while IFS= read -r f; do
    printf '%s: references scan.sh/scan_run/project_scan without a pinScanEnv( call (src/test/helpers.ts) or a TRAJECTORY_DB_PATH assignment outside comments\n' "${f#"$PLUGIN_ROOT/"}"
  done <<< "$out"
  printf '\nno-unpinned-scan-in-tests: FAIL\n' >&2
  exit 1
fi

printf 'no-unpinned-scan-in-tests: PASS\n'
