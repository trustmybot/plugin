#!/usr/bin/env bash
# tokens-per-turn.sh <replay-output.jsonl>
#
# Given a replay-session.sh --jsonl output file, compute aggregate stats
# over total tokens per turn (input + output):
#   avg, p50 (median), p95
#
# Prints one line:
#   avg=N p50=N p95=N (over M turns)
#
# Requires: python3 (stdlib only)

set -euo pipefail

usage() {
  printf 'Usage: %s <replay-output.jsonl>\n' "$0" >&2
  exit 1
}

[ $# -lt 1 ] && usage

INPUT_FILE="$1"
[ -f "$INPUT_FILE" ] || { printf 'Error: file not found: %s\n' "$INPUT_FILE" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || { printf 'Error: python3 required\n' >&2; exit 1; }

python3 - "$INPUT_FILE" << 'PYEOF'
import json, sys, statistics

input_file = sys.argv[1]

totals = []
with open(input_file) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        inp = obj.get('input_tokens', 0)
        out = obj.get('output_tokens', 0)
        totals.append(inp + out)

if not totals:
    print('No turn data found.', file=sys.stderr)
    sys.exit(1)

n = len(totals)
avg = sum(totals) / n
sorted_t = sorted(totals)

def percentile(data, pct):
    if len(data) == 1:
        return data[0]
    idx = (pct / 100) * (len(data) - 1)
    lo = int(idx)
    hi = lo + 1
    if hi >= len(data):
        return data[-1]
    frac = idx - lo
    return data[lo] + frac * (data[hi] - data[lo])

p50 = percentile(sorted_t, 50)
p95 = percentile(sorted_t, 95)

print(f'avg={avg:.0f} p50={p50:.0f} p95={p95:.0f} (over {n} turns)')
PYEOF
