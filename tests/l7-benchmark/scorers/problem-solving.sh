#!/usr/bin/env bash
# Problem-solving axis: did the agent solve the task?
#
# Wraps the per-task verify.sh. The task author owns the verify.sh contract;
# this scorer just runs it and translates the exit code to a 1/0 pass.
#
# Usage:
#   bash problem-solving.sh <task_dir> <project_dir>
#
# Writes JSON to stdout: { axis, pass, signal, log_excerpt }

set -uo pipefail

TASK_DIR="${1:?task_dir required}"
PROJECT="${2:?project_dir required}"

VERIFY="$TASK_DIR/verify.sh"
if [ ! -x "$VERIFY" ]; then
  printf '{"axis":"problem_solving","pass":0,"signal":"no verify.sh in task dir","log_excerpt":""}\n'
  exit 0
fi

LOG=$(mktemp)
if "$VERIFY" "$PROJECT" "$TASK_DIR" > "$LOG" 2>&1; then
  STATUS=1
  SIGNAL="verify.sh exited 0"
else
  STATUS=0
  SIGNAL="verify.sh exited non-zero (exit=$?)"
fi

EXCERPT=$(tail -c 2000 "$LOG" | jq -Rs '.' 2>/dev/null || printf '""')
rm -f "$LOG"

jq -nc --argjson pass "$STATUS" --arg signal "$SIGNAL" --argjson log "$EXCERPT" \
  '{axis: "problem_solving", pass: $pass, signal: $signal, log_excerpt: $log}'
