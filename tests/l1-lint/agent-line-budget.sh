#!/usr/bin/env bash
# Enforce Lego cap on every agent that ships with the plugin.
#
# agents/ — workflow backbone (swe + pr-reviewer), ≤30-line total cap.
#
# templates/agents/ — Lego model:
#   template.md              ≤25 lines total (carries the full TMB integration contract)
#   swe.md, pr-reviewer.md  ≤30 lines total (backbone roles; byte-identical to agents/)
#   <consultant role>.md    ≤15 lines body (after frontmatter) — role flavor only;
#                           the contract lives in template.md, not here.
#
# Violation message links to the Lego model in templates/agents/template.md.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

BACKBONE_LIMIT=30
BASE_TEMPLATE_LIMIT=26  # raised from 25: persona opening added (#426 prompt rewrite)
ROLE_BODY_LIMIT=15
FAIL=0

# Count lines after the closing --- of frontmatter (the body).
body_lines() {
  local f="$1"
  awk '
    /^---$/ { fences++; next }
    fences >= 2 { count++ }
    END { print count }
  ' "$f"
}

check_backbone() {
  local label="$1" dir="$2"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  local files
  files=$(find "$dir" -maxdepth 1 -name '*.md' -type f | sort)
  if [ -z "$files" ]; then
    return 0
  fi
  printf "Enforcing %d-line cap on %s\n" "$BACKBONE_LIMIT" "$label"
  while IFS= read -r f; do
    local lines
    lines=$(wc -l < "$f" | tr -d ' ')
    if [ "$lines" -gt "$BACKBONE_LIMIT" ]; then
      printf "  ❌ %s: %d lines (over cap by %d)\n" "$f" "$lines" "$((lines - BACKBONE_LIMIT))"
      FAIL=$((FAIL + 1))
    else
      printf "  ✓ %s: %d lines\n" "$f" "$lines"
    fi
  done <<< "$files"
  printf "\n"
}

check_templates() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  printf "Enforcing Lego caps on %s\n" "$dir"

  # Base template — total line cap
  local base="$dir/template.md"
  if [ -f "$base" ]; then
    local lines
    lines=$(wc -l < "$base" | tr -d ' ')
    if [ "$lines" -gt "$BASE_TEMPLATE_LIMIT" ]; then
      printf "  ❌ template.md: %d total lines (cap %d) — trim the TMB integration contract in templates/agents/template.md\n" \
        "$lines" "$BASE_TEMPLATE_LIMIT"
      FAIL=$((FAIL + 1))
    else
      printf "  ✓ template.md: %d total lines\n" "$lines"
    fi
  fi

  # Backbone roles in templates/ — total line cap (byte-identical to agents/)
  for name in swe pr-reviewer; do
    local f="$dir/$name.md"
    if [ ! -f "$f" ]; then continue; fi
    local lines
    lines=$(wc -l < "$f" | tr -d ' ')
    if [ "$lines" -gt "$BACKBONE_LIMIT" ]; then
      printf "  ❌ %s: %d total lines (cap %d)\n" "$f" "$lines" "$BACKBONE_LIMIT"
      FAIL=$((FAIL + 1))
    else
      printf "  ✓ %s: %d total lines\n" "$f" "$lines"
    fi
  done

  # Consultant role templates — body-only cap
  local files
  files=$(find "$dir" -maxdepth 1 -name '*.md' -type f ! -name 'template.md' ! -name 'swe.md' ! -name 'pr-reviewer.md' | sort)
  if [ -z "$files" ]; then
    printf "\n"
    return 0
  fi
  while IFS= read -r f; do
    local blines
    blines=$(body_lines "$f")
    if [ "$blines" -gt "$ROLE_BODY_LIMIT" ]; then
      printf "  ❌ %s: %d body lines (cap %d) — role flavor should be ≤%d lines; shared contract belongs in templates/agents/template.md (Lego model)\n" \
        "$f" "$blines" "$ROLE_BODY_LIMIT" "$ROLE_BODY_LIMIT"
      FAIL=$((FAIL + 1))
    else
      printf "  ✓ %s: %d body lines\n" "$f" "$blines"
    fi
  done <<< "$files"
  printf "\n"
}

# Workflow backbone (global)
check_backbone "agents/ (global backbone)" "$PLUGIN_ROOT/agents"

# Consultant templates (opt-in) — Lego model
check_templates "$PLUGIN_ROOT/templates/agents"

if [ "$FAIL" -eq 0 ]; then
  printf "All agent files within Lego cap.\n"
  exit 0
else
  printf "%d agent file(s) over budget.\n" "$FAIL"
  exit 1
fi
