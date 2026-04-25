#!/usr/bin/env bash
# Lint: every SKILL.md (in skills/ and templates/skills/) must have a
# valid frontmatter block with `name` and `description` fields, and the
# `name` field must equal the parent directory name.
#
# Catches: typos in skill metadata, broken skill registration, mismatch
# between dir name (what CC discovers) and frontmatter name (what the
# skill identifies as).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

failed=0

# Find every SKILL.md under both plugin-shipped + template-shipped trees
for skill in $(find skills templates/skills -type f -name 'SKILL.md' 2>/dev/null | sort); do
  dir=$(dirname "$skill")
  dirname_base=$(basename "$dir")

  # Check frontmatter delimiters
  first_line=$(head -1 "$skill")
  if [ "$first_line" != "---" ]; then
    printf "  ✗ %s: missing opening '---' (no frontmatter)\n" "$skill" >&2
    failed=1
    continue
  fi

  # Extract frontmatter block (between first two --- lines)
  fm=$(awk '/^---$/{c++; next} c==1' "$skill" | head -50)

  # Required fields
  if ! echo "$fm" | grep -qE '^name:[[:space:]]+'; then
    printf "  ✗ %s: missing 'name:' field in frontmatter\n" "$skill" >&2
    failed=1
    continue
  fi
  if ! echo "$fm" | grep -qE '^description:[[:space:]]+'; then
    printf "  ✗ %s: missing 'description:' field in frontmatter\n" "$skill" >&2
    failed=1
    continue
  fi

  # name field must match dirname (without quotes)
  name=$(echo "$fm" | grep -E '^name:[[:space:]]+' | head -1 | sed -E 's/^name:[[:space:]]+//' | tr -d '"' | xargs)
  if [ "$name" != "$dirname_base" ]; then
    printf "  ✗ %s: name '%s' != dirname '%s' (CC discovers by dir, body identifies by name)\n" \
      "$skill" "$name" "$dirname_base" >&2
    failed=1
    continue
  fi

  printf "  ✓ %s\n" "$skill"
done

echo ""
if [ $failed -ne 0 ]; then
  echo "Skill-frontmatter: FAIL" >&2
  exit 1
fi
echo "Skill-frontmatter: PASS"
