#!/usr/bin/env bash
# L6 chain runner — drives ALL 13 journey rows sequentially through ONE
# continuous Claude Code session (`claude --session-id` / `--resume`).
# State carries across rows. See tests/EVALUATION.md for the journey spec
# and tests/dogfood/l6-chain/chain-manifest.json for the step manifest.
#
# Usage:
#   bash tests/dogfood/run-l6-chain.sh                         # full chain
#   bash tests/dogfood/run-l6-chain.sh --from 7                # start at row 7
#   bash tests/dogfood/run-l6-chain.sh --halt-on-fail 0        # don't halt
#
# Per-step logs land under ~/.claude/tmb/l6-chain-runs/<run-id>/
# (or $L6C_RUNS_DIR if set). Each step writes:
#   step-NN-name/
#     pre-state.sql      — DB snapshot before this row fired
#     user-input.txt     — the user prompt sent
#     bro-response.txt   — bro's text reply (last text block)
#     tool-uses.jsonl    — bro's tool_use entries this turn
#     post-state.sql     — DB snapshot after the row's turn
#     post-state.diff    — pre→post text diff
#     scorers.json       — per-scorer pass/fail
#     seed-applied.sql   — between-row seed (post-AUQ pseudo-data), if any

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
export PLUGIN_ROOT
export TMB_HEADLESS=1

MANIFEST="$HERE/l6-chain/chain-manifest.json"
SEEDS_DIR="$HERE/l6-chain/seeds"

START_FROM=1
HALT_ON_FAIL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from)         START_FROM="$2"; shift 2 ;;
    --halt-on-fail) HALT_ON_FAIL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n" >&2
  exit 1
fi
for cmd in claude sqlite3 jq git diff; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd" >&2
    exit 1
  fi
done
[ -f "$MANIFEST" ] || { printf "❌ manifest not found: %s\n" "$MANIFEST" >&2; exit 1; }

# shellcheck source=tests/dogfood/lib/smoke-helpers.sh
. "$HERE/lib/smoke-helpers.sh"
l5_pre_flight_or_abort "$PLUGIN_ROOT"

# shellcheck source=tests/dogfood/lib/l6-chain-helpers.sh
. "$HERE/lib/l6-chain-helpers.sh"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RUNS_ROOT="${L6C_RUNS_DIR:-$HOME/.claude/tmb/l6-chain-runs}"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"
RESULTS_JSONL="$RUN_DIR/_results.jsonl"
: > "$RESULTS_JSONL"

printf '=== L6 chain run %s ===\n' "$RUN_ID"
printf '  manifest: %s\n' "$MANIFEST"
printf '  logs:     %s\n' "$RUN_DIR"

# One scratch project for the whole chain.
PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

INITIAL_FIXTURE=$(jq -r '.initial_fixture' "$MANIFEST")
printf '  fixture:  %s\n' "$INITIAL_FIXTURE"
l5_seed_db "$PROJECT" "$INITIAL_FIXTURE" || { printf "❌ fixture seed failed\n" >&2; exit 1; }

SESSION_ID=$(l6c_uuid)
printf '  session:  %s\n' "$SESSION_ID"
printf '\n'

CHAIN_TRAJECTORY="$RUN_DIR/chain-trajectory.jsonl"
: > "$CHAIN_TRAJECTORY"

STEP_COUNT=$(jq -r '.steps | length' "$MANIFEST")
CHAIN_PASS=0
CHAIN_FAIL=0

