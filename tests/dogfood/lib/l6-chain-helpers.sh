#!/usr/bin/env bash
# L6 chain runner helpers. The chain walks all 13 journey rows sequentially
# against ONE cumulative trajectory DB. Each row fires a fresh `claude -p`
# invocation — continuity is DB-driven, not LLM-session-driven. Bro's
# tmb_recovery + state-aware MCPs (issue_state_get, task_first_actionable)
# pick up from the DB on every cold start. See
# tests/dogfood/l6-chain/chain-manifest.json for the row order + between-row
# seeds, and tests/EVALUATION.md for the journey spec.

set -uo pipefail

L6C_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/dogfood/lib/flow-helpers.sh
. "$L6C_LIB_DIR/flow-helpers.sh"
# shellcheck source=tests/dogfood/lib/scorers.sh
. "$L6C_LIB_DIR/scorers.sh"
# shellcheck source=tests/dogfood/lib/timeout-shim.sh
. "$L6C_LIB_DIR/timeout-shim.sh"

# l6c_uuid: emit a UUID for --session-id. Falls back to /dev/urandom hex if
# `uuidgen` is missing (CI minimal images).
l6c_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    od -x -A n -N 16 /dev/urandom | tr -d ' \n' \
      | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/'
  fi
}

# l6c_snapshot_db <project> <out_file>: dump the trajectory DB as SQL text.
l6c_snapshot_db() {
  local project="$1" out="$2"
  sqlite3 "$project/.claude/tmb/trajectory.db" .dump > "$out" 2>/dev/null || {
    echo "-- snapshot failed: trajectory.db missing or unreadable" > "$out"
  }
}

# l6c_apply_seed <project> <seed_path>: run a SQL seed against the DB if the
# file exists. Tolerates missing files (returns 0).
l6c_apply_seed() {
  local project="$1" seed="$2"
  [ -z "$seed" ] && return 0
  [ "$seed" = "null" ] && return 0
  if [ ! -f "$seed" ]; then
    printf "  ⚠ seed not found, skipping: %s\n" "$seed" >&2
    return 0
  fi
  sqlite3 "$project/.claude/tmb/trajectory.db" < "$seed"
}

# l6c_run_step <project> <row_dir> <out_jsonl>
# Runs ONE chain step. Within a step the row's script.json drives a
# multi-turn conversation (turn 1 = prompt.txt; subsequent turns from
# user_after_bro[]) via a step-local --session-id / --resume. BETWEEN
# steps fresh session — continuity carries via the cumulative trajectory
# DB only, mirroring real cross-session resume.
l6c_run_step() {
  local project="$1" row_dir="$2" out_jsonl="$3"
  local prompt_file="$row_dir/prompt.txt"
  local script="$row_dir/script.json"

  local max_turns user_replies terminal_pattern
  if [ -f "$script" ]; then
    max_turns=$(jq -r '.max_turns // 1' "$script")
    user_replies=$(jq -c '.user_after_bro // []' "$script")
    terminal_pattern=$(jq -r '.terminal_pattern // ""' "$script")
  else
    max_turns=1
    user_replies='[]'
    terminal_pattern=""
  fi

  local session_id
  session_id=$(l6c_uuid)
  : > "$out_jsonl"

  local turn=1
  local current_msg
  current_msg="$(_l5_test_prompt_prefix)$(cat "$prompt_file")"

  while [ "$turn" -le "$max_turns" ]; do
    local turn_jsonl="${out_jsonl}.turn${turn}"

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

      # Fresh CC session per turn — continuity carries ONLY via the
      # cumulative trajectory.db. No --resume: matches real cross-session
      # behavior (a Human running multiple `claude` commands minutes apart
      # gets a fresh session each time; only the DB persists). --session-id
      # still pinned per turn so logs are addressable, but each turn ID is
      # unique (no resume).
      local per_turn_session_id
      per_turn_session_id=$(l6c_uuid)
      cc_args=(--session-id "$per_turn_session_id" "${cc_args[@]}")

      _l5_timeout "${TMB_CLAUDE_TIMEOUT:-600}" claude "${cc_args[@]}" \
        > "$turn_jsonl" 2>/tmp/tmb-l6c-stderr.$$ || true
      [ -s /tmp/tmb-l6c-stderr.$$ ] && sed 's/^/  [claude-err] /' /tmp/tmb-l6c-stderr.$$ >&2
      rm -f /tmp/tmb-l6c-stderr.$$
    )

    cat "$turn_jsonl" >> "$out_jsonl"

    # Pull bro's last text response.
    local bro_text
    bro_text=$(jq -r '
      select(.type == "assistant") |
      .message.content[] |
      select(.type == "text") |
      .text
    ' "$turn_jsonl" 2>/dev/null | tail -c 4000)

    # Terminal-pattern early-exit.
    if [ -n "$terminal_pattern" ] && [ -n "$bro_text" ]; then
      if echo "$bro_text" | grep -qE "$terminal_pattern"; then
        rm -f "$turn_jsonl"
        break
      fi
    fi

    # Next user reply from script queue. Empty = done.
    local next_msg
    next_msg=$(echo "$user_replies" | jq -r ".[$((turn - 1))] // empty")
    rm -f "$turn_jsonl"
    if [ -z "$next_msg" ]; then
      break
    fi
    current_msg="$next_msg"
    turn=$((turn + 1))
  done
}

# l6c_score_step <project> <step_name> <row_dir> <run_id>: run every scorer
# for one chain step against the cumulative DB + master trajectory.jsonl.
# Returns the total failure count.
l6c_score_step() {
  local project="$1" step="$2" row_dir="$3" run_id="$4"
  local fails=0

  l5_score_outcome              "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_trajectory_required  "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_trajectory_forbidden "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_cost                 "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_files                "$row_dir" "$project"                   || fails=$((fails + 1))
  l5_score_coherence            "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_git                  "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))

  return "$fails"
}

# l6c_write_chain_summary <run_dir> <results_jsonl>: render the chain-summary
# markdown table from per-step result lines (one JSON object per row in
# `results_jsonl`).
l6c_write_chain_summary() {
  local run_dir="$1" results="$2"
  local out="$run_dir/chain-summary.md"
  {
    printf '# L6 chain summary — %s\n\n' "$(basename "$run_dir")"
    printf '| #  | Row | Status | Scorer fails | Tokens | Duration (ms) | Notes |\n'
    printf '|----|-----|--------|--------------|--------|----------------|-------|\n'
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local id name status fails tokens duration notes
      id=$(echo       "$line" | jq -r '.id')
      name=$(echo     "$line" | jq -r '.name')
      status=$(echo   "$line" | jq -r '.status')
      fails=$(echo    "$line" | jq -r '.scorer_fails')
      tokens=$(echo   "$line" | jq -r '.tokens')
      duration=$(echo "$line" | jq -r '.duration_ms')
      notes=$(echo    "$line" | jq -r '.notes // ""')
      printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
        "$id" "$name" "$status" "$fails" "$tokens" "$duration" "$notes"
    done < "$results"
  } > "$out"
}
