#!/usr/bin/env bash
# Lint: every symlink in the repo must point at an existing target.
#
# Catches: broken symlinks left behind after file moves/deletes
# (e.g. skills/*/scripts/ pointing at deleted skill dirs).
#
# Only checks git-tracked symlinks (mode 120000); untracked + gitignored paths are out of scope.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BROKEN=0
TOTAL=0

while IFS= read -r link; do
  TOTAL=$((TOTAL + 1))
  if ! [ -e "$link" ]; then
    target=$(readlink "$link")
    printf "BROKEN symlink: %s -> %s\n" "$link" "$target" >&2
    BROKEN=$((BROKEN + 1))
  fi
done < <(git ls-files -s | awk '$1=="120000"{print $4}' | sort)

if [ "$BROKEN" -gt 0 ]; then
  printf "\n%d broken symlink(s) found (checked %d total).\n" "$BROKEN" "$TOTAL" >&2
  exit 1
fi

printf "symlink-targets: %d symlink(s) checked, all resolve.\n" "$TOTAL"
