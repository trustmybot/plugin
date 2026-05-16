#!/usr/bin/env bash
# Lint: every *.md under commands/ must have a valid frontmatter block
# with `description` and `argument-hint` fields, a non-empty body,
# and a filename matching ^[a-z][a-z0-9-]*\.md$.
#
# Catches: missing fields, empty command bodies, incorrectly named command files.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

failed=0

for cmd in $(find commands -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort); do
  filename=$(basename "$cmd")

  # Filename must match ^[a-z][a-z0-9-]*\.md$
  if ! echo "$filename" | grep -qE '^[a-z][a-z0-9-]*\.md$'; then
    printf "  ✗ %s: filename must match ^[a-z][a-z0-9-]*\\.md$\n" "$cmd" >&2
    failed=1
    continue
  fi

  # Must have opening frontmatter delimiter
  first_line=$(head -1 "$cmd")
  if [ "$first_line" != "---" ]; then
    printf "  ✗ %s: missing opening '---' (no frontmatter)\n" "$cmd" >&2
    failed=1
    continue
  fi

  # Extract frontmatter block (between first two --- lines)
  fm=$(awk '/^---$/{c++; next} c==1' "$cmd" | head -50)

  # Required: description (non-empty value)
  if ! echo "$fm" | grep -qE '^description:[[:space:]]+\S'; then
    printf "  ✗ %s: missing or empty 'description:' field in frontmatter\n" "$cmd" >&2
    failed=1
    continue
  fi

  # Required: argument-hint key present (value may be empty for no-arg commands)
  if ! echo "$fm" | grep -qE '^argument-hint:'; then
    printf "  ✗ %s: missing 'argument-hint:' field in frontmatter\n" "$cmd" >&2
    failed=1
    continue
  fi

  # Body (lines after closing ---) must be non-empty
  body_lines=$(awk '/^---$/{c++; next} c>=2' "$cmd" | grep -c '\S' || true)
  if [ "$body_lines" -eq 0 ]; then
    printf "  ✗ %s: file body is empty (no content after frontmatter)\n" "$cmd" >&2
    failed=1
    continue
  fi

  printf "  ✓ %s\n" "$cmd"
done

echo ""
if [ $failed -ne 0 ]; then
  echo "Command-frontmatter: FAIL" >&2
  exit 1
fi
echo "Command-frontmatter: PASS"
