#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../../../../scripts/hooks/example-gate.sh"
PROJECT="$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-pinned.XXXXXX")"
trap 'rm -rf "$PROJECT"' EXIT
export CLAUDE_PROJECT_DIR="$PROJECT"
echo '{}' | bash "$HOOK"
