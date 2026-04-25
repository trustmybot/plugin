#!/usr/bin/env bash
# Enforce Lego cap on every agent that ships with the plugin.
#
# As of v0.3.0:
#   - agents/        → workflow backbone (swe + pr-reviewer), GLOBAL.
#                      Same Lego cap as templates: identity + role + boundary,
#                      "rest comes from skills."
#   - templates/agents/ → opt-in consultant templates (architect, cto, ceo, pm),
#                      copied into projects on demand.
#
# Both directories enforce the same ≤30-line cap.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

LIMIT=30
FAIL=0

check_dir() {
  local label="$1" dir="$2"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  local files
  files=$(find "$dir" -maxdepth 1 -name '*.md' -type f | sort)
  if [ -z "$files" ]; then
    return 0
  fi
  printf "Enforcing %d-line Lego cap on %s\n" "$LIMIT" "$label"
  while IFS= read -r f; do
    local lines
    lines=$(wc -l < "$f" | tr -d ' ')
    if [ "$lines" -gt "$LIMIT" ]; then
      printf "  ❌ %s: %d lines (over cap by %d)\n" "$f" "$lines" "$((lines - LIMIT))"
      FAIL=$((FAIL + 1))
    else
      printf "  ✓ %s: %d lines\n" "$f" "$lines"
    fi
  done <<< "$files"
  printf "\n"
}

# Workflow backbone (global)
check_dir "agents/ (global backbone)" "$PLUGIN_ROOT/agents"

# Consultant templates (opt-in)
check_dir "templates/agents/ (consultant templates)" "$PLUGIN_ROOT/templates/agents"

if [ "$FAIL" -eq 0 ]; then
  printf "All agent files within Lego cap.\n"
  exit 0
else
  printf "%d agent file(s) over budget.\n" "$FAIL"
  exit 1
fi
