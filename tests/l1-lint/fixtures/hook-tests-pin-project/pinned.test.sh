#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../../../../scripts/hooks/example-gate.sh"
PROJECT="$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-pinned.XXXXXX")"
trap 'rm -rf "$PROJECT"' EXIT
export CLAUDE_PROJECT_DIR="$PROJECT"
echo '{}' | bash "$HOOK"
