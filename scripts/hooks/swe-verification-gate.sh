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
#   - A passing recorded run for (task, worktree HEAD) of the current
#     verification[] (its command rows equal the commands, in order) finished
#     within the last hour, and tool_input.commit_sha (when given) names that
#     HEAD → allow without running, additionalContext "verification reused run
#     #N"; a run made before task_update_spec changed verification[] is not
#     reused (GH 1672)
#   - Otherwise, a command lib/verification-carry.js (dist) carries forward
#     from the task's last passing run on an ancestor commit — its inputs
#     declared in .config/tmb/verification-inputs.json untouched since — is
#     recorded with exit 0, elapsed 0 and "carried from run #R at <sha12>"
#     instead of run; the helper's time counts against the command budget (GH 1950)
#   - Verification passes          → allow (additionalContext names the
#     carried commands and their source run, when any)
#   - Verification fails           → DENY naming the failing command, its
#     elapsed and the cumulative time, the FAIL lines and the output tail (a
#     command that itself exits 124 is a failing command, not a timeout)
#   - Budget spent                 → DENY naming the command that was running
#     and the cumulative time
#
# Review findings (schema v47, GH 1737): after verification[] passes, the gate
# runs the probe_cmd of every review_findings row of the task whose status is
# not wontfix, in id order, in the worktree under the same budget. A probe
# that exits 0 on an open finding sets it fixed with resolved_at; every probe
# runs, and any failing one DENIES naming the finding — a failing fixed
# finding as a regression. Each probe is recorded as a verification_run_commands
# row whose command is `[probe <id>] <probe_cmd>`, so the reusable-run match
# and bro_atomic_close (gateCommands in verification-runs.ts) count a run only
# when it also covered the current findings. A task with no verification[]
# but findings still runs its probes. A DB without review_findings has none.
#
# Record (schema v36): every run is written to verification_runs (source
# 'gate', commit_sha = the worktree HEAD) through lib/verification-runs.sh —
# the row when the run starts, a verification_run_commands row after each
# command (exit code, elapsed seconds, output tail), then finished_at,
# exit_code and timed_out. task_brief.verification_run reads it back. When the
# worktree HEAD does not resolve nothing is recorded or reused: verification[]
# still runs and the decision says "(not recorded: worktree HEAD unresolvable)".
# timed_out is 1 only when the gate's own timeout wrapper fired or the budget
# was spent before a command started. The finish write is tried
# VERIFICATION_FINISH_ATTEMPTS times; when every attempt fails the decision
# stands, stderr says the record is unfinished, and trajectory_doctor's
# no_unfinished_verification_runs reports the row once it is 2 h old.
#
# Budget: plugin_config.verification_timeout_s (integer seconds, default 900),
# overridden by TMB_VERIFICATION_TIMEOUT_S, clamped to [1, VERIFICATION_MAX_S];
# a value below 1 or not an integer falls back to the default with a stderr
# warning. The budget counts command time only: the run-record writes are timed
# separately — each write gets VERIFICATION_RECORD_BUDGET_MS, the start and
# command writes together at most VERIFICATION_RECORD_POOL_MS (once spent,
# further command rows are skipped), and the finish write
# VERIFICATION_FINISH_ATTEMPTS tries with a backoff of attempt ×
# VERIFICATION_FINISH_BACKOFF_MS between them. The hooks.json timeout must
# cover
#   VERIFICATION_MAX_S + ceil((POOL + ATTEMPTS × RECORD_BUDGET
#                              + BACKOFF × ATTEMPTS × (ATTEMPTS-1) / 2) / 1000)
#   + 1 s dispatcher + 5 s (reads, toolchain resolution, the decision)
# = 1800 + 20 + 1 + 5 = 1826 s against 1830 s;
# tests/l1-lint/hook-timeout-budget.sh derives the same floor from this file.
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

