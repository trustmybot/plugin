#!/usr/bin/env bash
# Diagnostic hook for issue #14 — logs every Bash PreToolUse fire.
# Non-blocking: always exits 0. Writes to /tmp/tmb-hook-probe.log.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
TS=$(date +%s)
echo "$TS PID=$$ CMD=$(echo "$CMD" | head -c 80)" >> /tmp/tmb-hook-probe.log
exit 0
