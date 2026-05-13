#!/usr/bin/env bash
# L7 Bench runner (#6) — TMB-on vs raw Claude on the same agentic-SWE tasks.
# Three orthogonal scoring axes: problem-solving, token-saving, quality.
#
# Usage:
#   bash tests/dogfood/bench/run-bench.sh <task-name>     # one task
#   bash tests/dogfood/bench/run-bench.sh --all           # every task in tasks/
#   N=3 bash tests/dogfood/bench/run-bench.sh --all       # N runs per (task, arm)
#
# See tests/dogfood/bench/README.md for full design + cost ceiling.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
export PLUGIN_ROOT

# shellcheck source=tests/dogfood/bench/lib/bench-helpers.sh
. "$HERE/lib/bench-helpers.sh"

N="${N:-1}"
TASKS_DIR="$HERE/tasks"
RUNS_ROOT="${TMB_BENCH_RUNS_DIR:-$HOME/.claude/tmb/bench-runs}"

# Resolve task arg + help-text path before auth check so users get usage
# without needing credentials.
TASK_ARG="${1:-}"
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

RESULTS_JSONL="$RUN_DIR/_results.jsonl"
: > "$RESULTS_JSONL"

printf '=== L7 bench %s ===\n' "$RUN_ID"
printf '  tasks:   %s\n' "${TASKS[*]}"
printf '  arms:    tmb-on, raw\n'
printf '  N:       %d per (task, arm)\n' "$N"
printf '  logs:    %s\n\n' "$RUN_DIR"

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
  bench_run_arm "$arm" "$project" "$prompt" "$transcript" || true

  # 3. Capture trajectory.db (arm A only) for post-mortem.
  local db
  db=$(bench_resolve_db "$project")
  if [ -n "$db" ]; then
    cp "$db" "$out_dir/trajectory.db" 2>/dev/null || true
  fi

  # 4. Score the three axes.
  local probsol token quality
  probsol=$("$HERE/scorers/problem-solving.sh" "$task_dir" "$project" 2>/dev/null || echo '{"axis":"problem_solving","pass":0}')
  token=$("$HERE/scorers/token-saving.sh" "$transcript" "$out_dir/trajectory.db" 2>/dev/null || echo '{"axis":"token_saving","total_tokens":0}')
  quality=$("$HERE/scorers/quality.sh" "$project" "$out_dir/trajectory.db" 2>/dev/null || echo '{"axis":"quality","score":0}')

  # 5. Persist scores + emit run record.
  jq -nc \
    --arg task "$task" --arg arm "$arm" --argjson run "$run_idx" \
    --argjson ps "$probsol" --argjson tk "$token" --argjson ql "$quality" \
    '{task: $task, arm: $arm, run: $run,
      problem_solving: $ps.pass,
      tokens: $tk.total_tokens,
      quality_score: $ql.score,
      problem_solving_detail: $ps,
      token_detail: $tk,
      quality_detail: $ql}' \
    | tee -a "$RESULTS_JSONL" > "$out_dir/scores.json"

  local ps_pass tk_total ql_score
  ps_pass=$(jq -r '.pass' <<< "$probsol")
  tk_total=$(jq -r '.total_tokens' <<< "$token")
  ql_score=$(jq -r '.score' <<< "$quality")
  printf '    → problem_solving=%s  tokens=%s  quality=%s/5\n' \
    "$ps_pass" "$tk_total" "$ql_score"
}

for task in "${TASKS[@]}"; do
  printf "── %s ──\n" "$task"
  for arm in tmb-on raw; do
    for run_idx in $(seq 1 "$N"); do
      run_one "$task" "$arm" "$run_idx"
    done
  done
  printf "\n"
done

# Emit summary table.
SUMMARY="$RUN_DIR/summary.md"
{
  printf "# L7 bench summary — %s\n\n" "$RUN_ID"
  printf "| Task | Arm | Run | Solved | Tokens | Quality |\n"
  printf "|---|---|---|---|---|---|\n"
  jq -r '"| " + .task + " | " + .arm + " | " + (.run|tostring)
         + " | " + (if .problem_solving == 1 then "✅" else "❌" end)
         + " | " + (.tokens|tostring)
         + " | " + (.quality_score|tostring) + "/5 |"' "$RESULTS_JSONL"
  printf "\n## Per-axis arm comparison (means)\n\n"
  printf "| Axis | tmb-on | raw | Δ (tmb-on − raw) |\n"
  printf "|---|---|---|---|\n"
  for axis in problem_solving tokens quality_score; do
    tmb=$(jq -s "map(select(.arm == \"tmb-on\") | .${axis}) | add / length // 0" "$RESULTS_JSONL")
    raw=$(jq -s "map(select(.arm == \"raw\")    | .${axis}) | add / length // 0" "$RESULTS_JSONL")
    delta=$(awk -v a="$tmb" -v b="$raw" 'BEGIN{printf "%.2f", a-b}')
    printf "| %s | %s | %s | %s |\n" "$axis" "$tmb" "$raw" "$delta"
  done
} > "$SUMMARY"

printf "\n========================================\n"
printf "Bench complete: %d tasks × 2 arms × N=%d\n" "${#TASKS[@]}" "$N"
printf "Summary: %s\n" "$SUMMARY"