# tmb_run_with_timeout <secs> <fired-file> <cmd...> — runs <cmd...> bounded by
# <secs> through `timeout` (else `gtimeout`, brew coreutils, else a perl
# alarm()); exit 124 when the wrapper fired. <fired-file> is created only when
# the wrapper's own alarm fired, so a command that itself exits 124 is told
# apart: under coreutils the command's own exit leaves <fired-file>.done. An
# empty <fired-file> (no scratch dir) runs the command without the marker.
tmb_run_with_timeout() {
  local secs="$1" fired="$2" impl rc=0
  shift 2
  impl=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)
  if [ -n "$impl" ] && [ -z "$fired" ]; then
    "$impl" "$secs" "$@"
    return
  fi
  if [ -n "$impl" ]; then
    "$impl" "$secs" bash -c '"${@:2}"; rc=$?; : > "$1"; exit "$rc"' _ "$fired.done" "$@" || rc=$?
    if [ "$rc" -eq 124 ] && [ ! -e "$fired.done" ]; then
      : > "$fired"
    fi
    rm -f "$fired.done"
    return "$rc"
  fi
  perl -e '
    use strict; use warnings;
    my $secs = shift @ARGV;
    my $fired = shift @ARGV;
    my $pid = fork();
    if (!defined $pid) { exit 1; }
    if ($pid == 0) { exec @ARGV; exit 1; }
    local $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); if ($fired ne "" && open(my $fh, ">", $fired)) { close $fh; } exit 124 };
    alarm $secs;
    waitpid($pid, 0);
    alarm 0;
    exit(($? >> 8) & 0xff);
  ' "$secs" "$fired" "$@"
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

FINDINGS_JSON=$(tmb_review_findings_active "$DB" "$TASK_ID")
if [ "$FINDINGS_JSON" = "__ERR__" ]; then
  printf '%s\n' "$DB_UNAVAILABLE_DENY"
  exit 0
fi
PROBE_TOTAL=$(jq 'length' <<< "$FINDINGS_JSON" 2>/dev/null || true)
case "$PROBE_TOTAL" in ''|*[!0-9]*) FINDINGS_JSON='[]'; PROBE_TOTAL=0 ;; esac

# Parse the JSON array into commands (one per line). Empty array or invalid JSON
# yields no lines.
VERIFICATION_BLOCK=$(printf '%s' "$VERIFICATION_JSON" | jq -r '.[]?' 2>/dev/null || true)

# Empty typed verification[] and no review finding to probe → skip the gate.
if [ -z "$VERIFICATION_BLOCK" ] && [ "$PROBE_TOTAL" -eq 0 ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: task has no typed verification[] — verification gate skipped. Ask bro to set the task'"'"'s verification[] field (Typed Rails #673) to enforce verification commands."}}'
  exit 0
fi

# Extract the SLUG from branch_id (minus its first <type>/) to locate worktree.
SLUG=$(tmb_branch_slug "$BRANCH_ID")

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
VERIFICATION_RECORD_BUDGET_MS=3000
VERIFICATION_RECORD_POOL_MS=9000
VERIFICATION_FINISH_ATTEMPTS=3
VERIFICATION_FINISH_BACKOFF_MS=500

