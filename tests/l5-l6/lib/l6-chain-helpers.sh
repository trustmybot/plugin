#!/usr/bin/env bash
# L6 chain runner helpers. The chain walks all 15 journey rows sequentially
# against ONE cumulative trajectory DB. Each row fires a fresh `claude -p`
# invocation — continuity is DB-driven, not LLM-session-driven. Bro's
# tmb_recovery + state-aware MCPs (issue_state_get, task_first_actionable)
# pick up from the DB on every cold start. See
# tests/l5-l6/l6-chain/chain-manifest.json for the row order + between-row
# seeds, and tests/EVALUATION.md for the journey spec.

set -uo pipefail

L6C_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/l5-l6/lib/flow-helpers.sh
. "$L6C_LIB_DIR/flow-helpers.sh"
# shellcheck source=tests/l5-l6/lib/scorers.sh
. "$L6C_LIB_DIR/scorers.sh"
# shellcheck source=tests/l5-l6/lib/timeout-shim.sh
. "$L6C_LIB_DIR/timeout-shim.sh"

# l6c_resolve_runs_root <plugin_root>: where chain runs land — L6C_RUNS_DIR
# when set, else <project>/.claude/<plugin>/l6-chain-runs (tmb_test_state_dir).
l6c_resolve_runs_root() {
  local state
  if [ -n "${L6C_RUNS_DIR:-}" ]; then
    printf '%s\n' "$L6C_RUNS_DIR"
    return 0
  fi
  state=$(tmb_test_state_dir "$1") || return 1
  printf '%s/l6-chain-runs\n' "$state"
}

# l6c_isolate_home <run_dir>: point HOME at <run_dir>/home (mode 0700) for the
# rest of the chain. What the steps used to find under the real HOME stays
# reachable through env: the embedding model cache (TMB_MODEL_CACHE_DIR,
# HF_HOME, TRANSFORMERS_CACHE) when one exists, and mise's installs and config
# when mise is in use. bun and mise caches/state go to <run_dir>/tool-state.
# CLAUDE_CODE_OAUTH_TOKEN is already env.
l6c_isolate_home() {
  local run_dir="$1"
  local real_home="$HOME"
  local tools="$run_dir/tool-state"
  local cache="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-}}"
  if [ -z "$cache" ] && [ -d "$real_home/.cache/huggingface" ]; then
    cache="$real_home/.cache/huggingface"
  fi
  if [ -n "$cache" ]; then
    export TMB_MODEL_CACHE_DIR="$cache"
    export HF_HOME="${HF_HOME:-$cache}" TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$cache}"
  fi
  export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$tools/bun-install-cache}"
  export BUN_RUNTIME_TRANSPILER_CACHE_PATH="${BUN_RUNTIME_TRANSPILER_CACHE_PATH:-$tools/bun-transpiler-cache}"
  export MISE_STATE_DIR="${MISE_STATE_DIR:-$tools/mise-state}" MISE_CACHE_DIR="${MISE_CACHE_DIR:-$tools/mise-cache}"
  if [ -z "${MISE_DATA_DIR:-}" ] && [ -d "$real_home/.local/share/mise" ]; then
    export MISE_DATA_DIR="$real_home/.local/share/mise"
  fi
  if [ -z "${MISE_CONFIG_DIR:-}" ] && [ -d "$real_home/.config/mise" ]; then
    export MISE_CONFIG_DIR="$real_home/.config/mise"
  fi
  mkdir -p "$run_dir"
  mkdir -m 0700 "$run_dir/home" 2>/dev/null || chmod 0700 "$run_dir/home"
  export HOME="$run_dir/home"
}

# l6c_assert_home_clean <home>: 0 when <home> holds nothing but
# .cache/huggingface; otherwise prints every other entry and returns 1.
l6c_assert_home_clean() {
  local home="$1" leaks
  [ -d "$home" ] || return 0
  leaks=$(find "$home" -mindepth 1 \( -path "$home/.cache/huggingface" -prune \) -o \( -path "$home/.cache" \) -o -print 2>/dev/null)
  [ -z "$leaks" ] && return 0
  printf '❌ the chain wrote under its isolated HOME %s — only .cache/huggingface may appear there:\n' "$home" >&2
  printf '%s\n' "$leaks" | awk -v h="$home" '{ if (index($0, h) == 1) $0 = "  $HOME" substr($0, length(h) + 1); print }' >&2
  return 1
}

# l6c_launch_step <runner> <project> <row_dir> <out_jsonl>: run one step
# through <runner> (l6c_run_step, or a stub in --self-test) inside the
# per-step sandbox.
l6c_launch_step() {
  local runner="$1"
  shift
  tmb_test_sandbox_init "$1"
  "$runner" "$@"
  tmb_test_sandbox_teardown
}

# l6c_trajectory_doctor <db> <report_file>
# Checks the run's trajectory DB against its data contracts
# (scripts/maintenance/trajectory-doctor.sh) and writes the JSON report to
# <report_file>. Returns 0 when healthy; otherwise prints the report and
# returns non-zero — an error-severity violation fails the run.
l6c_trajectory_doctor() {
  local db="$1" report="$2" rc=0
  bash "$L6C_LIB_DIR/../../../scripts/maintenance/trajectory-doctor.sh" --db "$db" > "$report" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "  ✗ trajectory_doctor: %s is unhealthy (exit %s)\n" "$db" "$rc"
    sed 's/^/    /' "$report"
  fi
  return "$rc"
}

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

  : > "$out_jsonl"

  local turn=1
  local current_msg
  current_msg="$(l5_compose_test_prompt "$(cat "$prompt_file")")"

  while [ "$turn" -le "$max_turns" ]; do
    local turn_jsonl="${out_jsonl}.turn${turn}"

    (
      cd "$project" || exit 1
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
      if echo "$bro_text" | grep -E "$terminal_pattern" >/dev/null; then
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
  l5_score_usage                "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))
  l5_score_materialized         "$project" "$step" "$row_dir" "$run_id" || fails=$((fails + 1))

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
