#!/usr/bin/env bash
# replay-session.sh <session-jsonl> [--jsonl | --table]
#
# Parse a CC session JSONL file and report per-turn metrics:
#   turn_index, input_tokens, output_tokens, cache_read_tokens,
#   cache_creation_tokens, hook_injected_bytes, tool_calls[]
#
# A "turn" is one assistant message that carries .message.usage.
# Hook-injected bytes = total bytes of <system-reminder> text blocks
# in the immediately preceding user message.
#
# Output modes:
#   --jsonl   one JSON object per assistant turn (default)
#   --table   human-readable ASCII table
#
# Requires: jq, python3 (stdlib only)

set -euo pipefail

usage() {
  printf 'Usage: %s <session.jsonl> [--jsonl | --table]\n' "$0" >&2
  exit 1
}

[ $# -lt 1 ] && usage

SESSION_FILE="$1"
OUTPUT_MODE="${2:---jsonl}"

[ -f "$SESSION_FILE" ] || { printf 'Error: file not found: %s\n' "$SESSION_FILE" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || { printf 'Error: jq required\n' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { printf 'Error: python3 required\n' >&2; exit 1; }

python3 - "$SESSION_FILE" "$OUTPUT_MODE" << 'PYEOF'
import json, sys

session_file = sys.argv[1]
output_mode  = sys.argv[2]

events = []
with open(session_file) as fh:
    for line in fh:
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

# Build uuid->hook_bytes map from user messages
hook_map = {}
for ev in events:
    if ev.get('type') != 'user':
        continue
    uid = ev.get('uuid', '')
    if not uid:
        continue
    content = ev.get('message', {}).get('content', [])
    if not isinstance(content, list):
        continue
    total = 0
    for item in content:
        if (isinstance(item, dict)
                and item.get('type') == 'text'
                and '<system-reminder>' in item.get('text', '')):
            total += len(item['text'])
    hook_map[uid] = total

# Process assistant messages with usage
turns = []
for ev in events:
    if ev.get('type') != 'assistant':
        continue
    msg = ev.get('message', {})
    usage = msg.get('usage')
    if not usage:
        continue
    content = msg.get('content', [])
    tool_calls = [
        c['name']
        for c in content
        if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name')
    ]
    parent_uuid = ev.get('parentUuid', '')
    turns.append({
        'turn_index':            len(turns) + 1,
        'timestamp':             ev.get('timestamp', ''),
        'input_tokens':          usage.get('input_tokens', 0),
        'output_tokens':         usage.get('output_tokens', 0),
        'cache_read_tokens':     usage.get('cache_read_input_tokens', 0),
        'cache_creation_tokens': usage.get('cache_creation_input_tokens', 0),
        'hook_injected_bytes':   hook_map.get(parent_uuid, 0),
        'tool_calls':            tool_calls,
    })

if not turns:
    print('No assistant turns with usage data found.', file=sys.stderr)
    sys.exit(1)

if output_mode == '--table':
    hdr = f"{'TURN':<5} {'IN_TOK':<8} {'OUT_TOK':<8} {'CACHE_RD':<10} {'CACHE_CR':<10} {'HOOK_B':<8} TOOLS"
    print(hdr)
    print('-' * len(hdr))
    for t in turns:
        tools = '|'.join(t['tool_calls']) if t['tool_calls'] else '-'
        print(f"{t['turn_index']:<5} {t['input_tokens']:<8} {t['output_tokens']:<8} "
              f"{t['cache_read_tokens']:<10} {t['cache_creation_tokens']:<10} "
              f"{t['hook_injected_bytes']:<8} {tools}")
else:
    for t in turns:
        print(json.dumps(t))
PYEOF
