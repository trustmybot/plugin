#!/usr/bin/env bash
# Self-test for assert-materialized.sh (issue #95). Builds synthetic project
# .claude/ trees and asserts tmb_materialized_on_disk detects a materialized
# agent md (skill present in its skills: frontmatter), a bro CLAUDE.md reference,
# and rejects an absent agent md or one whose header lacks the skill.
# Run: bash tests/l5-l6/lib/assert-materialized-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/assert-materialized.sh"

PASS=0
FAIL=0
TMP=$(mktemp -d -t assert-materialized-test-XXXX)
trap 'rm -rf "$TMP"' EXIT

assert_detect() {
  local label="$1" project="$2" agent="$3" skill="$4" want="$5"
  tmb_materialized_on_disk "$project" "$agent" "$skill"
  local got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    echo "  PASS $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $label — expected exit=$want, got exit=$got"
  fi
}

# ---- Project where swe was materialized with feature-dev -------------------
# Mirrors what cheatcode_install writes: global swe.md copied local, the skill
# added to its skills: [...] frontmatter.
MAT="$TMP/materialized"
mkdir -p "$MAT/.claude/agents"
cat > "$MAT/.claude/agents/swe.md" <<'EOF'
---
name: swe
skills: [tmb_swe-checklist, feature-dev]
---

# You are swe
EOF
mkdir -p "$MAT/.claude"
cat > "$MAT/.claude/CLAUDE.md" <<'EOF'
# You are bro

Installed skill: code-review — load it when its capability is needed.
EOF

# ---- Project where swe md exists but the skill is NOT in the header --------
NO_SKILL="$TMP/no-skill"
mkdir -p "$NO_SKILL/.claude/agents"
cat > "$NO_SKILL/.claude/agents/swe.md" <<'EOF'
---
name: swe
skills: [tmb_swe-checklist]
---

# You are swe
EOF

# ---- Project where the agent md was never materialized ---------------------
ABSENT="$TMP/absent"
mkdir -p "$ABSENT/.claude"

echo "== detect: feature-dev materialized into swe =="
assert_detect "swe.md lists feature-dev" "$MAT" "swe" "feature-dev" 0

echo "== detect: bare skill matches plugin-prefixed query =="
assert_detect "swe.md feature-dev via prefixed query" "$MAT" "swe" "tmb:feature-dev" 0

echo "== detect: bro CLAUDE.md references code-review =="
assert_detect "bro CLAUDE.md references code-review" "$MAT" "bro" "code-review" 0

echo "== reject: agent md present but skill not in header =="
assert_detect "swe.md missing feature-dev → fail" "$NO_SKILL" "swe" "feature-dev" 1

echo "== reject: agent md absent =="
assert_detect "pr-reviewer.md never materialized → fail" "$ABSENT" "pr-reviewer" "code-review" 1

echo "== reject: bro CLAUDE.md does not reference the skill =="
assert_detect "bro CLAUDE.md missing skill → fail" "$NO_SKILL" "bro" "feature-dev" 1

echo "== reject: substring of a longer skill name must not match =="
assert_detect "feature (substring) must not match feature-dev" "$MAT" "swe" "feature" 1

echo
echo "assert-materialized-test: $PASS pass / $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