TIMEOUT_RAW="${TMB_VERIFICATION_TIMEOUT_S:-}"
[ -n "$TIMEOUT_RAW" ] || TIMEOUT_RAW=$(tmb_config_get verification_timeout_s "$DB" 2>/dev/null || true)
TIMEOUT_S="$VERIFICATION_DEFAULT_S"
case "$TIMEOUT_RAW" in
  '') ;;
  *[!0-9]*) TIMEOUT_S="" ;;
  *)
    if [ "${#TIMEOUT_RAW}" -gt 9 ]; then
      TIMEOUT_S="$VERIFICATION_MAX_S"
    elif [ "$(( 10#$TIMEOUT_RAW ))" -ge 1 ]; then
      TIMEOUT_S=$(( 10#$TIMEOUT_RAW ))
    else
      TIMEOUT_S=""
    fi
    ;;
esac
if [ -z "$TIMEOUT_S" ]; then
  printf "swe-verification-gate: verification_timeout_s '%s' is not an integer from 1 to %s; using the default %ss\n" \
    "$(printf '%s' "$TIMEOUT_RAW" | tr '\n' ' ')" "$VERIFICATION_MAX_S" "$VERIFICATION_DEFAULT_S" >&2
  TIMEOUT_S="$VERIFICATION_DEFAULT_S"
fi
if [ "$TIMEOUT_S" -gt "$VERIFICATION_MAX_S" ]; then
  TIMEOUT_S="$VERIFICATION_MAX_S"
fi

WT_SHA=$(git -C "$WT_PATH" rev-parse --verify -q HEAD 2>/dev/null || true)
EXPECTED_SHA=$(echo "$INPUT" | jq -r '.tool_input.commit_sha // empty' 2>/dev/null || true)
CMD_TOTAL=$(( $(grep -c . <<< "$VERIFICATION_BLOCK" || true) + PROBE_TOTAL ))
GATE_CMDS_JSON=$(jq -cRn --argjson f "$FINDINGS_JSON" \
  '[inputs | select(length > 0)] + [$f[] | "[probe " + .id + "] " + .probe_cmd]' <<< "$VERIFICATION_BLOCK" 2>/dev/null || true)
[ -n "$GATE_CMDS_JSON" ] || GATE_CMDS_JSON='[]'

now_s() { date +%s 2>/dev/null || echo 0; }
ms_to_s() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }

# Scratch dir for the timeout wrapper's fired markers, beside the DB.
SCRATCH=$(mktemp -d "$(dirname "$DB")/verify-run.XXXXXX" 2>/dev/null || true)
[ -z "$SCRATCH" ] || SCRATCH=$(cd "$SCRATCH" && pwd)
LOCK=""
LOCK_HELD=""
cleanup() {
  [ -z "$LOCK_HELD" ] || rm -rf "$LOCK" 2>/dev/null || true
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH" 2>/dev/null || true
}
trap cleanup EXIT

# reuse_passing_run — prints the allow-with-context decision and succeeds when
# a passing run recorded for (task, worktree HEAD) finished within the hour.
reuse_passing_run() {
  [ -n "$WT_SHA" ] || return 1
  if [ -n "$EXPECTED_SHA" ]; then
    case "$WT_SHA" in "$EXPECTED_SHA"*) ;; *) return 1 ;; esac
  fi
  local row
  row=$(tmb_verification_run_reusable "$DB" "$TASK_ID" "$WT_SHA" "" "$GATE_CMDS_JSON")
  [ -n "$row" ] || return 1
  jq -nc --arg id "${row%%|*}" --arg at "${row#*|}" --arg sha "$WT_SHA" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":("TMB: verification reused run #" + $id + " (" + $at + ") — verification[] passed on commit " + $sha + " within the last hour, so it was not run again.")}}'
}

RUN_ID=""
RECORD_MS=0
POOL_NOTED=""

# record_allowance_ms — the budget of the next start/command write: the
# per-write budget, or what is left of the pool when that is less; fails once
# the pool is spent.
record_allowance_ms() {
  local left=$(( VERIFICATION_RECORD_POOL_MS - RECORD_MS ))
  [ "$left" -gt 0 ] || return 1
  [ "$left" -le "$VERIFICATION_RECORD_BUDGET_MS" ] || left="$VERIFICATION_RECORD_BUDGET_MS"
  printf '%s' "$left"
}

# record_write <ms> <writer> <args...> — one lib/verification-runs.sh write
# bounded by <ms>, independent of the hook's shared db-write run budget.
record_write() {
  local ms="$1"
  shift
  TMB_DB_WRITE_TIMEOUT_MS="$ms" TMB_DB_WRITE_RUN_BUDGET_MS="$ms" _TMB_DB_WRITE_SPENT_MS=0 "$@"
}

record_command() {
  [ -n "$RUN_ID" ] || return 0
  local ms t0
  if ! ms=$(record_allowance_ms); then
    if [ -z "$POOL_NOTED" ]; then
      POOL_NOTED=1
      printf 'swe-verification-gate: run-record write budget (%sms) spent; verification run #%s keeps no further command rows\n' \
        "$VERIFICATION_RECORD_POOL_MS" "$RUN_ID" >&2
    fi
    return 0
  fi
  t0=$(_tmb_now_ms)
  record_write "$ms" tmb_verification_run_command "$DB" "$RUN_ID" "$@" || true
  RECORD_MS=$(( RECORD_MS + $(_tmb_now_ms) - t0 ))
}

