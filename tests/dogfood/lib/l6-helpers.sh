#!/usr/bin/env bash
# L6 integration runner — multi-turn, multi-flow continuous session helpers.
# Reuses L5's flow-helpers (setup, scorers, trajectory preservation); adds a
# turn loop on top via Claude Code's --session-id / --resume.
#
# Architecture:
#   l6_setup_scratch_project   — same as l5_setup_scratch_project
#   l6_seed_db                 — same as l5_seed_db
#   l6_run_session             — multi-turn loop driven by scenario_dir/script.json
#   l6_score_session           — runs all 7 scorers at terminal against the
#                                 cumulative DB + master trajectory.jsonl
#
# Per-row layout (per-row L5 unit also runs as L6 chain step):
#   tests/dogfood/l5-rows/<name>/
#     script.json              — turn list + terminal condition + max_turns
#     prompt.txt               — initial user message (turn 1)
#     outcome.sql              — final-state SQL assertions
#     outcome-coherence.json   — table-shape assertions
#     outcome-git.json         — git-state assertions
#     tools-required.json      — MCP tools that MUST appear across all turns
#     tools-forbidden.json     — MCP tools that MUST NOT appear
#     cost-budget.json         — cumulative token + duration budget
#     fixture.txt              — name of the SQL fixture to seed (e.g. "empty")
#     README.md                — what journey this exercises

set -uo pipefail

# Reuse L5 helpers — they're agnostic about single-shot vs multi-turn.
# scorers.sh + flow-helpers.sh provide l5_setup_scratch_project, l5_seed_db,
# l5_score_outcome / coherence / git / files / trajectory / cost,
# l5_preserve_trajectory, l5_cleanup_project.
L6_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$L6_LIB_DIR/scorers.sh"
. "$L6_LIB_DIR/flow-helpers.sh"
# shellcheck source=tests/dogfood/lib/timeout-shim.sh
. "$L6_LIB_DIR/timeout-shim.sh"

# Aliases — L6 wraps L5's primitives 1:1 for the parts that don't change.
l6_setup_scratch_project() { l5_setup_scratch_project "$@"; }
l6_seed_db()                { l5_seed_db "$@"; }
l6_cleanup_project()        { l5_cleanup_project "$@"; }
l6_preserve_trajectory()    { l5_preserve_trajectory "$@"; }

