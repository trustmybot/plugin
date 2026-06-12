#!/usr/bin/env bash
# Guards the #300 Architect→SWE handoff contract on the SHIPPED agents.
#
# swe + pr-reviewer load their context through the `task_brief` composite (one
# read: spec + scoped world model + decision thread) instead of orchestrating
# task_get + world_model_get + discussion_search themselves. The L5/L6 layer
# can't assert this — swe/pr-reviewer run as Agent subagents whose calls never
# appear in bro's scored trajectory — so it's locked here at L1 instead.
#
# Checks agents/{swe,pr-reviewer}.md:
#   - both bodies reference task_brief (the contract is the mention + tool grant;
#     the call shape lives in the tool schema and the brief gate's deny message)
#   - swe's `tools:` line is narrowed: no task_get / world_model_get /
#     discussion_search (swe gets context ONLY via task_brief). pr-reviewer
#     keeps the full MCP namespace by design (needs discussion/audit search).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$PLUGIN_ROOT" || exit 1

FAIL=0

for agent in swe pr-reviewer; do
  f="agents/${agent}.md"
  if [ ! -f "$f" ]; then
    printf 'agent-task-brief-contract: %s missing\n' "$f" >&2
    FAIL=1
    continue
  fi
  if ! grep -qw 'task_brief' "$f"; then
    printf 'agent-task-brief-contract: %s does not reference task_brief — #300 handoff contract broken\n' "$f" >&2
    FAIL=1
  fi
done

# swe must be narrowed to task_brief for context — the retired per-call read
# tools must not reappear in its tools: line.
swe_tools=$(grep -m1 '^tools:' agents/swe.md || true)
for retired in task_get world_model_get discussion_search; do
  if printf '%s' "$swe_tools" | grep -q "$retired"; then
    printf 'agent-task-brief-contract: swe tools: line lists retired read tool "%s" — context goes through task_brief only (#300)\n' "$retired" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nagent-task-brief-contract: FAIL\n' >&2
  exit 1
fi

printf 'agent-task-brief-contract: PASS\n'
