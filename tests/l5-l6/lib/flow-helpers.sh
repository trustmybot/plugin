#!/usr/bin/env bash
# Shared helpers for L5 row scripts. Source this from tests/l5-l6/run-l5.sh + helpers under tests/l5-l6/lib/.

set -uo pipefail

# shellcheck source=tests/l5-l6/lib/timeout-shim.sh
source "$(dirname "${BASH_SOURCE[0]}")/timeout-shim.sh"

# l5_setup_scratch_project: creates a fresh Docker-isolated scratch dir,
# initializes git, sets test identity. Returns the absolute path on stdout.
l5_setup_scratch_project() {
  local dir
  dir=$(mktemp -d -t tmb-l5-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email l6@l6.test
    git config user.name "L5 Test"
    echo "init" > README.md
    printf '.claude/\n' > .gitignore
    git add . && git commit -qm init
    mkdir -p .claude/tmb
  )
  echo "$dir"
}

# l5_seed_db <project_dir> <fixture_name>: applies a SQL fixture to the
# project's trajectory.db. Fixture must exist at tests/l5-l6/fixtures/<name>.sql.
l5_seed_db() {
  local dir="$1" fixture="$2"
  local fixture_path="$L5_DOGFOOD_DIR/fixtures/${fixture}.sql"
  if [ ! -f "$fixture_path" ]; then
    printf "  ✗ fixture not found: %s\n" "$fixture_path" >&2
    return 1
  fi
  local schema_path="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"
  sqlite3 "$dir/.claude/tmb/trajectory.db" < "$schema_path"
  sqlite3 "$dir/.claude/tmb/trajectory.db" < "$fixture_path"
}

# l5_preserve_trajectory <project_dir> <flow_name> <run_id>: copies
# trajectory.jsonl and trajectory.db to ~/.claude/tmb/l5-trajectories/<flow>/<run_id>/
# before the scratch dir is removed. Always returns 0 (best-effort).
l5_preserve_trajectory() {
  local project="$1" flow="$2" run_id="$3"
  local dest="${HOME}/.claude/tmb/l5-trajectories/${flow}/${run_id}"
  mkdir -p "$dest" 2>/dev/null || return 0
  [ -f "$project/trajectory.jsonl" ] && cp "$project/trajectory.jsonl" "$dest/trajectory.jsonl" 2>/dev/null || true
  [ -f "$project/.claude/tmb/trajectory.db" ] && cp "$project/.claude/tmb/trajectory.db" "$dest/trajectory.db" 2>/dev/null || true
  return 0
}

# l5_run_claude <project_dir> <prompt>: runs claude with stream-json output
# against the prompt in the project, with TMB_DEBUG_TRAJECTORY=1, plugin
# loaded via --plugin-dir. Pipes JSONL to <dir>/trajectory.jsonl; echoes a
# slim summary to stderr for log triage. Always returns 0 so scoring proceeds.
#
# `--dangerously-skip-permissions` is required: in non-interactive `-p` mode
# claude blocks every tool call (Bash, Edit, MCP) until a human approves
# them, and there is no human in the loop here. The scratch dir is a
# fresh mktemp-d, so there's nothing to harm.
# Shared header injected before every test prompt. The "Don't call AUQ"
# instruction is how the harness suppresses AUQ in tests: bro takes the
# documented default instead of asking, so there's no human in the loop to
# answer and no SDK + API-key cost to answer AUQ programmatically. AUQ
# rendering / option labels aren't exercised here — that surface is covered
# by the L1 auq-shape lint.
_l5_test_prompt_prefix() {
  cat <<'EOF'
[TEST MODE] Do not call AskUserQuestion. Apply documented defaults from skills/CLAUDE.md and continue; when a skill's documented behavior is to hold for the Human (e.g. concerns-protocol Path A), recording the note and holding IS the documented default — do not push past it. The Human is not in the loop here. TEST MODE does NOT bypass routing hints from PreToolUse / UserPromptSubmit hooks — when a hook injects a `[tmb consultant-spawn enforcement]` or similar enforcement context, follow it exactly as you would in production. The ceremony (e.g. `/tmb:agent-create`) is the test purpose.

EOF
}

