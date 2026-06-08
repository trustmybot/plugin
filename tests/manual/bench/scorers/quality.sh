#!/usr/bin/env bash
# Long-term engineering quality axis: does the work pay dividends for
# future sessions? Composite of 5 mechanical sub-checks:
#
# 1. lint_pass         — the project's lint command (if any) passes after
#                        the agent's work
# 2. commit_msg_format — at least one commit follows Conventional Commits
# 3. summaries_fresh   — every file the agent touched has a non-NULL summary
#                        in file_registry (arm A only — raw arm gets 0/1 here)
# 4. adr_present       — when the diff touches arch-impact paths, an ADR was
#                        authored at docs/trustmybot/architecture/manual/decisions/
# 5. first_attempt_pass — at least one validation_attempts.verdict='pass' on
#                        first attempt (arm A only)
#
# Each sub-check is 0/1; composite score = sum.
#
# Usage:
#   bash quality.sh <project_dir> [db_path]
#
# Writes JSON to stdout: { axis, score, sub: { ... }, notes: [...] }

set -uo pipefail

PROJECT="${1:?project_dir required}"
DB="${2:-}"

notes=()
SCORE=0
LINT_PASS=0
COMMIT_FORMAT=0
SUMMARIES_FRESH=0
ADR_PRESENT=0
FIRST_PASS=0

# --- Sub-check 1: lint passes ---
# Try a few common entry points. Skip if none exist (counts as 0; arm-on-arm
# comparison only — if neither arm hits a lint check, both get 0 and the
# overall axis tilts on the other 4 sub-checks).
LINT_CMD=""
if [ -f "$PROJECT/package.json" ] && [ -f "$PROJECT/node_modules/.bin/eslint" ]; then
  LINT_CMD="$PROJECT/node_modules/.bin/eslint . --quiet"
elif [ -f "$PROJECT/pyproject.toml" ] && command -v ruff >/dev/null 2>&1; then
  LINT_CMD="ruff check $PROJECT"
elif [ -f "$PROJECT/.flake8" ] && command -v flake8 >/dev/null 2>&1; then
  LINT_CMD="flake8 $PROJECT"
fi
if [ -n "$LINT_CMD" ]; then
  if $LINT_CMD >/dev/null 2>&1; then
    LINT_PASS=1
    SCORE=$((SCORE + 1))
  else
    notes+=("lint failed: $LINT_CMD")
  fi
else
  notes+=("no lint command detected; sub-check skipped")
fi

# --- Sub-check 2: Conventional Commits ---
# Read the latest 5 commits; one matching the conventional regex earns the
# point. Allows existing-baseline commits to count (the agent might do
# work that doesn't itself need a new commit type, but should still
# follow the convention when committing).
LAST_5=$(git -C "$PROJECT" log -5 --format='%s' 2>/dev/null || echo "")
if echo "$LAST_5" | grep -qE '^(🐛 |✨ |♻️ |🔥 |📝 |🧪 |⚡️ |🏗️ |🔧 |💄 |⏪ )?(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)(\([^)]+\))?:'; then
  COMMIT_FORMAT=1
  SCORE=$((SCORE + 1))
else
  notes+=("no conventional-commits message in last 5 commits")
fi

# --- Sub-check 3: world model populated (arm A only) ---
# Per-file summaries (file_registry) were retired at v7; the world model now
# lives in the kuzu graph (ADR 0002). Proxy "the agent populated its world
# model" via the deep_scan_completed audit event in the trajectory DB.
if [ -n "$DB" ] && [ -f "$DB" ]; then
  SCANNED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='deep_scan_completed';" 2>/dev/null || echo 0)
  if [ "${SCANNED:-0}" -gt 0 ]; then
    SUMMARIES_FRESH=1
    SCORE=$((SCORE + 1))
  else
    notes+=("world model not populated (no deep_scan_completed audit)")
  fi
else
  notes+=("no trajectory DB; world-model sub-check is 0 by design (raw arm)")
fi

# --- Sub-check 4: ADR present when arch-impact ---
# Heuristic: if the diff touched docs/trustmybot/architecture/ or any schema
# file, expect a new ADR at docs/trustmybot/architecture/manual/decisions/.
TOUCHED_ARCH=$(git -C "$PROJECT" log --format='' --name-only HEAD 2>/dev/null \
  | grep -E '^(docs/trustmybot/architecture/|.*schema\.sql)' | head -1)
if [ -n "$TOUCHED_ARCH" ]; then
  ADRS=$(find "$PROJECT/docs/trustmybot/architecture/manual/decisions" -maxdepth 1 -name '*.md' 2>/dev/null \
    | grep -v -E '0001-example\.md$' | wc -l | tr -d ' ')
  if [ "$ADRS" -ge 1 ]; then
    ADR_PRESENT=1
    SCORE=$((SCORE + 1))
  else
    notes+=("arch-impact change touched but no ADR authored")
  fi
else
  # Non-arch-impact tasks get the point by default — nothing to demand.
  ADR_PRESENT=1
  SCORE=$((SCORE + 1))
fi

# --- Sub-check 5: first-attempt validation pass (arm A only) ---
if [ -n "$DB" ] && [ -f "$DB" ]; then
  FIRST=$(sqlite3 "$DB" \
    "SELECT 1 FROM validation_attempts WHERE attempt_n = 1 AND verdict = 'pass' LIMIT 1;" \
    2>/dev/null)
  if [ "$FIRST" = "1" ]; then
    FIRST_PASS=1
    SCORE=$((SCORE + 1))
  else
    notes+=("no first-attempt pass row in validation_attempts")
  fi
else
  notes+=("no trajectory DB; first-attempt-pass sub-check is 0 by design (raw arm)")
fi

NOTES_JSON=$(printf '%s\n' "${notes[@]}" | jq -R . | jq -s .)

jq -nc \
  --argjson score "$SCORE" \
  --argjson lint "$LINT_PASS" \
  --argjson commit "$COMMIT_FORMAT" \
  --argjson summaries "$SUMMARIES_FRESH" \
  --argjson adr "$ADR_PRESENT" \
  --argjson first_pass "$FIRST_PASS" \
  --argjson notes "$NOTES_JSON" \
  '{axis: "quality",
    score: $score,
    sub: {
      lint_pass: $lint,
      commit_msg_format: $commit,
      summaries_fresh: $summaries,
      adr_present: $adr,
      first_attempt_pass: $first_pass
    },
    notes: $notes}'
