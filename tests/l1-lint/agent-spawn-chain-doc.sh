#!/usr/bin/env bash
# Lint: the agent-spawn-dispatch.sh gate chain is documented as it runs.
# The docs/reference/REFERENCE.md row for agent-spawn-dispatch.sh names every
# gate of the dispatcher's HOOKS array, in that order, and scripts/hooks/README.md
# names every gate. The UPGRADE.md Codex bullet matches inspectLegacy: removal
# deletes a header-carrying legacy file whatever its body (F180-1..3, GH 1641).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

DISPATCH=scripts/hooks/agent-spawn-dispatch.sh
REFERENCE=docs/reference/REFERENCE.md
HOOKS_README=scripts/hooks/README.md
UPGRADE=docs/reference/UPGRADE.md

gates=$(awk '/^HOOKS=\(/{on=1; next} on && /^\)/{on=0} on' "$DISPATCH" \
  | sed -E 's#.*/([a-z0-9-]+)\.sh".*#\1#; s/^[[:space:]]+//; s/[[:space:]]+$//')
row=$(grep -F "| \`agent-spawn-dispatch.sh\` |" "$REFERENCE")
failed=0

if [ -z "$gates" ]; then
  echo "  ✗ $DISPATCH has no HOOKS array" >&2
  exit 1
fi
if [ -z "$row" ]; then
  echo "  ✗ $REFERENCE has no agent-spawn-dispatch.sh row" >&2
  exit 1
fi

prev=-1
prev_gate=""
for gate in $gates; do
  if ! grep -qF "\`$gate" "$HOOKS_README"; then
    echo "  ✗ $HOOKS_README does not name agent-spawn gate $gate" >&2
    failed=1
  fi
  rest="${row#*\`"$gate"}"
  if [ "$rest" = "$row" ]; then
    echo "  ✗ $REFERENCE agent-spawn-dispatch.sh row does not name gate $gate" >&2
    failed=1
    continue
  fi
  pos=$(( ${#row} - ${#rest} ))
  if [ "$pos" -le "$prev" ]; then
    echo "  ✗ $REFERENCE agent-spawn-dispatch.sh row names $gate before $prev_gate; the dispatcher runs $prev_gate first" >&2
    failed=1
  fi
  prev=$pos
  prev_gate=$gate
done

if grep -qF 'if you edited it, it stays' "$UPGRADE"; then
  echo "  ✗ $UPGRADE says an edited legacy Codex reviewer file stays; inspectLegacy checks only its TMB header, so removal deletes it" >&2
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  echo "  ✓ agent-spawn chain ($(printf '%s\n' "$gates" | wc -l | tr -d ' ') gates) documented in order; UPGRADE Codex bullet matches inspectLegacy"
fi
exit "$failed"
