#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../../../../scripts/hooks/example-gate.sh"
PROJECT="$(mktemp -d)"
trap 'rm -rf "$PROJECT"' EXIT
export CLAUDE_PROJECT_DIR="$PROJECT"
echo '{}' | bash "$HOOK"
