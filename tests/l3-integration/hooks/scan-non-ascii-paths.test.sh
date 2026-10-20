#!/usr/bin/env bash
# Regression test: scan.sh emits valid JSON when a repo contains a non-ASCII tracked path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-scan-non-ascii-paths.XXXXXX")
trap 'rm -rf "$WORKSPACE"' EXIT

# Scan shells out to `claude plugin list`; a stub keeps the run hermetic (the
# real CLI writes its own state under HOME).
mkdir -p "$WORKSPACE/stub-bin"
printf '#!/usr/bin/env bash\necho "[]"\n' > "$WORKSPACE/stub-bin/claude"
chmod +x "$WORKSPACE/stub-bin/claude"
export PATH="$WORKSPACE/stub-bin:$PATH"

# Under the runner's TMB_TEST_RUN_ID scan.sh requires a pinned DB; an empty one
# keeps resource discovery off the project's trajectory DB.
export TRAJECTORY_DB_PATH="$WORKSPACE/trajectory.db"
: > "$TRAJECTORY_DB_PATH"

REPO="$WORKSPACE/testrepo"
mkdir -p "$REPO/subdir"

printf 'content\n' > "$REPO/subdir/⊗.txt"
printf 'plain\n' > "$REPO/plain.txt"

git -C "$REPO" init -q
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "initial commit"

SCAN_OUT=$(bash "$PLUGIN_ROOT/scripts/scan.sh" "$WORKSPACE")
SCAN_RC=$?

test_case "scan exits 0 on repo with non-ASCII path"
assert_exit_code 0 "$SCAN_RC" "scan exit code"

test_case "scan output is valid JSON"
if printf '%s' "$SCAN_OUT" | jq -e . >/dev/null 2>&1; then
  _pass
else
  _fail "scan output is not valid JSON: $SCAN_OUT"
fi

test_case "non-ASCII path appears in .files[].path"
match=$(printf '%s' "$SCAN_OUT" | jq -e '.files[] | select(.path | endswith("⊗.txt"))' 2>/dev/null || true)
if [ -n "$match" ]; then
  _pass
else
  _fail "⊗.txt not found in .files[].path"
fi

summarize
printf "PASS scan-non-ascii-paths\n"
