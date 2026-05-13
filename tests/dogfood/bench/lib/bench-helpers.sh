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
bench_run_arm() {
  local arm="$1" project="$2" prompt="$3" transcript_path="$4"
  : > "$transcript_path"
  local args=(
    -p
    --output-format stream-json
    --verbose
    --dangerously-skip-permissions
    --max-turns 30
  )
  if [ "$arm" = "tmb-on" ]; then
    args+=(--plugin-dir "$PLUGIN_ROOT")
  fi
  # Run claude inside the project so any project-local state is visible.
  (
    cd "$project" || exit 1
    printf "%s\n" "$prompt" | claude "${args[@]}" 2>>"$transcript_path.stderr" \
      >> "$transcript_path"
  )
  return $?
}

# bench_tokens_from_transcript <transcript_path>: sum tokens across the
# stream-json output. Each `type=result` event carries `total_tokens` for
# the turn; we sum every one. Handles missing/zero fields gracefully.
# Echoes a single integer on stdout.
bench_tokens_from_transcript() {
  local transcript_path="$1"
  [ -f "$transcript_path" ] || { echo 0; return 0; }
  jq -s '
    [.[] | select(.type == "result") | .total_tokens // 0]
      | add // 0
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
