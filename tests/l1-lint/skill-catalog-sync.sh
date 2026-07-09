#!/usr/bin/env bash
# Lint: shipped skills/ dirs match the seeded builtin-skill catalog rows.
#
# Catches the one silent-failure seam between the capability catalog and disk
# (post-#101, schema v20): the cheatcodes table is the FK target for
# skill-invocation-record.sh. If a shipped skills/<name>/ has no seed row, its
# invocations are silently dropped by that hook's FK check; if a seed row has no
# shipped dir, it's a dangling catalog entry pointing at a missing SKILL.md.
#
# Asserts EXACT-SET parity between:
#   - directories on disk:  each skills/<name>/SKILL.md → the set of <name>
#   - seeded catalog rows:   the <name> in the cheatcodes seed INSERT block of
#     mcp/trajectory-server/src/schema.sql with origin='builtin' AND kind='skill'

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILLS_DIR="$ROOT/skills"
SCHEMA="$ROOT/mcp/trajectory-server/src/schema.sql"

DISK_FILE=$(mktemp)
SEED_FILE=$(mktemp)
trap 'rm -f "$DISK_FILE" "$SEED_FILE"' EXIT

# Disk set: every skills/<name>/ that ships a SKILL.md.
for skill in "$SKILLS_DIR"/*/; do
  name=$(basename "$skill")
  [ -f "$skill/SKILL.md" ] && echo "$name"
done | sort -u > "$DISK_FILE"

if [ ! -s "$DISK_FILE" ]; then
  echo "  ✗ no skills/<name>/SKILL.md directories found on disk" >&2
  exit 1
fi

# Seed set: <name> from cheatcodes seed rows that are builtin skills.
# A seed row is `('<name>', 'skill', 'builtin', ...` — the first three columns
# are name, kind, origin (see the INSERT column list in schema.sql). Matching on
# that column order keeps the parser tied to the seed block, not to comments.
grep -oE "\('[^']+',[[:space:]]*'skill',[[:space:]]*'builtin'" "$SCHEMA" \
  | sed -E "s/^\('([^']+)'.*/\1/" | sort -u > "$SEED_FILE"

if [ ! -s "$SEED_FILE" ]; then
  echo "  ✗ no builtin-skill seed rows found in schema.sql" >&2
  exit 1
fi

failed=0

# Shipped on disk but not seeded → invocations silently dropped by the FK check.
ONLY_DISK=$(comm -23 "$DISK_FILE" "$SEED_FILE")
if [ -n "$ONLY_DISK" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] && echo "  ✗ skills/$name/ ships but has no builtin-skill seed row (invocations would be silently dropped)" >&2 && failed=1
  done <<< "$ONLY_DISK"
fi

# Seeded but no shipped dir → dangling catalog entry pointing at a missing skill.
ONLY_SEED=$(comm -13 "$DISK_FILE" "$SEED_FILE")
if [ -n "$ONLY_SEED" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] && echo "  ✗ builtin-skill seed row '$name' has no skills/$name/ dir (dangling catalog entry)" >&2 && failed=1
  done <<< "$ONLY_SEED"
fi

DISK_COUNT=$(wc -l < "$DISK_FILE" | tr -d ' ')

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "  Either add the missing skills/<name>/SKILL.md dir," >&2
  echo "  OR align the builtin-skill seed rows in mcp/trajectory-server/src/schema.sql." >&2
  exit 1
fi

echo "  ✓ $DISK_COUNT shipped skills match the builtin-skill seed rows"
echo ""
echo "Skill-catalog-sync: PASS"
