#!/usr/bin/env bash
# cache-stability.sh <replay-A.jsonl> <replay-B.jsonl>
#
# Given two replay-session.sh --jsonl outputs of identical sessions run at
# different times, report per-turn cache stability:
#   - shared_prefix_tokens: min(cache_read_A, cache_read_B) per turn
#   - breakpoint_drift:     abs(cache_creation_A - cache_creation_B) per turn
#
# Prints one summary line per matched turn, then a totals row.
# Turns are matched positionally (turn_index 1..N).
#
# Requires: python3 (stdlib only)

set -euo pipefail

usage() {
  printf 'Usage: %s <replay-A.jsonl> <replay-B.jsonl>\n' "$0" >&2
  exit 1
}

[ $# -lt 2 ] && usage

FILE_A="$1"
FILE_B="$2"

[ -f "$FILE_A" ] || { printf 'Error: file not found: %s\n' "$FILE_A" >&2; exit 1; }
[ -f "$FILE_B" ] || { printf 'Error: file not found: %s\n' "$FILE_B" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || { printf 'Error: python3 required\n' >&2; exit 1; }

python3 - "$FILE_A" "$FILE_B" << 'PYEOF'
import json, sys

def load_turns(path):
    turns = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                turns.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return turns

turns_a = load_turns(sys.argv[1])
turns_b = load_turns(sys.argv[2])

n = min(len(turns_a), len(turns_b))
if n == 0:
    print('No matching turns found.', file=sys.stderr)
    sys.exit(1)

hdr = f"{'TURN':<5} {'CACHE_RD_A':<12} {'CACHE_RD_B':<12} {'SHARED_PFX':<12} {'DRIFT':<10}"
print(hdr)
print('-' * len(hdr))

total_shared = 0
total_drift  = 0
for i in range(n):
    a = turns_a[i]
    b = turns_b[i]
    cr_a = a.get('cache_read_tokens', 0)
    cr_b = b.get('cache_read_tokens', 0)
    cc_a = a.get('cache_creation_tokens', 0)
    cc_b = b.get('cache_creation_tokens', 0)
    shared = min(cr_a, cr_b)
    drift  = abs(cc_a - cc_b)
    total_shared += shared
    total_drift  += drift
    idx = a.get('turn_index', i + 1)
    print(f"{idx:<5} {cr_a:<12} {cr_b:<12} {shared:<12} {drift:<10}")

print('-' * len(hdr))
print(f"{'TOT':<5} {'':<12} {'':<12} {total_shared:<12} {total_drift:<10}")
if n < max(len(turns_a), len(turns_b)):
    skipped = abs(len(turns_a) - len(turns_b))
    print(f'Note: {skipped} unmatched turn(s) skipped (session lengths differ)')
PYEOF
