#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../../../../tests/lib/ts-hooks/example-gate.sh"
echo '{}' | bash "$HOOK"