for idx in $(seq 0 $((STEP_COUNT - 1))); do
  step_id=$(jq -r ".steps[$idx].id"   "$MANIFEST")
  step_name=$(jq -r ".steps[$idx].name" "$MANIFEST")
  row_rel=$(jq -r ".steps[$idx].row_dir" "$MANIFEST")
  seed_before=$(jq -r ".steps[$idx].seed_before // empty" "$MANIFEST")
  seed_after=$(jq -r  ".steps[$idx].seed_after  // empty" "$MANIFEST")
  halt_step=$(jq -r   ".steps[$idx].halt_on_fail" "$MANIFEST")

  if [ "$step_id" -lt "$START_FROM" ]; then
    printf -- "── step %d (%s): SKIP (before --from)\n" "$step_id" "$step_name"
    continue
  fi

  ROW_DIR="$HERE/$row_rel"
  if [ ! -d "$ROW_DIR" ]; then
    printf "  ✗ step %d: row dir missing: %s\n" "$step_id" "$ROW_DIR" >&2
    CHAIN_FAIL=$((CHAIN_FAIL + 1))
    [ "$HALT_ON_FAIL" = "1" ] && [ "$halt_step" = "true" ] && break
    continue
  fi

  STEP_DIR=$(printf "%s/step-%02d-%s" "$RUN_DIR" "$step_id" "${step_name#[0-9][0-9]-}")
  mkdir -p "$STEP_DIR"
  printf "\n── step %d (%s) ──\n" "$step_id" "$step_name"

  if [ -n "$seed_before" ] && [ "$seed_before" != "null" ]; then
    SEED_BEFORE_PATH="$HERE/l6-chain/$seed_before"
    printf "  seed_before: %s\n" "$seed_before"
    l6c_apply_seed "$PROJECT" "$SEED_BEFORE_PATH"
    cp "$SEED_BEFORE_PATH" "$STEP_DIR/seed-before.sql" 2>/dev/null || true
  fi

  # Per-row setup.sh (mirrors L5 — extra pre-state on top of seeds).
  if [ -f "$ROW_DIR/setup.sh" ]; then
    bash "$ROW_DIR/setup.sh" "$PROJECT" "$ROW_DIR" || {
      printf "  ✗ step %d: setup.sh failed\n" "$step_id" >&2
      CHAIN_FAIL=$((CHAIN_FAIL + 1))
      [ "$HALT_ON_FAIL" = "1" ] && [ "$halt_step" = "true" ] && break
      continue
    }
  fi

  l6c_snapshot_db "$PROJECT" "$STEP_DIR/pre-state.sql"
  cp "$ROW_DIR/prompt.txt" "$STEP_DIR/user-input.txt"

  # Prepend the test-mode AUQ-suppression prefix on the FIRST turn only.
  IS_FIRST=0
  if [ "$step_id" = "1" ] || ! [ -s "$CHAIN_TRAJECTORY" ]; then
    IS_FIRST=1
  fi
  PROMPT=$(cat "$ROW_DIR/prompt.txt")
  if [ "$IS_FIRST" = "1" ]; then
    PROMPT="$(_l5_test_prompt_prefix)$PROMPT"
  fi

  TURN_JSONL="$STEP_DIR/turn.jsonl"
  printf "  turn: claude --%s\n" "$([ "$IS_FIRST" = "1" ] && echo "session-id $SESSION_ID" || echo "resume $SESSION_ID")"
  l6c_send_turn "$PROJECT" "$SESSION_ID" "$IS_FIRST" "$PROMPT" "$TURN_JSONL"

  cat "$TURN_JSONL" >> "$CHAIN_TRAJECTORY"
  cp "$CHAIN_TRAJECTORY" "$PROJECT/trajectory.jsonl"

  jq -r 'select(.type=="assistant") | .message.content[] | select(.type=="text") | .text' \
    "$TURN_JSONL" 2>/dev/null | tail -c 4000 > "$STEP_DIR/bro-response.txt" || true
  jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use")' \
    "$TURN_JSONL" 2>/dev/null > "$STEP_DIR/tool-uses.jsonl" || true

  l6c_snapshot_db "$PROJECT" "$STEP_DIR/post-state.sql"
  diff -u "$STEP_DIR/pre-state.sql" "$STEP_DIR/post-state.sql" > "$STEP_DIR/post-state.diff" 2>/dev/null || true

  TOKENS=$(jq -s 'map(select(.type=="result") | (.usage.input_tokens // 0) + (.usage.output_tokens // 0)) | add // 0' \
    "$TURN_JSONL" 2>/dev/null || echo 0)
  DURATION_MS=$(jq -s 'map(select(.type=="result") | .duration_ms // 0) | add // 0' \
    "$TURN_JSONL" 2>/dev/null || echo 0)

  # Score this step against the cumulative DB.
  STEP_FAILS=0
  SCENARIO_NAME="$step_name" RUN_ID="$RUN_ID" \
    l6c_score_step "$PROJECT" "$step_name" "$ROW_DIR" "$RUN_ID" \
    > "$STEP_DIR/scorers.txt" 2>&1 || STEP_FAILS=$?

  # Minimal scorers.json for chain-summary parsing.
  jq -n --arg id "$step_id" --arg name "$step_name" --arg fails "$STEP_FAILS" \
        --arg tokens "$TOKENS" --arg duration "$DURATION_MS" \
        '{id: ($id|tonumber), name: $name, scorer_fails: ($fails|tonumber), tokens: ($tokens|tonumber), duration_ms: ($duration|tonumber)}' \
    > "$STEP_DIR/scorers.json"

  if [ "$STEP_FAILS" -eq 0 ]; then
    STATUS='✅ pass'
    CHAIN_PASS=$((CHAIN_PASS + 1))
    printf "  ✓ step %d passed (tokens=%s duration=%sms)\n" "$step_id" "$TOKENS" "$DURATION_MS"
  else
    STATUS='❌ fail'
    CHAIN_FAIL=$((CHAIN_FAIL + 1))
    printf "  ✗ step %d failed (%s scorer fails)\n" "$step_id" "$STEP_FAILS"
  fi

  jq -n --arg id "$step_id" --arg name "$step_name" --arg status "$STATUS" \
        --arg fails "$STEP_FAILS" --arg tokens "$TOKENS" --arg duration "$DURATION_MS" \
        '{id: ($id|tonumber), name: $name, status: $status, scorer_fails: ($fails|tonumber), tokens: ($tokens|tonumber), duration_ms: ($duration|tonumber)}' \
    >> "$RESULTS_JSONL"

  if [ "$STEP_FAILS" -ne 0 ] && [ "$HALT_ON_FAIL" = "1" ] && [ "$halt_step" = "true" ]; then
    printf "  ── halting chain at first failure (per step manifest halt_on_fail) ──\n"
    break
  fi

  if [ -n "$seed_after" ] && [ "$seed_after" != "null" ]; then
    SEED_AFTER_PATH="$HERE/l6-chain/$seed_after"
    printf "  seed_after: %s\n" "$seed_after"
    l6c_apply_seed "$PROJECT" "$SEED_AFTER_PATH"
    cp "$SEED_AFTER_PATH" "$STEP_DIR/seed-applied.sql" 2>/dev/null || true
  fi
done

l6c_write_chain_summary "$RUN_DIR" "$RESULTS_JSONL"

printf "\n========================================\n"
printf "L6 chain: %d passed, %d failed\n" "$CHAIN_PASS" "$CHAIN_FAIL"
printf "Logs:     %s\n" "$RUN_DIR"
printf "Summary:  %s/chain-summary.md\n" "$RUN_DIR"

[ "$CHAIN_FAIL" = "0" ] && exit 0 || exit 1
