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
#   - waive_verification_gate_reason (>=10 chars) → allow + one audit row per
#     (task, commit_sha): the commit is tool_input.commit_sha, else the task's
#     commit_sha; a repeat invocation for the same pair writes nothing
#   - Verification passes          → allow
#   - Verification fails           → DENY with failing command + output tail
#   - Total timeout (default 900s) → DENY with timeout message
#
# Run lock: one verification run per (task, worktree HEAD). The gate takes a
# mkdir lock <project>/.claude/<plugin>/locks/verify-<task_id>-<sha>/; a
# concurrent second invocation (e.g. the same gate registered twice) waits for
# the holder and reuses its verdict from verify-<task_id>-<sha>.result instead
# of re-running verification[]. The lock is removed on exit; a lock older than
# the total budget + 60s (by its `started` stamp, else the dir mtime) is
# reclaimed.
#
# Environment:
#   TMB_VERIFICATION_TIMEOUT_S — total seconds (default 900)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/hooks/lib/resolve-workspace.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-workspace.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/resolve-toolchain-path.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-toolchain-path.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh"
export TMB_DB_WRITE_TIMEOUT_MS=5000
export TMB_DB_WRITE_RUN_BUDGET_MS=10200

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
SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

# Check for waiver BEFORE running verification.
WAIVER=$(echo "$INPUT" | jq -r '.tool_input.waive_verification_gate_reason // empty' 2>/dev/null || true)
if [ -n "$WAIVER" ] && [ ${#WAIVER} -ge 10 ]; then
  TASK_ROW=$(tmb_gate_read "$DB" "SELECT COALESCE(issue_id, -1) || '|' || COALESCE(branch_id, '') || '|' || COALESCE(commit_sha, '') FROM tasks WHERE id = ${SAFE_TASK_ID} LIMIT 1;")
  if [ "$TASK_ROW" = "__ERR__" ]; then
    tmb_deny_db_unavailable "swe-verification-gate (waiver)"
    exit 0
  fi
  WAIVER_ISSUE="${TASK_ROW%%|*}"
  WAIVER_REST="${TASK_ROW#*|}"
  WAIVER_BRANCH="${WAIVER_REST%%|*}"
  WAIVER_SHA=$(echo "$INPUT" | jq -r '.tool_input.commit_sha // empty' 2>/dev/null || true)
  [ -n "$WAIVER_SHA" ] || WAIVER_SHA="${WAIVER_REST#*|}"
  CONTENT_JSON=$(jq -nc --argjson tid "$TASK_ID" --arg sha "$WAIVER_SHA" --arg reason "$WAIVER" '{task_id: $tid, commit_sha: $sha, waiver_reason: $reason}')
  if [ -n "$TASK_ROW" ] && ! tmb_audit_append "$DB" "$WAIVER_ISSUE" "$WAIVER_BRANCH" "hook:swe-verification-gate" "verification_gate_waived" \
      "SWE waived verification gate for task_id=${TASK_ID}" "$CONTENT_JSON" '$.task_id' '$.commit_sha'; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the verification-gate waiver could not be recorded, so it cannot be honoured. Retry once the DB is writable."}}'
  fi
  exit 0
fi

DB_UNAVAILABLE_DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the verification gate could not read the task row, so it refuses to fail open. Check the trajectory DB (sqlite3 error on read) and retry."}}'

# Fetch the typed `verification` column and branch_id for this task. The typed
# column is a JSON array of command strings (Typed Rails #673).
VERIFICATION_JSON=$(tmb_sqlite_ro "$DB" \
  "SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)
BRANCH_ID=$(tmb_gate_read "$DB" \
  "SELECT COALESCE(branch_id, '') FROM tasks WHERE id = ${SAFE_TASK_ID} LIMIT 1;")
if [ "$BRANCH_ID" = "__ERR__" ]; then
  printf '%s\n' "$DB_UNAVAILABLE_DENY"
  exit 0
fi
TASK_REPO=$(tmb_sqlite_ro "$DB" \
  "SELECT COALESCE(repo, '') FROM tasks WHERE id = ${TASK_ID} LIMIT 1;" 2>/dev/null || true)

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

# Resolve the worktree base from the TASK'S REPO, not the workspace root.
# ensure-swe-worktree.sh creates the worktree at <repoRoot>/.claude/worktrees/
# <slug>, where repoRoot = tasks.repo → repos.path (else single-repo fallback,
# else workspace root). A workspace-rooted guess (<ws>/.claude/worktrees/<slug>)
# is wrong in the plugin-subdir layout (repo at <ws>/plugin) and let the gate
# silently skip — a safety hole. Resolve the same way the creating hook does.
WS_ROOT=$(tmb_workspace_root "$DB" || true)

REPO_ROOT=""
if [ -n "$TASK_REPO" ]; then
  REPO_ROOT=$(tmb_repo_path_by_name "$DB" "$TASK_REPO")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="${WS_ROOT}/${TASK_REPO}"
else
  REPO_ROOT=$(tmb_repo_single_path "$DB")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="$WS_ROOT"
fi

WT_PATH=""
if [ -n "$REPO_ROOT" ] && [ -d "${REPO_ROOT}/.claude/worktrees/${SLUG}" ]; then
  WT_PATH="${REPO_ROOT}/.claude/worktrees/${SLUG}"
fi

# Fail CLOSED: when verification[] is non-empty but the task worktree cannot be
# located, DENY with a named remediation — never skip. The silent skip was a
# safety hole: it let tasks atomic-close without the gate enforcing
# verification[]. (#156)
if [ -z "$WT_PATH" ] || [ ! -d "$WT_PATH" ]; then
  MISSING_AT="${REPO_ROOT:-${WS_ROOT:-?}}/.claude/worktrees/${SLUG}"
  jq -nc --arg wt "$MISSING_AT" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: verification gate could not locate the task worktree at " + $wt + " — refusing to fail open with non-empty verification[]. Ensure SWE ran in its registered worktree (ensure-swe-worktree creates it under <repoRoot>/.claude/worktrees/<slug>), verify the task'"'"'s repo maps to the correct repos.path, or set waive_verification_gate_reason.")}}'
  exit 0
