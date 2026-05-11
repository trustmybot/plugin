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

# l6c_send_turn <project> <unused_session_id> <unused_is_first> <prompt> <turn_jsonl_out>
# Fires one fresh `claude -p` invocation against the project's cumulative
# trajectory DB. No --session-id / --resume — continuity is DB-driven via
# bro's tmb_recovery / state-aware MCPs (issue_state_get,
# task_first_actionable, etc.). That's the *workflow* under test in L6.
#
# Argument 2 and 3 are kept for backwards-compat with the prior signature
# but ignored — see commit history if you need the old session-pinned form.
l6c_send_turn() {
  local project="$1" prompt="$4" out_jsonl="$5"

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
      -p "$prompt"
    )

    _l5_timeout "${TMB_CLAUDE_TIMEOUT:-600}" claude "${cc_args[@]}" \
      > "$out_jsonl" 2>/tmp/tmb-l6c-stderr.$$ || true
    [ -s /tmp/tmb-l6c-stderr.$$ ] && sed 's/^/  [claude-err] /' /tmp/tmb-l6c-stderr.$$ >&2
    rm -f /tmp/tmb-l6c-stderr.$$
  )
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
