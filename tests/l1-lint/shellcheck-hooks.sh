#!/usr/bin/env bash
# Lint: shellcheck every shell script in scripts/ and tests/.
#
# Catches: the `set -o pipefail` silent-allow class (we hit it in v0.1.0
# with grep returning non-zero making the script exit silently). Catches
# unquoted variables, command-substitution races, etc.
#
# If shellcheck is not installed, this lint is SKIPPED with a warning.
# CI installs shellcheck (apt-get install shellcheck).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "  ⊘ shellcheck not installed — skipping (install via 'brew install shellcheck' or 'apt-get install shellcheck')"
  echo "Shellcheck-hooks: SKIPPED"
  exit 0
fi

failed=0

# Scripts we own that should be shellcheck-clean
SHELL_FILES=$(find scripts tests -type f -name '*.sh' \
  -not -path './node_modules/*' \
  -not -path './*/node_modules/*' \
  | sort)

for script in $SHELL_FILES; do
  if shellcheck -S warning -e SC1091 "$script"; then
    printf "  ✓ %s\n" "$script"
  else
    printf "  ✗ %s\n" "$script" >&2
    failed=1
  fi
done

echo ""
if [ $failed -ne 0 ]; then
  echo "Shellcheck-hooks: FAIL" >&2
  exit 1
fi
echo "Shellcheck-hooks: PASS"
