#!/usr/bin/env bash
# Hook: Verification gate for SWE task_update_status(completed).
#
# Fires when SWE calls task_update_status with agent='swe' and status='completed'.
# Extracts the ## Verification block from the task's spec_body, runs each command
# in the task's worktree, and denies if any command exits non-zero or times out.
#
# Fires on: PreToolUse — matcher: mcp__.*trajectory-server__task_update_status
#
# Decision logic:
#   - Non-SWE caller              → allow
#   - Status != 'completed'       → allow
#   - No ## Verification block    → allow with additionalContext warning
#   - waive_verification_gate_reason (>=10 chars) → allow + audit row
#   - Verification passes          → allow
#   - Verification fails           → DENY with failing command + output tail
#   - Total timeout (default 240s) → DENY with timeout message
#
# Environment:
#   TMB_VERIFICATION_TIMEOUT_S — total seconds (default 240)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/lib/resolve-plugin-name.sh
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"

INPUT=$(cat)

# Portable per-command timeout: prefer `timeout`, fall back to `gtimeout`
# (brew coreutils), else perl alarm(). Exit 124 on timeout (GNU convention).
tmb_run_with_timeout() {
  secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    perl -e '
      use strict; use warnings;
      my $secs = shift @ARGV;
      my $pid = fork();
      if (!defined $pid) { exit 1; }
      if ($pid == 0) { exec @ARGV; exit 1; }
      local $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); exit 124 };
      alarm $secs;
      waitpid($pid, 0);
      alarm 0;
      exit(($? >> 8) & 0xff);
    ' "$secs" "$@"
  fi
}

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.agent // empty' 2>/dev/null || true)")

[ "$AGENT_TYPE" = "swe" ] || exit 0

STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // empty' 2>/dev/null || true)
[ "$STATUS" = "completed" ] || exit 0

TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // empty' 2>/dev/null || true)
case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
if [ -z "$TASK_ID" ]; then
  exit 0
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