# l6_run_session <project_dir> <scenario_dir>
# Runs a multi-turn session driven by scenario_dir/script.json. The first
# user message comes from prompt.txt; subsequent user messages come from
# script.json's turns[] array. Captures the cumulative trajectory.jsonl by
# concatenating per-turn outputs.
#
# script.json schema:
# {
#   "max_turns": 6,                              // hard cap; safety
#   "user_after_bro": [                          // queued user replies
#     "Yes proceed with the simplest implementation.",
#     "Looks good. Push it."
#   ],
#   "terminal_pattern": "task closed|push when ready"  // regex; bro's response triggers terminal
# }
#
# Per-turn execution (uses claude --session-id <UUID> on turn 1, --resume on
# subsequent). TMB_HEADLESS=1 stays set — the auq-headless-deny hook still
# fires for AUQ; sim-user provides plain-text replies only. (Real AUQ
# handling is part of issue #2867 — retire the headless fast-path.)
l6_run_session() {
  local project="$1" scenario_dir="$2"
  local jsonl="$project/trajectory.jsonl"
  local script="$scenario_dir/script.json"
  local prompt_file="$scenario_dir/prompt.txt"

  if [ ! -f "$prompt_file" ]; then
    echo "  ✗ l6: prompt.txt missing in $scenario_dir" >&2
    return 1
  fi

  local max_turns user_replies terminal_pattern
  if [ -f "$script" ]; then
    max_turns=$(jq -r '.max_turns // 6' "$script")
    user_replies=$(jq -c '.user_after_bro // []' "$script")
    terminal_pattern=$(jq -r '.terminal_pattern // ""' "$script")
  else
    max_turns=1
    user_replies='[]'
    terminal_pattern=""
  fi

  # Snapshot pre-run git state for the git scorer's base_branch_unchanged check.
  if git -C "$project" rev-parse HEAD >/dev/null 2>&1; then
    local pre_head pre_branch
    pre_head=$(git -C "$project" rev-parse HEAD 2>/dev/null || echo "")
    pre_branch=$(git -C "$project" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    mkdir -p "$project/.claude/tmb"
    printf '{"head":"%s","branch":"%s"}\n' "$pre_head" "$pre_branch" \
      > "$project/.claude/tmb/_l5_pre_run_git.json"
  fi

  local session_id
  session_id=$(_l6_uuid)
  local turn=1
  local current_msg
  # Inject the test-mode header on the FIRST turn only. Subsequent user
  # replies are conversational and don't need the prefix repeated. See
  # _l5_test_prompt_prefix in flow-helpers.sh for rationale.
  current_msg="$(_l5_test_prompt_prefix)$(cat "$prompt_file")"

  : > "$jsonl"   # truncate; we append per turn

  echo "  ── L6 session start (id=$session_id, max_turns=$max_turns) ──" >&2

  while [ "$turn" -le "$max_turns" ]; do
    echo "  ── turn $turn: user → bro ──" >&2
    echo "  msg: ${current_msg:0:120}$([ ${#current_msg} -gt 120 ] && echo '...')" >&2

    local turn_jsonl="$project/.claude/tmb/_l6_turn_${turn}.jsonl"

    (
      cd "$project" || exit 1
      export TMB_HEADLESS=1
      export TMB_DEBUG_TRAJECTORY=1
      export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"

      local cc_args=(
        --plugin-dir "$PLUGIN_ROOT"
        --dangerously-skip-permissions
        --output-format stream-json
        --include-hook-events
        --include-partial-messages
        --verbose
        -p "$current_msg"
      )

      if [ "$turn" = "1" ]; then
        cc_args=(--session-id "$session_id" "${cc_args[@]}")
      else
        cc_args=(--resume "$session_id" "${cc_args[@]}")
      fi

      _l5_timeout "${TMB_CLAUDE_TIMEOUT:-600}" claude "${cc_args[@]}" \
        > "$turn_jsonl" 2>/tmp/tmb-l6-stderr.$$ || true
      [ -s /tmp/tmb-l6-stderr.$$ ] && sed 's/^/  [claude-err] /' /tmp/tmb-l6-stderr.$$ >&2
      rm -f /tmp/tmb-l6-stderr.$$
    )

    # Append turn output to master trajectory.
    cat "$turn_jsonl" >> "$jsonl"

    # Pull bro's last text response (final assistant text block in this turn).
    local bro_text
    bro_text=$(jq -r '
      select(.type == "assistant") |
      .message.content[] |
      select(.type == "text") |
      .text
    ' "$turn_jsonl" 2>/dev/null | tail -c 4000)

    if [ -n "$bro_text" ]; then
      echo "  bro: ${bro_text:0:200}$([ ${#bro_text} -gt 200 ] && echo '...')" >&2
    else
      echo "  bro: (no text response captured this turn)" >&2
    fi

    # Terminal check — does bro's response match the pattern?
    if [ -n "$terminal_pattern" ] && [ -n "$bro_text" ]; then
      if echo "$bro_text" | grep -qE "$terminal_pattern"; then
        echo "  ── terminal pattern matched, ending session ──" >&2
        break
      fi
    fi

    # Pull next user reply from queue. Empty queue = terminal.
    local next_msg
    next_msg=$(echo "$user_replies" | jq -r ".[$((turn - 1))] // empty")
    if [ -z "$next_msg" ]; then
      echo "  ── user_after_bro queue exhausted, ending session ──" >&2
      break
    fi
    current_msg="$next_msg"
    turn=$((turn + 1))
  done

  # Slim summary
  local total_assistant total_duration_ms
  total_assistant=$(grep -c '"type":"assistant"' "$jsonl" 2>/dev/null || echo 0)
  total_duration_ms=$(jq -s 'map(select(.type=="result") | .duration_ms // 0) | add // 0' "$jsonl" 2>/dev/null || echo 0)
  echo "  ── L6 session end (turns=$turn assistant_msgs=$total_assistant total_duration_ms=$total_duration_ms) ──" >&2

  # Preserve trajectory by scenario name + run_id (mirrors L5 convention).
  if [ -n "${SCENARIO_NAME:-}" ] && [ -n "${RUN_ID:-}" ]; then
    l6_preserve_trajectory "$project" "$SCENARIO_NAME" "$RUN_ID"
  fi
}

# l6_score_session <project_dir> <scenario_name> <scenario_dir> <run_id>
# Same scorer set as L5 (outcome / trajectory_required / trajectory_forbidden /
# cost / files / coherence / git). Scoring fires once at end of session
# against cumulative state.
l6_score_session() {
  local project="$1" scenario="$2" scenario_dir="$3" run_id="$4"
  local total_fail=0

  l5_score_outcome              "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_trajectory_required  "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_trajectory_forbidden "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_cost                 "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_files                "$scenario_dir" "$project"                       || total_fail=$((total_fail + 1))
  l5_score_coherence            "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))
  l5_score_git                  "$project" "$scenario" "$scenario_dir" "$run_id" || total_fail=$((total_fail + 1))

  return "$total_fail"
}

# _l6_uuid: emit a UUID for --session-id. Falls back to a deterministic
# date-based pseudo-UUID if `uuidgen` is missing (CI minimal images).
_l6_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    # 8-4-4-4-12 hex pattern, generated from /dev/urandom.
    od -x -A n -N 16 /dev/urandom | tr -d ' \n' | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
  fi
}
