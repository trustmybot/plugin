#!/usr/bin/env bash
# selftest.sh — run all benchmark tools against fixtures and assert sane output.
# Exit 0 if all assertions pass, non-zero on any failure.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/fixtures/sessions"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  local expect="$3"
  if echo "$result" | grep -qF "$expect"; then
    printf '  PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s\n' "$label" >&2
    printf '    expected to contain: %s\n' "$expect" >&2
    printf '    got: %s\n' "$result" >&2
    FAIL=$((FAIL + 1))
  fi
}

check_nonempty() {
  local label="$1"
  local result="$2"
  if [ -n "$result" ]; then
    printf '  PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL: %s (empty output)\n' "$label" >&2
    FAIL=$((FAIL + 1))
  fi
}

TMPDIR_ST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ST"' EXIT

printf '=== codex-agent-materialization.mjs ===\n'

if command -v node >/dev/null 2>&1; then
  CAM_OUT="$(node "$HERE/codex-agent-materialization.selftest.mjs" "$TMPDIR_ST")"
  check "materialization benchmark helpers" "$CAM_OUT" 'selftest passed'
  if node "$HERE/codex-agent-materialization.mjs" >/dev/null 2>&1; then
    printf '  FAIL: materialization benchmark rejects missing arguments\n' >&2
    FAIL=$((FAIL + 1))
  else
    printf '  PASS: materialization benchmark rejects missing arguments\n'
    PASS=$((PASS + 1))
  fi
else
  printf 'WARNING: node not available — skipping Codex materialization benchmark selftest\n'
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'WARNING: python3 not available — skipping Python benchmark selftests\n'
  printf '\n========================================\n'
  printf 'Benchmark selftest: %d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
  exit
fi

printf '=== replay-session.sh ===\n'

OUT_5TURN_JSONL="$TMPDIR_ST/replay-5turn.jsonl"
bash "$HERE/replay-session.sh" "$FIXTURES/bro-5turn.jsonl" > "$OUT_5TURN_JSONL"

check_nonempty "bro-5turn produces output" "$(cat "$OUT_5TURN_JSONL")"
check "bro-5turn turn_index present" "$(cat "$OUT_5TURN_JSONL")" '"turn_index"'
check "bro-5turn input_tokens present" "$(cat "$OUT_5TURN_JSONL")" '"input_tokens"'
check "bro-5turn cache_read_tokens present" "$(cat "$OUT_5TURN_JSONL")" '"cache_read_tokens"'
check "bro-5turn hook_injected_bytes present" "$(cat "$OUT_5TURN_JSONL")" '"hook_injected_bytes"'
check "bro-5turn tool_calls present" "$(cat "$OUT_5TURN_JSONL")" '"tool_calls"'
check "bro-5turn detects hook injection >0" "$(cat "$OUT_5TURN_JSONL")" '"hook_injected_bytes": 1'

TABLE_OUT="$(bash "$HERE/replay-session.sh" "$FIXTURES/bro-5turn.jsonl" --table)"
check "bro-5turn --table header" "$TABLE_OUT" 'TURN'
check "bro-5turn --table row 1" "$TABLE_OUT" 'task_list'

OUT_SPAWN_JSONL="$TMPDIR_ST/replay-spawn.jsonl"
bash "$HERE/replay-session.sh" "$FIXTURES/bro-with-spawn.jsonl" > "$OUT_SPAWN_JSONL"
check_nonempty "bro-with-spawn produces output" "$(cat "$OUT_SPAWN_JSONL")"

printf '\n=== tokens-per-turn.sh ===\n'

TPT_OUT="$(bash "$HERE/tokens-per-turn.sh" "$OUT_5TURN_JSONL")"
check_nonempty "tokens-per-turn produces output" "$TPT_OUT"
check "tokens-per-turn has avg" "$TPT_OUT" 'avg='
check "tokens-per-turn has p50" "$TPT_OUT" 'p50='
check "tokens-per-turn has p95" "$TPT_OUT" 'p95='
check "tokens-per-turn has turn count" "$TPT_OUT" 'over'

printf '\n=== cache-stability.sh ===\n'

CS_OUT="$(bash "$HERE/cache-stability.sh" "$OUT_5TURN_JSONL" "$OUT_5TURN_JSONL")"
check_nonempty "cache-stability produces output" "$CS_OUT"
check "cache-stability has SHARED_PFX column" "$CS_OUT" 'SHARED_PFX'
check "cache-stability has DRIFT column" "$CS_OUT" 'DRIFT'
check "cache-stability shows TOT row" "$CS_OUT" 'TOT'
check "cache-stability identical sessions drift=0" "$CS_OUT" '0         '

printf '\n=== spawn-reads.sh ===\n'

SR_OUT="$(bash "$HERE/spawn-reads.sh" "$FIXTURES/bro-with-spawn.jsonl")"
check_nonempty "spawn-reads produces output" "$SR_OUT"
check "spawn-reads has spawns field" "$SR_OUT" 'spawns='
check "spawn-reads has reads field" "$SR_OUT" 'reads='
check "spawn-reads has mean field" "$SR_OUT" 'mean_reads_per_spawn='
check "spawn-reads detects 2 spawns" "$SR_OUT" 'spawns=2'

SR_NOSPAWN="$(bash "$HERE/spawn-reads.sh" "$FIXTURES/bro-5turn.jsonl")"
check "spawn-reads no-spawn reports N/A" "$SR_NOSPAWN" 'mean_reads_per_spawn=N/A'

printf '\n========================================\n'
printf 'Benchmark selftest: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
