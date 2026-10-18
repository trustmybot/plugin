#!/usr/bin/env bash
# Guards the live-DB shim against the CI layout: a checkout whose parent
# directory is a plain directory, not a git repository. The optional ancestor
# lines in live_db_shim_protected must stay status-neutral under `set -e`.
#
# Usage: bash tests/l1-lint/live-db-shim-parent-layout.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT

fail=0
pass() { echo "✓ $1"; }
flunk() { echo "❌ $1"; fail=1; }

mkdir -p "$D/parent"
git init -q "$D/parent/checkout"
checkout_real="$(cd "$D/parent/checkout" && pwd -P)"

# shellcheck source=../lib/live-db-shim.sh
. "$PLUGIN_ROOT/tests/lib/live-db-shim.sh"

out="$(set -euo pipefail; live_db_shim_protected "$D/parent/checkout")"
status=$?

if [ "$status" -eq 0 ]; then
  pass "live_db_shim_protected exits 0 under set -euo pipefail with a plain parent directory"
else
  flunk "live_db_shim_protected exited $status under set -euo pipefail with a plain parent directory"
fi

if printf '%s\n' "$out" | grep -Fx "$checkout_real/.claude/tmb" >/dev/null; then
  pass "output lists the checkout's .claude/tmb"
else
  flunk "output is missing $checkout_real/.claude/tmb"
fi

exit "$fail"