# Check for waiver BEFORE running verification.
WAIVER=$(echo "$INPUT" | jq -r '.tool_input.waive_verification_gate_reason // empty' 2>/dev/null || true)
if [ -n "$WAIVER" ] && [ ${#WAIVER} -ge 10 ]; then
  CONTENT_JSON="{\"task_id\":${TASK_ID},\"waiver_reason\":$(echo "$WAIVER" | jq -Rs .)}"
  CONTENT_JSON_SQL=${CONTENT_JSON//\'/\'\'}
  sqlite3 "$DB" "
    INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
    SELECT COALESCE(t.issue_id, -1), t.branch_id, 'swe', 'verification_gate_waived',
           'SWE waived verification gate for task_id=${TASK_ID}',
           '${CONTENT_JSON_SQL}', datetime('now')
      FROM tasks t WHERE t.id = ${TASK_ID}
     LIMIT 1;
  " 2>/dev/null || true
  exit 0
fi

# Fetch spec_body and branch_id for this task (queried separately to avoid
# delimiter collision — spec_body may contain any character including '|').
SPEC_BODY=$(tmb_sqlite_ro "$DB" \
  "SELECT spec_body FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)
BRANCH_ID=$(tmb_sqlite_ro "$DB" \
  "SELECT COALESCE(branch_id, '') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)

if [ -z "$BRANCH_ID" ]; then
  exit 0
fi

# Extract ## Verification block from spec_body.
# Match ## Verification (case-sensitive, required by spec) up to next ## heading or end.
VERIFICATION_BLOCK=$(printf '%s' "$SPEC_BODY" | awk '
  /^## Verification/ { in_block=1; next }
  in_block && /^## / { exit }
  in_block { print }
' | sed '/^[[:space:]]*$/d')

if [ -z "$VERIFICATION_BLOCK" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: no ## Verification block found in spec_body — verification gate skipped. Consider adding verification commands to the spec."}}'
  exit 0
fi

# Extract the SLUG from branch_id (last path component) to locate worktree.
SLUG="${BRANCH_ID##*/}"

# Resolve worktree path: look for .claude/worktrees/<slug> relative to repo root.
# Walk up from PWD to find the repo root (has a .git dir or .claude/ dir).
REPO_ROOT=""
dir="$PWD"
for _ in 1 2 3 4 5 6 7 8; do
  if [ -d "$dir/.claude/worktrees" ] || [ -d "$dir/.git" ]; then
    REPO_ROOT="$dir"
    break
  fi
  parent=$(dirname "$dir")
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$PWD"
fi

WT_PATH="${REPO_ROOT}/.claude/worktrees/${SLUG}"

# Fall back to the sentinel workspace path if the worktree doesn't exist.
if [ ! -d "$WT_PATH" ]; then
  _PLUGIN_NAME=$(tmb_resolve_plugin_name)
  SENTINEL="${HOME}/.claude/${_PLUGIN_NAME}-active-workspace"
  if [ -f "$SENTINEL" ]; then
    WS=$(head -1 "$SENTINEL" 2>/dev/null || true)
    if [ -n "$WS" ] && [ -d "$WS/.claude/worktrees/${SLUG}" ]; then
      WT_PATH="${WS}/.claude/worktrees/${SLUG}"
    fi
  fi
fi

if [ ! -d "$WT_PATH" ]; then
  jq -nc --arg wt "$WT_PATH" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":("TMB: verification gate skipped — worktree not found at " + $wt)}}'
  exit 0
fi

TIMEOUT_S="${TMB_VERIFICATION_TIMEOUT_S:-240}"
START_TS=$(date +%s 2>/dev/null || echo 0)

FAILED_CMD=""
FAILED_OUTPUT=""

# Parse verification commands: lines starting with 'bash ', lines of the form
# `$ cmd`, or plain command lines. Skip blank lines and markdown heading lines.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    "#"*|"---"*) continue ;;
    "\`\`\`"*) continue ;;
  esac

  # Strip leading '$ ' marker if present.
  CMD="${line#\$ }"
  CMD="${CMD#\`}"
  CMD="${CMD%\`}"
  CMD="${CMD#> }"

  [ -z "$CMD" ] && continue

  # Check total timeout before each command.
  NOW_TS=$(date +%s 2>/dev/null || echo 0)
  ELAPSED=$(( NOW_TS - START_TS ))
  REMAINING=$(( TIMEOUT_S - ELAPSED ))
  if [ "$REMAINING" -le 0 ]; then
    jq -nc --arg t "$TIMEOUT_S" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: verification timed out after " + $t + "s total. Increase TMB_VERIFICATION_TIMEOUT_S or fix slow verification commands.")}}'
    exit 0
  fi

  # Run command in worktree, bounded by the remaining time budget.
  CMD_OUTPUT=$( (cd "$WT_PATH" && tmb_run_with_timeout "$REMAINING" bash -c "$CMD") 2>&1 ) || {
    CMD_RC=$?
    if [ "$CMD_RC" -eq 124 ]; then
      jq -nc --arg cmd "$CMD" --arg t "$TIMEOUT_S" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: verification timed out after " + $t + "s total budget while running: " + $cmd + ". Increase TMB_VERIFICATION_TIMEOUT_S or fix slow verification commands.")}}'
      exit 0
    fi
    FAILED_CMD="$CMD"
    FAILED_OUTPUT=$(echo "$CMD_OUTPUT" | tail -20)
    break
  }

done <<< "$VERIFICATION_BLOCK"

if [ -n "$FAILED_CMD" ]; then
  jq -nc --arg cmd "$FAILED_CMD" --arg out "$FAILED_OUTPUT" '
    {"hookSpecificOutput":{
      "hookEventName":"PreToolUse",
      "permissionDecision":"deny",
      "denyReason":("BLOCKED: verification failed.\nFailing command: " + $cmd + "\n\nOutput (last 20 lines):\n" + $out)
    }}
  '
  exit 0
fi

exit 0
