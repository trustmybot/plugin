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
#   - A passing recorded run for (task, worktree HEAD) finished within the last
#     hour, and tool_input.commit_sha (when given) names that HEAD → allow
#     without running, additionalContext "verification reused run #N"
#   - Verification passes          → allow
#   - Verification fails           → DENY naming the failing command, its
#     elapsed and the cumulative time, the FAIL lines and the output tail
#   - Budget spent                 → DENY naming the command that was running
#     and the cumulative time
#
# Record (schema v36): every run is written to verification_runs (source
# 'gate', commit_sha = the worktree HEAD) through lib/verification-runs.sh —
# the row when the run starts, a verification_run_commands row after each
# command (exit code, elapsed seconds, output tail), then finished_at,
# exit_code and timed_out. task_brief.verification_run reads it back.
#
# Budget: plugin_config.verification_timeout_s (integer seconds, default 900),
# overridden by TMB_VERIFICATION_TIMEOUT_S, capped at VERIFICATION_MAX_S —
# the hooks.json timeout of this registration minus 30 s
# (tests/l1-lint/hook-timeout-budget.sh keeps the two consistent).
#
# Run lock: one verification run per (task, worktree HEAD). The gate takes a
# mkdir lock <project>/.claude/<plugin>/locks/verify-<task_id>-<sha>/; a
# concurrent second invocation waits for the holder, then reuses its run when
# it passed and runs verification[] itself otherwise. The lock is removed on
# exit; a lock older than the budget + 60s (by its `started` stamp, else the
# dir mtime) is reclaimed.
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
# shellcheck source=scripts/hooks/lib/verification-runs.sh disable=SC1091
. "$SCRIPT_DIR/lib/verification-runs.sh"
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

VERIFICATION_DEFAULT_S=900
VERIFICATION_MAX_S=1800

TIMEOUT_S="${TMB_VERIFICATION_TIMEOUT_S:-}"
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S=$(tmb_config_get verification_timeout_s "$DB" 2>/dev/null || true) ;; esac
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S="$VERIFICATION_DEFAULT_S" ;; esac
TIMEOUT_S=$(( 10#$TIMEOUT_S ))
if [ "$TIMEOUT_S" -gt "$VERIFICATION_MAX_S" ]; then
  TIMEOUT_S="$VERIFICATION_MAX_S"
fi

WT_SHA=$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo nohead)
EXPECTED_SHA=$(echo "$INPUT" | jq -r '.tool_input.commit_sha // empty' 2>/dev/null || true)
CMD_TOTAL=$(grep -c . <<< "$VERIFICATION_BLOCK" || true)

now_s() { date +%s 2>/dev/null || echo 0; }
ms_to_s() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }

# reuse_passing_run — prints the allow-with-context decision and succeeds when
# a passing run recorded for (task, worktree HEAD) finished within the hour.
reuse_passing_run() {
  [ "$WT_SHA" != nohead ] || return 1
  if [ -n "$EXPECTED_SHA" ]; then
    case "$WT_SHA" in "$EXPECTED_SHA"*) ;; *) return 1 ;; esac
  fi
  local row
  row=$(tmb_verification_run_reusable "$DB" "$TASK_ID" "$WT_SHA")
  [ -n "$row" ] || return 1
  jq -nc --arg id "${row%%|*}" --arg at "${row#*|}" --arg sha "$WT_SHA" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":("TMB: verification reused run #" + $id + " (" + $at + ") — verification[] passed on commit " + $sha + " within the last hour, so it was not run again.")}}'
}

RUN_ID=""
record_command() {
  [ -n "$RUN_ID" ] || return 0
  tmb_verification_run_command "$DB" "$RUN_ID" "$@" || true
}
record_finish() {
  [ -n "$RUN_ID" ] || return 0
  tmb_verification_run_finish "$DB" "$RUN_ID" "$1" "$2" || true
}

deny() {
  jq -nc --arg r "$1" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
}