record_finish() {
  [ -n "$RUN_ID" ] || return 0
  local attempt=1
  while :; do
    if record_write "$VERIFICATION_RECORD_BUDGET_MS" tmb_verification_run_finish "$DB" "$RUN_ID" "$1" "$2"; then
      return 0
    fi
    [ "$attempt" -lt "$VERIFICATION_FINISH_ATTEMPTS" ] || break
    sleep "$(ms_to_s $(( attempt * VERIFICATION_FINISH_BACKOFF_MS )))"
    attempt=$(( attempt + 1 ))
  done
  printf 'swe-verification-gate: verification run #%s record unfinished — its finish write failed %s times; the decision stands (trajectory_doctor reports it under no_unfinished_verification_runs after 2 h)\n' \
    "$RUN_ID" "$VERIFICATION_FINISH_ATTEMPTS" >&2
  return 0
}

record_note() {
  if [ -n "$RUN_ID" ]; then
    printf ' Recorded as verification run #%s.' "$RUN_ID"
  elif [ -z "$WT_SHA" ]; then
    printf ' (not recorded: worktree HEAD unresolvable)'
  fi
}

deny() {
  jq -nc --arg r "$1" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
}

timeout_reason() {
  # timeout_reason <ordinal> <command> <command-elapsed|''> <cumulative>
  local ran=""
  [ -n "$3" ] && ran=" after ${3}s"
  printf 'BLOCKED: verification timed out — the %ss budget ran out %ss in, while running command %s/%s%s:\n%s\n\nRaise plugin_config.verification_timeout_s (config_set; capped at %ss) or speed up the command.%s' \
    "$TIMEOUT_S" "$4" "$1" "$CMD_TOTAL" "$ran" "$2" "$VERIFICATION_MAX_S" "$(record_note)"
}

CARRY_JS="$SCRIPT_DIR/../../mcp/trajectory-server/dist/hooks/lib/verification-carry.js"
VERIFICATION_CARRY_TIMEOUT_S=10
CARRY_RUN=""
CARRY_SHA=""
CARRY_ORDINALS=""
CARRIED_CMDS=""

# plan_carry — sets CARRY_RUN, CARRY_SHA and CARRY_ORDINALS (" 1 3 ") from
# lib/verification-carry.js: the verification[] commands this run records as
# carried from an earlier passing run instead of running them (GH 1950). No
# node, no dist file, a helper error or timeout, or output that is not a plan
# leaves them empty, and every command runs.
plan_carry() {
  local secs="$VERIFICATION_CARRY_TIMEOUT_S" out line run rest sha ords
  [ -f "$CARRY_JS" ] || return 0
  [ "$TIMEOUT_S" -ge "$secs" ] || secs="$TIMEOUT_S"
  out=$(cd "$WT_PATH" && PATH="$TOOLCHAIN_PATH" tmb_run_with_timeout "$secs" "" \
    node "$CARRY_JS" "$DB" "$TASK_ID" "$WT_PATH" "$WT_SHA" "$GATE_CMDS_JSON" </dev/null 2>/dev/null) || return 0
  line=$(jq -r 'select((.source_run | type) == "number" and (.source_sha | type) == "string" and (.carry | type) == "array")
    | "\(.source_run)|\(.source_sha)|\(.carry | map(tostring) | join(" "))"' <<< "$out" 2>/dev/null) || return 0
  run="${line%%|*}"
  rest="${line#*|}"
  sha="${rest%%|*}"
  ords="${rest#*|}"
  case "$run" in ''|*[!0-9]*) return 0 ;; esac
  [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || return 0
  [[ "$ords" =~ ^[0-9]+( [0-9]+)*$ ]] || return 0
  CARRY_RUN="$run"
  CARRY_SHA="$sha"
  CARRY_ORDINALS=" $ords "
}

is_carried() {
  case "$CARRY_ORDINALS" in *" $1 "*) return 0 ;; esac
  return 1
}

