#!/usr/bin/env bash
# spawn-reads.sh <session-jsonl>
#
# From a raw CC session JSONL, compute:
#   - total subagent spawns (TaskCreate tool calls in assistant messages)
#   - total Read tool calls in assistant messages
#   - mean Read calls per spawn (total_reads / total_spawns)
#
# Prints:
#   spawns=N reads=M mean_reads_per_spawn=X.XX
#
# If there are no spawns, mean is reported as N/A.
#
# Requires: python3 (stdlib only)

set -euo pipefail

usage() {
  printf 'Usage: %s <session.jsonl>\n' "$0" >&2
  exit 1
}

[ $# -lt 1 ] && usage

SESSION_FILE="$1"
[ -f "$SESSION_FILE" ] || { printf 'Error: file not found: %s\n' "$SESSION_FILE" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || { printf 'Error: python3 required\n' >&2; exit 1; }

python3 - "$SESSION_FILE" << 'PYEOF'
import json, sys

session_file = sys.argv[1]

spawns = 0
reads  = 0

with open(session_file) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get('type') != 'assistant':
            continue
        content = ev.get('message', {}).get('content', [])
        for item in content:
            if not isinstance(item, dict) or item.get('type') != 'tool_use':
                continue
            name = item.get('name', '')
            if name == 'TaskCreate':
                spawns += 1
            elif name == 'Read':
                reads += 1

if spawns == 0:
    mean = 'N/A'
else:
    mean = f'{reads / spawns:.2f}'

print(f'spawns={spawns} reads={reads} mean_reads_per_spawn={mean}')
PYEOF
