#!/usr/bin/env bash
# Pre-write lint for agent + skill files. Scans for two pattern classes
# the creators apply before writing any prompt file:
#   1. Pink-elephant negations — start-of-line `Don't`, `Never`, `Do not`,
#      mid-sentence `MUST NOT` / `do not` / `don't` / `never`.
#   2. Noise citations — issue numbers, memory paths, origin attributions,
#      decaying dates, PR/MR URLs, tombstones.
#
# Output: one finding per line on stdout. Exit 0 always (advisory).
# Caller (the creator skill) surfaces findings via AskUserQuestion.
#
# Usage:  prompt-author-lint.sh <path-to-md-file>

set -uo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: $0 <path-to-md-file>" >&2
  exit 0
fi

# Skip frontmatter (between the first two `---` lines).
BODY=$(awk '
  BEGIN { state="pre" }
  state=="pre"  && /^---$/ { state="fm"; next }
  state=="fm"   && /^---$/ { state="body"; next }
  state=="body" { print }
' "$FILE")

# Pink-elephant patterns.
echo "$BODY" | grep -nE "^(Don't|Never|Do not) " | while IFS= read -r line; do
  echo "[pink-elephant] $line"
done
echo "$BODY" | grep -nE "MUST NOT|\bdo not\b|\bdon't\b|\bnever\b" | grep -ivE "^[0-9]+:[[:space:]]*(#|//|--)" | while IFS= read -r line; do
  # Skip if already exempt with LOAD-BEARING-SAFETY comment on same line.
  if echo "$line" | grep -q "LOAD-BEARING-SAFETY"; then continue; fi
  echo "[pink-elephant-mid] $line"
done

# Noise citations.
echo "$BODY" | grep -nE '#[0-9]{1,5}\b|\(#[A-Z]+[0-9]+\)|\[bro #[0-9]+\]' | while IFS= read -r line; do
  echo "[issue-number] $line"
done
echo "$BODY" | grep -nE 'feedback_[a-z_-]+\.md|~/\.claude/projects/' | while IFS= read -r line; do
  echo "[memory-path] $line"
done
echo "$BODY" | grep -niE 'caught in|prior incident|regression during|2× during|2x during' | while IFS= read -r line; do
  echo "[origin-attribution] $line"
done
echo "$BODY" | grep -nE '\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b' | while IFS= read -r line; do
  # Allow inside code fences or LOAD-BEARING-SAFETY exempt; this is best-effort.
  echo "[date] $line"
done
echo "$BODY" | grep -nE '![0-9]+|gitlab\.com/[^[:space:]]*/merge_requests/' | while IFS= read -r line; do
  echo "[pr-url] $line"
done

exit 0
