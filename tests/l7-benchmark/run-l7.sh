#!/usr/bin/env bash
# L7 Bench runner (#6) — TMB-on vs raw Claude on the same agentic-SWE tasks.
# Three orthogonal scoring axes: problem-solving, token-saving, quality.
#
# Usage:
#   bash tests/l7-benchmark/run-l7.sh <task-name>            # one task
#   bash tests/l7-benchmark/run-l7.sh --all                  # every task in tasks/
#   N=3 bash tests/l7-benchmark/run-l7.sh --all              # N runs per (task, arm)
#   --require-prefix: abort pre-spawn if TMB_BENCH_PROMPT_PREFIX is unset/empty
#
# Model default: claude-opus-4-8 (live). Override via TMB_BENCH_MODEL.
# Raw arm is byte-identical to previous behaviour except for the model default.
#
# See tests/l7-benchmark/README.md for full design + cost ceiling.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
export PLUGIN_ROOT

# shellcheck source=tests/l7-benchmark/lib/bench-helpers.sh
. "$HERE/lib/bench-helpers.sh"

N="${N:-1}"
TASKS_DIR="$HERE/tasks"
RUNS_ROOT="${TMB_BENCH_RUNS_DIR:-$HOME/.claude/tmb/bench-runs}"
REQUIRE_PREFIX=0

# Resolve task arg + help-text path before auth check so users get usage
# without needing credentials. Strip --require-prefix first so the remaining
# positional args resolve cleanly.
ARGS=()
for _arg in "$@"; do
  if [ "$_arg" = "--require-prefix" ]; then
    REQUIRE_PREFIX=1
  else
    ARGS+=("$_arg")
  fi
done
TASK_ARG="${ARGS[0]:-}"
TASKS=()
case "$TASK_ARG" in
  ""|-h|--help)
    printf "Usage: %s <task-name|--all> [N=runs-per-arm, default 1]\n\n" "$0"
    printf "Available tasks:\n"
    if [ -d "$TASKS_DIR" ] && compgen -G "$TASKS_DIR"/*/ >/dev/null; then
      for d in "$TASKS_DIR"/*/; do
        [ -d "$d" ] && [ -f "$d/task.json" ] && printf "  %s\n" "$(basename "$d")"
      done
    else
      printf "  (none — see tasks/README.md for cherry-pick candidates)\n"
    fi
    exit 0
    ;;
  --all)
    if [ -d "$TASKS_DIR" ] && compgen -G "$TASKS_DIR"/*/ >/dev/null; then
      for d in "$TASKS_DIR"/*/; do
        [ -d "$d" ] && [ -f "$d/task.json" ] && TASKS+=("$(basename "$d")")
      done
    fi
    ;;
  *)
    [ -d "$TASKS_DIR/$TASK_ARG" ] || { printf "❌ task not found: %s\n" "$TASK_ARG" >&2; exit 1; }
    TASKS=("$TASK_ARG")
    ;;
esac

[ "${#TASKS[@]}" -gt 0 ] || { printf "❌ no tasks in %s — see tasks/README.md\n" "$TASKS_DIR" >&2; exit 1; }

# Auth + cmd checks happen AFTER task resolution so help-text path works
# without credentials.
RUN_ID="${RUN_ID:-$(date -u +%Y%m%d-%H%M%S)-$$}"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set — bench needs real claude calls.\n" >&2
  exit 1
fi
for cmd in claude sqlite3 jq git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd" >&2
    exit 1
  fi
done

# --require-prefix preflight: abort if the prefix is unset/empty.
if [ "$REQUIRE_PREFIX" = "1" ] && [ -z "${TMB_BENCH_PROMPT_PREFIX:-}" ]; then
  printf "❌ --require-prefix set but TMB_BENCH_PROMPT_PREFIX is unset/empty.\n" >&2
  exit 1
fi

RESULTS_JSONL="$RUN_DIR/_results.jsonl"
: > "$RESULTS_JSONL"

