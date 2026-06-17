#!/usr/bin/env bash
# Hook: Verification gate for SWE task_update_status(completed).
#
# Fires when SWE calls task_update_status with agent='swe' and status='completed'.
# Reads the typed `verification` column (a JSON array of command strings, Typed
# Rails #673), runs each command in the task's worktree, and denies if any
# command exits non-zero or times out.
#
# Typed Rails (#673): the gate reads the typed `verification` column directly.
# A task with an empty verification[] array (e.g. pre-migration tasks, or bro
# omitting the field) skips the gate with a warning.
#
# Toolchain PATH (#673, second defect): the swe-subagent PreToolUse hook process
# starts with a minimal, login-stripped PATH where mise/homebrew tools
# (npm/node/shellcheck) are absent → verification commands would exit 127 (false
# DENY). lib/resolve-toolchain-path.sh resolves and prepends the user's real
# toolchain dirs before the bash -c loop; see that file's header for the
# mechanism and why bash -lc is insufficient (zsh + mise).
#
# Fires on: PreToolUse — matcher: mcp__.*trajectory-server__task_update_status
#
# Decision logic:
#   - Non-SWE caller              → allow
#   - Status != 'completed'       → allow
#   - Empty typed verification[]  → allow with additionalContext warning
#   - waive_verification_gate_reason (>=10 chars) → allow + audit row
#   - Verification passes          → allow
#   - Verification fails           → DENY with failing command + output tail
#   - Total timeout (default 240s) → DENY with timeout message
#
# Environment:
#   TMB_VERIFICATION_TIMEOUT_S — total seconds (default 240)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/lib/resolve-plugin-name.sh disable=SC1091
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"
# shellcheck source=scripts/hooks/lib/resolve-workspace.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-workspace.sh"
# shellcheck source=scripts/hooks/lib/resolve-toolchain-path.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-toolchain-path.sh"

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

# Fetch the typed `verification` column and branch_id for this task. The typed
# column is a JSON array of command strings (Typed Rails #673).
VERIFICATION_JSON=$(tmb_sqlite_ro "$DB" \
  "SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)
BRANCH_ID=$(tmb_sqlite_ro "$DB" \
  "SELECT COALESCE(branch_id, '') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)

if [ -z "$BRANCH_ID" ]; then
  exit 0
fi

# Parse the JSON array into commands (one per line). Empty array or invalid JSON
# yields no lines.
VERIFICATION_BLOCK=$(printf '%s' "$VERIFICATION_JSON" | jq -r '.[]?' 2>/dev/null || true)

# Empty typed verification[] → skip the gate.
if [ -z "$VERIFICATION_BLOCK" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: task has no typed verification[] — verification gate skipped. Ask bro to set the task'"'"'s verification[] field (Typed Rails #673) to enforce verification commands."}}'
  exit 0
fi

# Extract the SLUG from branch_id (last path component) to locate worktree.
SLUG="${BRANCH_ID##*/}"

# Resolve workspace root via shared lib (dirname×3 of DB).
# This handles workspace-above-repo layouts (repo at <ws>/plugin,
# worktrees at <ws>/.claude/worktrees/<slug>) where a PWD walk-up from
# inside the repo would land on the repo root instead of the workspace root.
WS_ROOT=$(tmb_workspace_root "$DB" || true)

WT_PATH=""
if [ -n "$WS_ROOT" ] && [ -d "${WS_ROOT}/.claude/worktrees/${SLUG}" ]; then
  WT_PATH="${WS_ROOT}/.claude/worktrees/${SLUG}"
fi

# Sentinel fallback: subagents that inherit cwd=~ and lack env vars use the
# active-workspace sentinel written by the plugin at launch time.
if [ -z "$WT_PATH" ]; then
  _PLUGIN_NAME=$(tmb_resolve_plugin_name)
  SENTINEL="${HOME}/.claude/${_PLUGIN_NAME}-active-workspace"
  if [ -f "$SENTINEL" ]; then
    WS=$(head -1 "$SENTINEL" 2>/dev/null || true)
    if [ -n "$WS" ] && [ -d "$WS/.claude/worktrees/${SLUG}" ]; then
      WT_PATH="${WS}/.claude/worktrees/${SLUG}"
    fi
  fi
fi

if [ -z "$WT_PATH" ] || [ ! -d "$WT_PATH" ]; then
  MISSING_AT="${WT_PATH:-${WS_ROOT:-?}/.claude/worktrees/${SLUG}}"
  jq -nc --arg wt "$MISSING_AT" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":("TMB: verification gate skipped — worktree not found at " + $wt)}}'
  exit 0
fi

# Resolve the user's real toolchain PATH so verification commands invoking
# mise/homebrew tools (npm/node/shellcheck) don't exit 127 under the minimal
# hook-process PATH. See lib/resolve-toolchain-path.sh.
TOOLCHAIN_PATH=$(tmb_resolve_toolchain_path "$PATH" 2>/dev/null || printf '%s' "$PATH")

TIMEOUT_S="${TMB_VERIFICATION_TIMEOUT_S:-240}"
START_TS=$(date +%s 2>/dev/null || echo 0)

FAILED_CMD=""
FAILED_OUTPUT=""

# Each entry of the typed verification[] array is a clean shell command string
# (Typed Rails #673) — no markdown bullets/backticks/blockquotes to strip. Run
# each non-empty line as a command in the worktree.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  CMD="$line"

  # Check total timeout before each command.
  NOW_TS=$(date +%s 2>/dev/null || echo 0)
  ELAPSED=$(( NOW_TS - START_TS ))
  REMAINING=$(( TIMEOUT_S - ELAPSED ))
  if [ "$REMAINING" -le 0 ]; then
    jq -nc --arg t "$TIMEOUT_S" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":("BLOCKED: verification timed out after " + $t + "s total. Increase TMB_VERIFICATION_TIMEOUT_S or fix slow verification commands.")}}'
    exit 0
  fi

  # Run command in worktree with the resolved toolchain PATH, bounded by the
  # remaining time budget.
  CMD_OUTPUT=$( (cd "$WT_PATH" && PATH="$TOOLCHAIN_PATH" tmb_run_with_timeout "$REMAINING" bash -c "$CMD") 2>&1 ) || {
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