# _l5_write_pre_run_git_snapshot <project_dir>: snapshot pre-run git state so
# the git scorer can detect "bro committed to base" without conflating it with
# setup-time commits the flow's run.sh made before this point.
_l5_write_pre_run_git_snapshot() {
  local dir="$1"
  if git -C "$dir" rev-parse HEAD >/dev/null 2>&1; then
    local pre_head pre_branch
    pre_head=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo "")
    pre_branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    mkdir -p "$dir/.claude/tmb"
    printf '{"head":"%s","branch":"%s"}\n' "$pre_head" "$pre_branch" \
      > "$dir/.claude/tmb/_l5_pre_run_git.json"
  fi
}

l5_run_claude() {
  local dir="$1" prompt="$2"
  local jsonl="$dir/trajectory.jsonl"
  local full_prompt
  full_prompt="$(_l5_test_prompt_prefix)$prompt"

  _l5_write_pre_run_git_snapshot "$dir"

  (
    cd "$dir" || exit 1
    export TMB_DEBUG_TRAJECTORY=1
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
    echo "  ── claude invocation start ──" >&2
    echo "  cwd: $dir" >&2
    echo "  plugin-dir: $PLUGIN_ROOT" >&2
    echo "  prompt: $prompt" >&2
    echo "  jsonl: $jsonl" >&2
    _l5_timeout "${TMB_CLAUDE_TIMEOUT:-600}" claude \
      --plugin-dir "$PLUGIN_ROOT" \
      --dangerously-skip-permissions \
      --output-format stream-json \
      --include-hook-events \
      --include-partial-messages \
      --verbose \
      -p "$full_prompt" \
      > "$jsonl" 2>/tmp/tmb-claude-stderr.$$ || true
    [ -s /tmp/tmb-claude-stderr.$$ ] && sed 's/^/  [claude-err] /' /tmp/tmb-claude-stderr.$$ >&2
    rm -f /tmp/tmb-claude-stderr.$$
    local assistant_msgs duration_ms
    assistant_msgs=$(grep -c '"type":"assistant"' "$jsonl" 2>/dev/null || echo 0)
    duration_ms=$(jq -s 'map(select(.type=="result") | .duration_ms // 0) | max // 0' "$jsonl" 2>/dev/null || echo 0)
    echo "  ── claude invocation end (assistant_msgs=$assistant_msgs, duration_ms=$duration_ms) ──" >&2
    if [ -n "${FLOW_NAME:-}" ] && [ -n "${RUN_ID:-}" ]; then
      l5_preserve_trajectory "$dir" "$FLOW_NAME" "$RUN_ID"
    fi
  )
}

# l5_score_flow <project_dir> <flow_name> <scorer_dir> <run_id>: runs all
# v2 scorers against the project's trajectory DB. Returns 0 only if every
# scorer that's mandated for the flow passes. Issue #110.
#
# Scorers (per industry-standard Inspect AI / AgentEvals pattern):
#   1. outcome              — primary; SQL assertions on final DB state
#   2. trajectory_required  — required tools were called (any order)
#   3. trajectory_forbidden — forbidden tools were NOT called
#   4. cost                 — observational unless cost-budget says fail_above_max
#   5. files                — filesystem assertions (opt-in via outcome-files.json)
#   6. coherence            — table-shape invariants (opt-in via outcome-coherence.json) — catches empty-table doctrine violations
#   7. git                  — git-state invariants (opt-in via outcome-git.json) — catches base-branch contamination + worktree-on-wrong-branch
#   8. usage                — skill/plugin usage from the stream-json run log (opt-in via outcome-usage.json) — replaces skill_invocations (#118/#119)
#   9. materialized         — on-disk consuming-agent materialization (opt-in via outcome-materialized.json) — proves a targeted cheatcode install copied the agent md + skill header (#95)
l5_score_flow() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local total_fail=0

  l5_score_outcome              "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_trajectory_required  "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_trajectory_forbidden "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_cost                 "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_files                "$scorer_dir" "$project"                   || total_fail=$((total_fail + 1))
  l5_score_coherence            "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_git                  "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_usage                "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_materialized         "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))

  return "$total_fail"
}

# l5_cleanup_project <project_dir>: removes the scratch directory.
# When L5_KEEP_ARTIFACTS=1, becomes a no-op so the workflow's
# upload-artifact step can collect the trajectory DB after a failure.
l5_cleanup_project() {
  local dir="$1"
  [ "${L5_KEEP_ARTIFACTS:-0}" = "1" ] && return 0
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}

# Initialize globals used by helpers.
L5_DOGFOOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export L5_DOGFOOD_DIR

# Source v2 scorers (issue #110).
# shellcheck source=tests/l5-l6/lib/scorers.sh
. "$L5_DOGFOOD_DIR/lib/scorers.sh"