printf '=== L7 bench %s ===\n' "$RUN_ID"
printf '  tasks:    %s\n' "${TASKS[*]}"
if [ "${TMB_BENCH_RAW:-0}" = "1" ]; then
  printf '  arm:      raw (pure model baseline, no plugin loaded;\n'
  printf '            model: %s)\n' "${TMB_BENCH_MODEL:-claude-opus-4-8}"
else
  printf '  arm:      tmb-on (TMB plugin loaded; compare against\n'
  printf '            published comparators — see RESULTS.md)\n'
fi
printf '  N:        %d per task\n' "$N"
printf '  logs:     %s\n\n' "$RUN_DIR"

run_one() {
  local task="$1" arm="$2" run_idx="$3"
  local task_dir="$TASKS_DIR/$task"
  local out_dir="$RUN_DIR/$task/$arm/run-$run_idx"
  mkdir -p "$out_dir"

  # 1. Setup: fresh scratch project, run task's setup.sh into it.
  local project
  project=$(bench_setup_scratch_project)
  trap 'rm -rf "$project"' RETURN
  if [ -x "$task_dir/setup.sh" ]; then
    "$task_dir/setup.sh" "$project" "$task_dir" > "$out_dir/setup.log" 2>&1 || true
  fi

  # 2. Run: claude -p with or without the plugin.
  local prompt
  prompt=$(cat "$task_dir/prompt.txt")
  local transcript="$out_dir/transcript.jsonl"
  printf "%s" "$prompt" > "$out_dir/prompt.txt"
  bench_log "  $task / $arm / run-$run_idx — invoking claude"
  local t_start t_end duration_s
  t_start=$(date +%s)
  bench_run_arm "$arm" "$project" "$prompt" "$transcript" || true
  t_end=$(date +%s)
  duration_s=$((t_end - t_start))

  # 2a. Budget: detect turn exhaustion in result payload.
  if grep -q '"error_max_turns"' "$transcript" 2>/dev/null; then
    bench_log "  BUDGET: exhausted"
    printf '    BUDGET: exhausted\n'
  fi

  # 2b. Model verification: extract init event's actual model from transcript,
  #     compare against requested model. Exit non-zero on mismatch.
  local requested_model actual_model
  requested_model="${TMB_BENCH_MODEL:-claude-opus-4-8}"
  actual_model=$(jq -r 'select(.type=="system" and (.subtype=="init" or .event=="init")) | (.model // .data.model) // empty' \
    "$transcript" 2>/dev/null | head -1)
  if [ -z "$actual_model" ]; then
    actual_model=$(jq -r 'select(has("model")) | .model // empty' \
      "$transcript" 2>/dev/null | head -1)
  fi
  printf '    MODEL: requested=%s actual=%s\n' "$requested_model" "${actual_model:-unknown}"
  if [ -n "$actual_model" ] && [ "$actual_model" != "$requested_model" ]; then
    bench_log "  MODEL MISMATCH: requested=$requested_model actual=$actual_model"
    printf "❌ MODEL MISMATCH: requested=%s actual=%s\n" "$requested_model" "$actual_model" >&2
    return 1
  fi

  # 3. Capture trajectory.db (arm A only) for post-mortem.
  local db
  db=$(bench_resolve_db "$project")
  if [ -n "$db" ]; then
    cp "$db" "$out_dir/trajectory.db" 2>/dev/null || true
  fi

  # 3a. Reap: if the task repo has branches ahead of base with un-merged commits,
  #     cherry-pick them onto the working tree before verify.sh sees it.
  #     Doctrine-compliant runs leave work on task branches with no remote.
  (
    cd "$project" || exit 0
    _reap_base=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
    _reap_ahead=$(git for-each-ref --format='%(refname:short) %(ahead-behind:HEAD)' refs/heads \
      2>/dev/null | awk -v base="$_reap_base" '$1 != base && $2+0 > 0 {print $1}' || true)
    if [ -n "$_reap_ahead" ]; then
      _reap_branch=$(printf '%s' "$_reap_ahead" | tail -1)
      _reap_sha=$(git rev-parse "$_reap_branch" 2>/dev/null || true)
      bench_log "  REAP: merging branch=$_reap_branch sha=${_reap_sha:0:12} onto working tree"
      printf '    REAP: branch=%s sha=%s\n' "$_reap_branch" "${_reap_sha:0:12}"
      git merge --no-edit "$_reap_branch" >> "$out_dir/reap.log" 2>&1 || \
        git cherry-pick "$(git merge-base HEAD "$_reap_branch")".."$_reap_branch" \
          >> "$out_dir/reap.log" 2>&1 || true
    fi
  )

  # 4. Score the axes (SWE-bench: resolved + apply + tokens + cost + duration;
  #    TMB-specific: quality composite + hallucination check).
  local probsol applied token quality halluc verify_ec
  probsol=$("$HERE/scorers/problem-solving.sh" "$task_dir" "$project" 2>/dev/null || echo '{"axis":"problem_solving","pass":0}')
  applied=$("$HERE/scorers/apply.sh" "$project" 2>/dev/null || echo '{"axis":"apply","applied":0,"files_changed":0}')
  token=$("$HERE/scorers/token-saving.sh" "$transcript" "$out_dir/trajectory.db" 2>/dev/null || echo '{"axis":"token_saving","total_tokens":0}')
  quality=$("$HERE/scorers/quality.sh" "$project" "$out_dir/trajectory.db" 2>/dev/null || echo '{"axis":"quality","score":0}')
  # Hallucination axis: did the agent claim success when verify says no?
  verify_ec=$(jq -r '.pass // 0' <<< "$probsol")
  [ "$verify_ec" = "1" ] && verify_ec="0" || verify_ec="1"
  halluc=$("$HERE/scorers/hallucination.sh" "$transcript" "$verify_ec" 2>/dev/null || echo '{"axis":"hallucination","hallucinated":0,"claimed_success":0,"verify_passed":0}')

  # 4a. Ceremony check: when @bro is in the prefix, assert the trajectory DB
  #     shows doctrine fired (tasks rows OR planning_complete audit event).
  #     Print CEREMONY: fired/INERT; exit non-zero on INERT.
  if [[ "${TMB_BENCH_PROMPT_PREFIX:-}" == *"@bro"* ]]; then
    local ceremony_status="INERT"
    if [ -f "$out_dir/trajectory.db" ]; then
      local task_rows audit_rows
      task_rows=$(sqlite3 "$out_dir/trajectory.db" \
        "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo 0)
      audit_rows=$(sqlite3 "$out_dir/trajectory.db" \
        "SELECT COUNT(*) FROM audit_log WHERE event_type='planning_complete';" 2>/dev/null || echo 0)
      if [ "$task_rows" -gt 0 ] || [ "$audit_rows" -gt 0 ]; then
        ceremony_status="fired"
      fi
    fi
    printf '    CEREMONY: %s\n' "$ceremony_status"
    bench_log "  CEREMONY: $ceremony_status"
    if [ "$ceremony_status" = "INERT" ]; then
      printf "❌ CEREMONY INERT: doctrine chain did not fire for @bro run\n" >&2
      return 1
    fi
  fi

  # 5. Persist scores + emit run record. `resolved` is the SWE-bench-aligned
  #    canonical name for problem-solving; we keep `problem_solving` as an
  #    alias for backwards compat with downstream readers.
  jq -nc \
    --arg task "$task" --arg arm "$arm" --argjson run "$run_idx" \
    --argjson duration "$duration_s" \
    --argjson ps "$probsol" --argjson ap "$applied" \
    --argjson tk "$token" --argjson ql "$quality" --argjson hl "$halluc" \
    '{task: $task, arm: $arm, run: $run,
      resolved: $ps.pass,
      problem_solving: $ps.pass,
      applied: $ap.applied,
      files_changed: $ap.files_changed,
      tokens: $tk.total_tokens,
      cost_usd: ($tk.cost_usd // 0),
      duration_s: $duration,
      quality_score: $ql.score,
      hallucinated: $hl.hallucinated,
      claimed_success: $hl.claimed_success,
      problem_solving_detail: $ps,
      apply_detail: $ap,
      token_detail: $tk,
      quality_detail: $ql,
      hallucination_detail: $hl}' \
    | tee -a "$RESULTS_JSONL" > "$out_dir/scores.json"

  local ps_pass ap_pass tk_total tk_cost ql_score hl_flag
  ps_pass=$(jq -r '.pass' <<< "$probsol")
  ap_pass=$(jq -r '.applied' <<< "$applied")
  tk_total=$(jq -r '.total_tokens' <<< "$token")
  tk_cost=$(jq -r '.cost_usd // 0' <<< "$token")
  ql_score=$(jq -r '.score' <<< "$quality")
  hl_flag=$(jq -r '.hallucinated' <<< "$halluc")
  printf '    → resolved=%s  applied=%s  tokens=%s  cost=$%s  duration=%ss  quality=%s/5  hallucinated=%s\n' \
    "$ps_pass" "$ap_pass" "$tk_total" "$tk_cost" "$duration_s" "$ql_score" "$hl_flag"
}

ARM="tmb-on"
[ "${TMB_BENCH_RAW:-0}" = "1" ] && ARM="raw"

for task in "${TASKS[@]}"; do
  printf "── %s ──\n" "$task"
  for run_idx in $(seq 1 "$N"); do
    run_one "$task" "$ARM" "$run_idx"
  done
  printf "\n"
done

# Single-arm summary — we compare against the published SWE-bench leaderboard
# (claude-sonnet entries), not against a local raw arm. TMB's SWE worker is
# Sonnet, so the relevant comparator is "pure Sonnet" results on the same
# task IDs. See README.md for the comparison protocol.
SUMMARY="$RUN_DIR/summary.md"
{
  printf "# L7 bench summary — %s\n\n" "$RUN_ID"
  printf "## Per-run results (tmb-on)\n\n"
  printf "| Task | Run | Resolved | Apply | Tokens | Cost \$ | Duration s | Quality |\n"
  printf "|---|---|---|---|---|---|---|---|\n"
  jq -r '"| " + .task + " | " + (.run|tostring)
         + " | " + (if .resolved == 1 then "✅" else "❌" end)
         + " | " + (if .applied  == 1 then "✅" else "❌" end)
         + " | " + (.tokens|tostring)
         + " | " + (.cost_usd|tostring)
         + " | " + (.duration_s|tostring)
         + " | " + (.quality_score|tostring) + "/5 |"' "$RESULTS_JSONL"

  printf "\n## Per-axis means (tmb-on, all tasks)\n\n"
  printf "| Axis | tmb-on mean | Aligns with |\n"
  printf "|---|---|---|\n"
  emit_row() {
    local axis="$1" label="$2" align="$3"
    local tmb
    tmb=$(jq -s "map(.${axis}) | add / length // 0" "$RESULTS_JSONL")
    printf "| %s | %s | %s |\n" "$label" "$tmb" "$align"
  }
  emit_row resolved      "% Resolved"     "SWE-bench %Resolved (primary)"
  emit_row applied       "% Apply"        "SWE-bench %Apply"
  emit_row tokens        "Avg tokens"     "SWE-bench Avg tokens"
  emit_row cost_usd      "Avg cost \$"    "SWE-bench Cost"
  emit_row duration_s    "Avg duration s" "SWE-bench Time"
  emit_row quality_score "Quality /5"     "TMB-specific composite"
  emit_row hallucinated  "% Hallucinated" "TMB-specific (smart = less hallucination)"

  printf "\n## Comparator: pure claude-sonnet on SWE-bench Lite\n\n"
  printf "Per-task pass/fail for claude-sonnet (no TMB) lives on the\n"
  printf "[SWE-bench Lite leaderboard](https://www.swebench.com/lite.html).\n"
  printf "Look up each task ID's status in the published submission, then\n"
  printf "compare against this table. **Win condition:** TMB resolves at\n"
  printf "least one task pure Sonnet couldn't, even at higher token cost.\n"
} > "$SUMMARY"

printf "\n========================================\n"
printf "Bench complete: %d task(s) × tmb-on × N=%d\n" "${#TASKS[@]}" "$N"
printf "Summary: %s\n" "$SUMMARY"