timeout_reason() {
  # timeout_reason <ordinal> <command> <command-elapsed|''> <cumulative>
  local ran=""
  [ -n "$3" ] && ran=" after ${3}s"
  printf 'BLOCKED: verification timed out — the %ss budget ran out %ss in, while running command %s/%s%s:\n%s\n\nRaise plugin_config.verification_timeout_s (config_set; capped at %ss) or speed up the command.%s' \
    "$TIMEOUT_S" "$4" "$1" "$CMD_TOTAL" "$ran" "$2" "$VERIFICATION_MAX_S" "${RUN_ID:+ Recorded as verification run #$RUN_ID.}"
}

# run_verification — runs verification[] once in the worktree, recording the
# run as it goes; prints the deny decision, or nothing when every command passed.
run_verification() {
  local run_start_ms cmd_start_ms remaining cmd_out cmd_rc cmd_elapsed total ordinal=0 hits tail_out
  run_start_ms=$(_tmb_now_ms)
  RUN_ID=$(tmb_verification_run_start "$DB" "$TASK_ID" "$WT_SHA" gate "$TIMEOUT_S") || RUN_ID=""

  # Each entry of the typed verification[] array is a clean shell command string
  # (Typed Rails #673); each non-empty line runs as a command in the worktree.
  while IFS= read -r CMD; do
    [ -z "$CMD" ] && continue
    ordinal=$(( ordinal + 1 ))

    remaining=$(( TIMEOUT_S - ($(_tmb_now_ms) - run_start_ms) / 1000 ))
    if [ "$remaining" -le 0 ]; then
      record_finish 124 1
      deny "$(timeout_reason "$ordinal" "$CMD" "" "$(ms_to_s $(( $(_tmb_now_ms) - run_start_ms )))")"
      return 0
    fi

    # Run the command in the worktree with the resolved toolchain PATH, bounded
    # by the remaining budget.
    cmd_start_ms=$(_tmb_now_ms)
    cmd_rc=0
    cmd_out=$( (cd "$WT_PATH" && PATH="$TOOLCHAIN_PATH" tmb_run_with_timeout "$remaining" bash -c "$CMD" </dev/null) 2>&1 ) || cmd_rc=$?
    cmd_elapsed=$(ms_to_s $(( $(_tmb_now_ms) - cmd_start_ms )))
    total=$(ms_to_s $(( $(_tmb_now_ms) - run_start_ms )))
    # No pipelines here: under pipefail a writer killed by SIGPIPE or a grep
    # with no match would end the hook without its deny.
    tail_out=$(tail -20 <<< "$cmd_out" || true)
    record_command "$ordinal" "$CMD" "$cmd_rc" "$cmd_elapsed" "$tail_out"

    if [ "$cmd_rc" -eq 124 ]; then
      record_finish 124 1
      deny "$(timeout_reason "$ordinal" "$CMD" "$cmd_elapsed" "$total")"
      return 0
    fi
    if [ "$cmd_rc" -ne 0 ]; then
      record_finish "$cmd_rc" 0
      hits=$(grep -m 15 -E 'FAIL|failed|Error|❌' <<< "$cmd_out" || true)
      [ -z "$hits" ] || hits=$(printf '\n\nFailure lines (max 15):\n%s' "$hits")
      deny "$(printf 'BLOCKED: verification failed.\nFailing command (%s/%s): %s\nExit %s after %ss; %ss cumulative.%s%s\n\nOutput (last 20 lines):\n%s' \
        "$ordinal" "$CMD_TOTAL" "$CMD" "$cmd_rc" "$cmd_elapsed" "$total" "${RUN_ID:+ Recorded as verification run #$RUN_ID.}" \
        "$hits" "$tail_out")"
      return 0
    fi
  done <<< "$VERIFICATION_BLOCK"

  record_finish 0 0
}

reuse_passing_run && exit 0

LOCK_ROOT="$(dirname "$DB")/locks"
LOCK="$LOCK_ROOT/verify-${TASK_ID}-${WT_SHA}"
STALE_S=$(( TIMEOUT_S + 60 ))

if ! mkdir -p "$LOCK_ROOT" 2>/dev/null; then
  run_verification
  exit 0
fi

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
done

trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT
now_s > "$LOCK/started"
reuse_passing_run && exit 0
run_verification
exit 0
