#!/usr/bin/env bash
# Shared helpers for the L7 bench harness (#6). Source from run-bench.sh +
# scorers. Mirrors tests/dogfood/lib/flow-helpers.sh + l6-chain-helpers.sh
# patterns but specialized for the two-arm benchmark structure.

set -uo pipefail

# bench_resolve_db <project_dir>: resolve the trajectory DB path under a
# project dir. Returns the path on stdout; empty if the file doesn't exist.
bench_resolve_db() {
  local project="$1"
  local plugin_name="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    plugin_name=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  local candidate="$project/.claude/$plugin_name/trajectory.db"
  [ -f "$candidate" ] && echo "$candidate" || echo ""
}

# bench_setup_scratch_project: create a fresh scratch dir, init git, set
# test identity. Returns the absolute path on stdout. Mirrors
# l5_setup_scratch_project but lives in the bench namespace.
bench_setup_scratch_project() {
  local dir
  dir=$(mktemp -d -t tmb-bench-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email bench@bench.test
    git config user.name "TMB Bench"
    echo "init" > README.md
    printf '.claude/\n' > .gitignore
    git add . && git commit -qm init
    mkdir -p .claude/tmb
  )
  echo "$dir"
}

# bench_run_arm <arm> <project> <prompt> <transcript_path>: drive one claude -p
# invocation against $project with $prompt. arm='tmb-on' loads the plugin via
# --plugin-dir; arm='raw' runs vanilla claude with no plugin. Captures
# stream-json transcript to $transcript_path. Returns claude's exit code.
#
# If $project/.bench-venv exists (created by setup.sh for SWE-bench tasks),
# its bin/ is prepended to PATH so the agent's `pytest`/`python` resolve to
# the same isolated env that verify.sh will use. This matches SWE-bench's
# per-task Docker image isolation without needing Docker.
bench_run_arm() {
  local arm="$1" project="$2" prompt="$3" transcript_path="$4"
  : > "$transcript_path"
  local args=(
    -p
    --output-format stream-json
    --verbose
    --dangerously-skip-permissions
    --max-turns 50
  )
  # Pin bro's underlying model so we match the published comparator's
  # model version exactly. Default is the May 2025 Claude 4 Opus snapshot
  # — same model Anthropic used for their `20250522_tools_claude-4-opus`
  # SWE-bench Verified submission. Override via TMB_BENCH_MODEL env var.
  local model="${TMB_BENCH_MODEL:-claude-opus-4-20250514}"
  args+=(--model "$model")
  if [ "$arm" = "tmb-on" ]; then
    args+=(--plugin-dir "$PLUGIN_ROOT")
    # Pre-seed the project DB with onboarded state so the tmb-on arm skips
    # onboarding noise/cost and the world-model-cold gate. Reuses the
    # l5_seed_db helper + onboarding-named fixture to avoid schema drift.
    if [ ! -f "$project/.claude/tmb/trajectory.db" ]; then
      # shellcheck source=tests/dogfood/lib/flow-helpers.sh
      source "$PLUGIN_ROOT/tests/dogfood/lib/flow-helpers.sh"
      l5_seed_db "$project" "onboarding-named"
    fi
  fi
  (
    cd "$project" || exit 1
    if [ -d "$project/.bench-venv/bin" ]; then
      export PATH="$project/.bench-venv/bin:$PATH"
    fi
    # TMB_HEADLESS=1: tells tmb_planning + co to use the fast-path recipe
    # (no AskUserQuestion attempts; full task_create_batch → SWE → V1/V2/V3
    # → atomic-close ceremony in headless form). Without this bro hits AUQ
    # rejections and falls back to direct-edit, bypassing the doctrine
    # we're trying to measure. Only set for tmb-on (raw arm has no plugin
    # that reads it).
    if [ "$arm" = "tmb-on" ]; then
      export TMB_HEADLESS=1
    fi
    # TMB_BENCH_ENRICH_PROMPT=1 (opt-in): append the "I will go to sleep…"
    # suffix that matches how a real TMB user invokes bro for overnight
    # autonomous work. This is the "TMB-as-designed" measurement tier —
    # the verbatim problem_statement (no suffix) is the "autonomous"
    # tier that compares fairly against published Sonnet 4 harnesses.
    # See docs/BENCHMARK.md for the two-tier framing.
    local final_prompt="$prompt"
    if [ -n "${TMB_BENCH_PROMPT_PREFIX:-}" ]; then
      final_prompt="${TMB_BENCH_PROMPT_PREFIX}${final_prompt}"
    fi
    if [ "${TMB_BENCH_ENRICH_PROMPT:-0}" = "1" ]; then
      final_prompt="${final_prompt}

I will go to sleep. You solve all of the issues automatically. Don't ask questions."
    fi
    printf "%s\n" "$final_prompt" | claude "${args[@]}" 2>>"$transcript_path.stderr" \
      >> "$transcript_path"
  )
  return $?
}

# bench_tokens_from_transcript <transcript_path>: sum tokens across the
# stream-json output. The terminal `type=result` event carries a `usage`
# block with input_tokens + cache_creation_input_tokens +
# cache_read_input_tokens + output_tokens. Sum all four for the total.
# Echoes a single integer on stdout.
bench_tokens_from_transcript() {
  local transcript_path="$1"
  [ -f "$transcript_path" ] || { echo 0; return 0; }
  jq -s '
    [.[] | select(.type == "result") | .usage // {} |
      ((.input_tokens // 0) +
       (.cache_creation_input_tokens // 0) +
       (.cache_read_input_tokens // 0) +
       (.output_tokens // 0))
    ] | add // 0
  ' "$transcript_path" 2>/dev/null || echo 0
}

# bench_cost_from_transcript <transcript_path>: sum total_cost_usd across
# the stream-json output. Cleaner signal than token count when comparing
# arms — collapses input/output/cache pricing differences.
# Echoes a decimal on stdout (or 0).
bench_cost_from_transcript() {
  local transcript_path="$1"
  [ -f "$transcript_path" ] || { echo 0; return 0; }
  jq -s '
    [.[] | select(.type == "result") | .total_cost_usd // 0] | add // 0
  ' "$transcript_path" 2>/dev/null || echo 0
}

# bench_tokens_from_agent_runs <db_path>: sum tokens_total across all
# agent_runs rows for this session (every row is fresh per arm). Returns
# 0 if the DB doesn't exist (raw arm has no DB).
bench_tokens_from_agent_runs() {
  local db="$1"
  [ -f "$db" ] || { echo 0; return 0; }
  sqlite3 "$db" "SELECT COALESCE(SUM(tokens_total), 0) FROM agent_runs;" 2>/dev/null || echo 0
}

# bench_log <msg>: timestamped log line to stderr.
bench_log() {
  printf '[%s] %s\n' "$(date -u +"%H:%M:%SZ")" "$*" >&2
}
