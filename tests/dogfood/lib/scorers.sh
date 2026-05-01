#!/usr/bin/env bash
# L5 v2 scorers (issue #110). Each function takes a project_dir + flow name +
# (optional) scorer config path, returns 0 on pass / non-zero on fail, and
# writes one row to the eval_results table.
#
# Industry-standard pattern (Inspect AI / AgentEvals): a Task is graded by
# multiple scorers. Outcome is primary; trajectory subset/superset are
# secondary structural checks; cost is observability.
#
# Sources:
#   https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
#   https://docs.langchain.com/langsmith/trajectory-evals
#   https://inspect.aisi.org.uk/scorers.html

set -uo pipefail

# l5_record_score <db_path> <run_id> <flow> <scorer> <pass:0|1> <value> <explanation>
l5_record_score() {
  local db="$1" run_id="$2" flow="$3" scorer="$4" pass="$5" value="$6" explanation="$7"
  sqlite3 "$db" <<SQL 2>/dev/null || true
INSERT INTO eval_results (run_id, flow_name, scorer_name, pass, value, explanation, created_at)
VALUES (
  '$run_id',
  '$flow',
  '$scorer',
  $pass,
  $(if [ -z "$value" ]; then echo "NULL"; else echo "'$value'"; fi),
  $(if [ -z "$explanation" ]; then echo "NULL"; else echo "'${explanation//\'/\'\'}'"; fi),
  datetime('now')
);
SQL
}

# l5_score_outcome <project_dir> <flow> <scorer_dir> <run_id>
# Runs scorer_dir/outcome.sql against the project DB. Each row returned must
# have a 'pass' column (1 or 0); all rows must pass for the scorer to pass.
# Each row may also have an 'explanation' column.
l5_score_outcome() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local sql_path="$scorer_dir/outcome.sql"

  if [ ! -f "$sql_path" ]; then
    echo "  ⊘ outcome scorer skipped: $sql_path not found"
    l5_record_score "$db" "$run_id" "$flow" "outcome" 1 "" "no-config"
    return 0
  fi

  # Run the SQL; expect rows of form: pass(0|1)|description
  local results
  results=$(sqlite3 -separator '|' "$db" < "$sql_path" 2>&1)
  if [ -z "$results" ]; then
    echo "  ✗ outcome scorer: SQL returned no rows (expected ≥1 assertion)"
    l5_record_score "$db" "$run_id" "$flow" "outcome" 0 "no-rows" "outcome.sql produced no assertion rows"
    return 1
  fi

  local total=0 passed=0 failed_descs=""
  while IFS='|' read -r pass desc; do
    total=$((total + 1))
    if [ "$pass" = "1" ]; then
      passed=$((passed + 1))
    else
      failed_descs="${failed_descs}; ${desc:-(no description)}"
    fi
  done <<< "$results"

  if [ "$passed" -eq "$total" ] && [ "$total" -gt 0 ]; then
    echo "  ✓ outcome: $passed/$total assertions passed"
    l5_record_score "$db" "$run_id" "$flow" "outcome" 1 "${passed}/${total}" "all assertions passed"
    return 0
  else
    echo "  ✗ outcome: $passed/$total assertions passed; failed: $failed_descs" >&2
    l5_record_score "$db" "$run_id" "$flow" "outcome" 0 "${passed}/${total}" "$failed_descs"
    return 1
  fi
}

# l5_score_trajectory_required <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/tools-required.json (a JSON array of tool/MCP names).
# Asserts every listed tool was called at least once (superset semantics
# per LangSmith docs). Order-agnostic. Reads tool_use names from trajectory.jsonl.
l5_score_trajectory_required() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local jsonl="$project/trajectory.jsonl"
  local req_path="$scorer_dir/tools-required.json"

  if [ ! -f "$req_path" ]; then
    return 0
  fi
  if [ ! -f "$jsonl" ]; then
    echo "  ✗ trajectory_required: $jsonl not found (run_arm must produce stream-json)" >&2
    l5_record_score "$db" "$run_id" "$flow" "trajectory_required" 0 "no-jsonl" "trajectory.jsonl missing"
    return 1
  fi

  local tools_called
  tools_called=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$jsonl" 2>/dev/null | sort -u)

  local required missing=""
  required=$(jq -r '.[]' "$req_path")

  while IFS= read -r tool; do
    [ -z "$tool" ] && continue
    if ! echo "$tools_called" | grep -qFx "$tool"; then
      missing="${missing}; $tool"
    fi
  done <<< "$required"

  if [ -z "$missing" ]; then
    echo "  ✓ trajectory_required: all required tools called"
    l5_record_score "$db" "$run_id" "$flow" "trajectory_required" 1 "" "all required tools present"
    return 0
  else
    echo "  ✗ trajectory_required: missing tools: $missing" >&2
    l5_record_score "$db" "$run_id" "$flow" "trajectory_required" 0 "missing" "$missing"
    return 1
  fi
}