# run_verification — runs verification[] once in the worktree, recording the
# run as it goes; prints the deny decision, or nothing when every command passed
# and the run is recorded. The command budget and the cumulative time count
# command time only (RECORD_MS, the time spent in record writes, is excluded).
run_verification() {
  local run_start_ms ms cmd_start_ms cmd_ms remaining cmd_out cmd_rc cmd_elapsed total ordinal=0 hits tail_out fired timed_out CMD
  run_start_ms=$(_tmb_now_ms)
  if [ -n "$WT_SHA" ] && ms=$(record_allowance_ms); then
    RUN_ID=$(record_write "$ms" tmb_verification_run_start "$DB" "$TASK_ID" "$WT_SHA" gate "$TIMEOUT_S") || RUN_ID=""
    RECORD_MS=$(( $(_tmb_now_ms) - run_start_ms ))
  fi
  active_ms() { printf '%s' "$(( $(_tmb_now_ms) - run_start_ms - RECORD_MS ))"; }

  # run_one <run-cmd> <recorded-cmd> — runs <run-cmd> in the worktree with the
  # resolved toolchain PATH, bounded by the remaining budget, and records it as
  # <recorded-cmd>; sets cmd_rc/cmd_out/cmd_elapsed/total/tail_out. On a spent
  # or exceeded budget it finishes the run, prints the timeout deny and fails.
  run_one() {
    ordinal=$(( ordinal + 1 ))
    remaining=$(( TIMEOUT_S - $(active_ms) / 1000 ))
    if [ "$remaining" -le 0 ]; then
      record_finish 124 1
      deny "$(timeout_reason "$ordinal" "$2" "" "$(ms_to_s "$(active_ms)")")"
      return 1
    fi
    fired=""
    [ -z "$SCRATCH" ] || fired="$SCRATCH/fired-$ordinal"
    cmd_start_ms=$(_tmb_now_ms)
    cmd_rc=0
    cmd_out=$( (cd "$WT_PATH" && PATH="$TOOLCHAIN_PATH" tmb_run_with_timeout "$remaining" "$fired" bash -c "$1" </dev/null) 2>&1 ) || cmd_rc=$?
    cmd_ms=$(( $(_tmb_now_ms) - cmd_start_ms ))
    cmd_elapsed=$(ms_to_s "$cmd_ms")
    total=$(ms_to_s "$(active_ms)")
    timed_out=0
    if [ "$cmd_rc" -eq 124 ]; then
      if [ -n "$fired" ]; then
        if [ -e "$fired" ]; then timed_out=1; fi
      elif [ "$cmd_ms" -ge $(( remaining * 1000 )) ]; then
        timed_out=1
      fi
    fi
    # No pipelines here: under pipefail a writer killed by SIGPIPE or a grep
    # with no match would end the hook without its deny.
    tail_out=$(tail -20 <<< "$cmd_out" || true)
    record_command "$ordinal" "$2" "$cmd_rc" "$cmd_elapsed" "$tail_out"
    if [ "$timed_out" -eq 1 ]; then
      record_finish 124 1
      deny "$(timeout_reason "$ordinal" "$2" "$cmd_elapsed" "$total")"
      return 1
    fi
    return 0
  }

  # Each entry of the typed verification[] array is a clean shell command string
  # (Typed Rails #673); each non-empty line runs as a command in the worktree.
  [ -z "$RUN_ID" ] || plan_carry

  while IFS= read -r CMD; do
    [ -z "$CMD" ] && continue
    if is_carried $(( ordinal + 1 )); then
      ordinal=$(( ordinal + 1 ))
      record_command "$ordinal" "$CMD" 0 0 "carried from run #${CARRY_RUN} at ${CARRY_SHA:0:12}"
      CARRIED_CMDS+="${CARRIED_CMDS:+$'\n'}${CMD}"
      continue
    fi
    run_one "$CMD" "$CMD" || return 0
    if [ "$cmd_rc" -ne 0 ]; then
      record_finish "$cmd_rc" 0
      hits=$(grep -m 15 -E 'FAIL|failed|Error|❌' <<< "$cmd_out" || true)
      [ -z "$hits" ] || hits=$(printf '\n\nFailure lines (max 15):\n%s' "$hits")
      deny "$(printf 'BLOCKED: verification failed.\nFailing command (%s/%s): %s\nExit %s after %ss; %ss cumulative.%s%s\n\nOutput (last 20 lines):\n%s' \
        "$ordinal" "$CMD_TOTAL" "$CMD" "$cmd_rc" "$cmd_elapsed" "$total" "$(record_note)" \
        "$hits" "$tail_out")"
      return 0
    fi
  done <<< "$VERIFICATION_BLOCK"

  # Review finding probes: every one runs; a pass on an open finding fixes it.
  local i=0 fid fstatus pcmd probe_fail="" probe_rc=0 regressed t0
  while [ "$i" -lt "$PROBE_TOTAL" ]; do
    fid=$(jq -r --argjson i "$i" '.[$i].id' <<< "$FINDINGS_JSON")
    fstatus=$(jq -r --argjson i "$i" '.[$i].status' <<< "$FINDINGS_JSON")
    pcmd=$(jq -r --argjson i "$i" '.[$i].probe_cmd' <<< "$FINDINGS_JSON")
    i=$(( i + 1 ))
    run_one "$pcmd" "[probe $fid] $pcmd" || return 0
    if [ "$cmd_rc" -eq 0 ]; then
      if [ "$fstatus" = "open" ]; then
        if ms=$(record_allowance_ms); then
          t0=$(_tmb_now_ms)
          record_write "$ms" tmb_review_finding_fixed "$DB" "$fid" >/dev/null || \
            printf 'swe-verification-gate: review finding %s probe passed but its fixed write failed; it stays open\n' "$fid" >&2
          RECORD_MS=$(( RECORD_MS + $(_tmb_now_ms) - t0 ))
        else
          printf 'swe-verification-gate: run-record write budget (%sms) spent; review finding %s probe passed but it stays open\n' \
            "$VERIFICATION_RECORD_POOL_MS" "$fid" >&2
        fi
      fi
      continue
    fi
    [ "$probe_rc" -ne 0 ] || probe_rc="$cmd_rc"
    regressed=""
    [ "$fstatus" != "fixed" ] || regressed=" — REGRESSION: this finding was fixed and its probe fails again"
    probe_fail+=$(printf '\n\nFinding %s (probe %s/%s)%s: %s\nExit %s after %ss.\nOutput (last 20 lines):\n%s' \
      "$fid" "$ordinal" "$CMD_TOTAL" "$regressed" "$pcmd" "$cmd_rc" "$cmd_elapsed" "$tail_out")
  done
  if [ -n "$probe_fail" ]; then
    record_finish "$probe_rc" 0
    deny "$(printf 'BLOCKED: verification failed — review finding probe(s) failed; %ss cumulative.%s%s\n\nFix each finding so its probe exits 0 (task_brief.open_findings lists the open ones).' \
      "$(ms_to_s "$(active_ms)")" "$(record_note)" "$probe_fail")"
    return 0
  fi

  record_finish 0 0
  if [ -z "$WT_SHA" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: verification[] passed (not recorded: worktree HEAD unresolvable)."}}'
  elif [ -n "$CARRIED_CMDS" ]; then
    jq -nc --arg run "$CARRY_RUN" --arg sha "${CARRY_SHA:0:12}" --arg cmds "$CARRIED_CMDS" --arg n "$CMD_TOTAL" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":("TMB: verification carried forward from run #" + $run + " at " + $sha + " — this commit touched none of their declared inputs (.config/tmb/verification-inputs.json), so these commands were not run again; the rest of the " + $n + " ran:\n" + $cmds)}}'
  fi
}

reuse_passing_run && exit 0

if [ -z "$WT_SHA" ]; then
  run_verification
  exit 0
fi

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

LOCK_HELD=1
now_s > "$LOCK/started"
reuse_passing_run && exit 0
run_verification
exit 0
