#!/usr/bin/env bash
# Lint: nothing cites the retired shell gates (GH 1692) — a scripts/hooks/<gate>.sh
# path or the persona and scope-fence shell libraries anywhere outside history,
# research, dist and fixtures, nor the gates' glob in docs or the TS sources.
# The gates run as mcp/trajectory-server/src/hooks/<gate>.ts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SELF="tests/l1-lint/no-retired-hook-gate-paths.sh"
EXCLUDES=(':!changelog.d' ':!CHANGELOG.md' ':!research' ':!**/dist/**' ':!tests/fixtures' ':!tests/l1-lint/fixtures' ':!tests/l0-install/upgrade-smoke.Dockerfile' ':!mcp/trajectory-server/src/test/fixtures' ":!$SELF")

HITS="$(git grep -nE 'scripts/hooks/[A-Za-z0-9_-]+\.sh|lib/(persona|scope-fence)\.sh' -- . "${EXCLUDES[@]}" || true)"
GLOB_HITS="$(git grep -nF 'scripts/hooks/*.sh' -- docs mcp/trajectory-server/src || true)"

if [ -n "$HITS$GLOB_HITS" ]; then
  printf '%s\n' "$HITS" "$GLOB_HITS" | sed '/^$/d' >&2
  printf "no-retired-hook-gate-paths: FAIL (cite mcp/trajectory-server/src/hooks/<gate>.ts instead)\n" >&2
  exit 1
fi
printf "no-retired-hook-gate-paths: PASS\n"