fi

# Resolve the user's real toolchain PATH so verification commands invoking
# mise/homebrew tools (npm/node/shellcheck) don't exit 127 under the minimal
# hook-process PATH. See lib/resolve-toolchain-path.sh.
TOOLCHAIN_PATH=$(tmb_resolve_toolchain_path "$PATH" 2>/dev/null || printf '%s' "$PATH")

TIMEOUT_S="${TMB_VERIFICATION_TIMEOUT_S:-900}"

# Prints the gate's decision (deny JSON, or nothing for allow).
run_verification() {
  START_TS=$(date +%s 2>/dev/null || echo 0)

  FAILED_CMD=""
  FAILED_OUTPUT=""
  FAILED_MATCHES=""

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
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: verification timed out after " + $t + "s total. Increase TMB_VERIFICATION_TIMEOUT_S or fix slow verification commands. (current budget: " + $t + "s via TMB_VERIFICATION_TIMEOUT_S, default 900).")}}'
      exit 0
    fi

    # Run command in worktree with the resolved toolchain PATH, bounded by the
    # remaining time budget.
    CMD_OUTPUT=$( (cd "$WT_PATH" && PATH="$TOOLCHAIN_PATH" tmb_run_with_timeout "$REMAINING" bash -c "$CMD") 2>&1 ) || {
      CMD_RC=$?
      if [ "$CMD_RC" -eq 124 ]; then
        jq -nc --arg cmd "$CMD" --arg t "$TIMEOUT_S" \
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: verification timed out after " + $t + "s total budget while running: " + $cmd + ". Increase TMB_VERIFICATION_TIMEOUT_S or fix slow verification commands. (current budget: " + $t + "s via TMB_VERIFICATION_TIMEOUT_S, default 900).")}}'
        exit 0
      fi
      FAILED_CMD="$CMD"
      # No pipelines here: under pipefail a writer killed by SIGPIPE or a grep
      # with no match would end the hook without its deny.
      FAILED_MATCHES=$(grep -m 15 -E 'FAIL|failed|Error|❌' <<< "$CMD_OUTPUT" || true)
      FAILED_OUTPUT=$(tail -20 <<< "$CMD_OUTPUT" || true)
      break
    }

  done <<< "$VERIFICATION_BLOCK"

  if [ -n "$FAILED_CMD" ]; then
    jq -nc --arg cmd "$FAILED_CMD" --arg out "$FAILED_OUTPUT" --arg hits "$FAILED_MATCHES" '
      {"hookSpecificOutput":{
        "hookEventName":"PreToolUse",
        "permissionDecision":"deny",
        "permissionDecisionReason":("BLOCKED: verification failed.\nFailing command: " + $cmd
          + (if $hits == "" then "" else "\n\nFailure lines (max 15):\n" + $hits end)
          + "\n\nOutput (last 20 lines):\n" + $out)
      }}
    '
    exit 0
  fi
}

