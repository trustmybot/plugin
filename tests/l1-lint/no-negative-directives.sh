#!/usr/bin/env bash
# Scan skills + agents + CLAUDE.md for negation directive patterns.
# Reports findings (warn only; exit 0 always). CI displays the finding count.
#
# Lines containing <!-- LOAD-BEARING-SAFETY: ... --> are exempt.
# Future iteration may promote to FAIL after a clean audit pass.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FINDINGS=0

check_file() {
  local file="$1"
  local rel="${file#"$PLUGIN_ROOT/"}"
  local lineno=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))

    # Skip lines with the safety exemption marker
    case "$line" in
      *'<!-- LOAD-BEARING-SAFETY:'*) continue ;;
    esac

    matched=""
    level="WARN"

    # Strip leading whitespace + markdown list/blockquote markers for start-of-line checks
    stripped="${line#"${line%%[! ]*}"}"  # ltrim spaces
    stripped="${stripped#- }"
    stripped="${stripped#\* }"
    stripped="${stripped#+ }"
    stripped="${stripped#> }"
    stripped="${stripped#"- "}"

    # Start-of-line negative imperatives
    case "$stripped" in
      "Don't "*)  matched="start-of-line Don't" ;;
      "DON'T "*)  matched="start-of-line DON'T" ;;
      "Do not "* | "do not "*) matched="start-of-line do not" ;;
    esac

    # "never" anywhere on the line (case-insensitive)
    if [ -z "$matched" ]; then
      if echo "$line" | grep -qiE '\bnever\b'; then
        matched="never"
      fi
    fi

    # MUST NOT / must not
    if [ -z "$matched" ]; then
      if echo "$line" | grep -qE '(MUST NOT|must not)'; then
        matched="MUST NOT / must not"
      fi
    fi

    # Mid-sentence "do not"
    if [ -z "$matched" ]; then
      if echo "$line" | grep -qiE '\bdo not\b'; then
        matched="mid-sentence do not"
      fi
    fi

    # Mid-sentence "don't" — INFO only (narrative prose uses contractions)
    if [ -z "$matched" ]; then
      if echo "$line" | grep -qiE "\bdon't\b"; then
        matched="mid-sentence don't"
        level="INFO"
      fi
    fi

    if [ -n "$matched" ]; then
      printf "%s:%d: [%s] %s\n" "$rel" "$lineno" "$level" "$matched"
      FINDINGS=$((FINDINGS + 1))
    fi
  done < "$file"
}

# Collect files to scan
FILES=("$PLUGIN_ROOT/CLAUDE.md")
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$PLUGIN_ROOT/skills" -name "SKILL.md" -print0)
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$PLUGIN_ROOT/agents" -name "*.md" -print0)
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$PLUGIN_ROOT/templates/agents" -name "*.md" -print0)

for f in "${FILES[@]}"; do
  check_file "$f"
done

echo ""
printf "no-negative-directives: %d finding(s). (warn-only; exit 0)\n" "$FINDINGS"
exit 0