# l5_score_trajectory_forbidden <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/tools-forbidden.json. Asserts none of the listed tools
# were called (subset/safety check). Reads tool_use names from trajectory.jsonl.
l5_score_trajectory_forbidden() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local jsonl="$project/trajectory.jsonl"
  local forb_path="$scorer_dir/tools-forbidden.json"

  if [ ! -f "$forb_path" ]; then
    return 0
  fi
  if [ ! -f "$jsonl" ]; then
    echo "  ✗ trajectory_forbidden: $jsonl not found" >&2
    l5_record_score "$db" "$run_id" "$flow" "trajectory_forbidden" 0 "no-jsonl" "trajectory.jsonl missing"
    return 1
  fi

  local tools_called
  tools_called=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$jsonl" 2>/dev/null | sort -u)

  local forbidden violation=""
  forbidden=$(jq -r '.[]' "$forb_path")

  while IFS= read -r tool; do
    [ -z "$tool" ] && continue
    if echo "$tools_called" | grep -qFx "$tool"; then
      violation="${violation}; $tool"
    fi
  done <<< "$forbidden"

  if [ -z "$violation" ]; then
    echo "  ✓ trajectory_forbidden: no forbidden tools called"
    l5_record_score "$db" "$run_id" "$flow" "trajectory_forbidden" 1 "" "no forbidden tools present"
    return 0
  else
    echo "  ✗ trajectory_forbidden: forbidden tools called: $violation" >&2
    l5_record_score "$db" "$run_id" "$flow" "trajectory_forbidden" 0 "violation" "$violation"
    return 1
  fi
}

# l5_score_cost <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/cost-budget.json with {max_tokens_total, max_duration_ms,
# fail_above_max}. Reports tokens + duration from trajectory.jsonl (stream-json);
# fails only if hard cap exceeded AND fail_above_max=true.
l5_score_cost() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local jsonl="$project/trajectory.jsonl"
  local budget_path="$scorer_dir/cost-budget.json"

  local total_in total_out total_tokens duration_ms
  if [ -f "$jsonl" ]; then
    total_in=$(jq -s 'map(select(.type=="assistant") | .message.usage.input_tokens // 0) | add // 0' "$jsonl" 2>/dev/null || echo 0)
    total_out=$(jq -s 'map(select(.type=="assistant") | .message.usage.output_tokens // 0) | add // 0' "$jsonl" 2>/dev/null || echo 0)
    duration_ms=$(jq -s 'map(select(.type=="result") | .duration_ms // 0) | max // 0' "$jsonl" 2>/dev/null || echo 0)
  else
    total_in=0; total_out=0; duration_ms=0
  fi
  total_tokens=$((total_in + total_out))

  local explanation="tokens_total=$total_tokens (in=$total_in out=$total_out) duration_ms=$duration_ms"

  if [ ! -f "$budget_path" ]; then
    echo "  ⊘ cost (observational): $explanation"
    l5_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation"
    return 0
  fi

  local max_tokens max_latency fail_above
  max_tokens=$(jq -r '.max_tokens_total // 0' "$budget_path")
  max_latency=$(jq -r '.max_duration_ms // 0' "$budget_path")
  fail_above=$(jq -r '.fail_above_max // false' "$budget_path")

  local violation=""
  if [ "$max_tokens" != "0" ] && [ "$total_tokens" -gt "$max_tokens" ]; then
    violation="${violation}; tokens($total_tokens > $max_tokens)"
  fi
  if [ "$max_latency" != "0" ] && [ "$duration_ms" -gt "$max_latency" ]; then
    violation="${violation}; duration_ms($duration_ms > $max_latency)"
  fi

  if [ -z "$violation" ]; then
    echo "  ✓ cost: within budget — $explanation"
    l5_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation"
    return 0
  fi

  if [ "$fail_above" = "true" ]; then
    echo "  ✗ cost: budget exceeded$violation" >&2
    l5_record_score "$db" "$run_id" "$flow" "cost" 0 "$total_tokens" "$explanation $violation"
    return 1
  else
    echo "  ⚠ cost: soft-warn budget exceeded$violation"
    l5_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation $violation (soft)"
    return 0
  fi
}