now_s() { date +%s 2>/dev/null || echo 0; }

LOCK_ROOT="$(dirname "$DB")/locks"
WT_SHA=$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo nohead)
LOCK="$LOCK_ROOT/verify-${TASK_ID}-${WT_SHA}"
RESULT="$LOCK.result"
STALE_S=$(( TIMEOUT_S + 60 ))
ARRIVED=$(now_s)

if ! mkdir -p "$LOCK_ROOT" 2>/dev/null; then
  run_verification
  exit 0
fi
find "$LOCK_ROOT" -maxdepth 1 -type f -name 'verify-*.result' -mmin +1440 -delete 2>/dev/null || true

# lock_held_since — epoch seconds the lock was taken: the holder's `started`
# stamp, else the lock dir's mtime (holder killed between mkdir and the stamp).
lock_held_since() {
  local since
  since=$(cat "$LOCK/started" 2>/dev/null || true)
  case "$since" in ''|*[!0-9]*)
    since=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || true) ;;
  esac
  case "$since" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$since"
}

while ! mkdir "$LOCK" 2>/dev/null; do
  held_since=$(lock_held_since) || held_since=$(now_s)
  if [ $(( $(now_s) - held_since )) -gt "$STALE_S" ]; then
    rm -rf "$LOCK" 2>/dev/null || true
    continue
  fi
  while [ -d "$LOCK" ]; do
    sleep 0.5
    held_since=$(lock_held_since) || continue
    [ $(( $(now_s) - held_since )) -gt "$STALE_S" ] && break
  done
  [ -d "$LOCK" ] && continue
  started=$(jq -r '.started_at // empty' "$RESULT" 2>/dev/null || true)
  case "$started" in ''|*[!0-9]*) continue ;; esac
  if [ "$started" -le "$ARRIVED" ]; then
    jq -j '.output' "$RESULT" 2>/dev/null || true
    exit 0
  fi
done

trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT
STARTED=$(now_s)
printf '%s\n' "$STARTED" > "$LOCK/started"
DECISION=$(run_verification)
if jq -nc --argjson s "$STARTED" --argjson f "$(now_s)" --arg o "${DECISION:+$DECISION
}" \
    '{started_at: $s, finished_at: $f, verdict: (if ($o | test("\"permissionDecision\":\"deny\"")) then "deny" else "allow" end), output: $o}' \
    > "$RESULT.tmp.$$" 2>/dev/null; then
  mv -f "$RESULT.tmp.$$" "$RESULT" 2>/dev/null || rm -f "$RESULT.tmp.$$"
else
  rm -f "$RESULT.tmp.$$" 2>/dev/null || true
fi
[ -n "$DECISION" ] && printf '%s\n' "$DECISION"
exit 0
