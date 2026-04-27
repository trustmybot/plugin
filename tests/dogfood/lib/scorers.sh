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

# l6_record_score <db_path> <run_id> <flow> <scorer> <pass:0|1> <value> <explanation>
l6_record_score() {
  local db="$1" run_id="$2" flow="$3" scorer="$4" pass="$5" value="$6" explanation="$7"
  sqlite3 "$db" <<SQL 2>/dev/null || true
INSERT INTO eval_results (run_id, flow_name, scorer_name, pass, value, explanation, created_at)
VALUES (
  '$run_id',
  '$flow',
  '$scorer',
  $pass,
  $(if [ -z "$value" ]; then echo "NULL"; else echo "'$value'"; fi),
  $(if [ -z "$explanation" ]; then echo "NULL"; else echo "'$(echo "$explanation" | sed "s/'/''/g")'"; fi),
  datetime('now')
);
SQL
}

# l6_score_outcome <project_dir> <flow> <scorer_dir> <run_id>
# Runs scorer_dir/outcome.sql against the project DB. Each row returned must
# have a 'pass' column (1 or 0); all rows must pass for the scorer to pass.
# Each row may also have an 'explanation' column.
l6_score_outcome() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local sql_path="$scorer_dir/outcome.sql"

  if [ ! -f "$sql_path" ]; then
    echo "  ⊘ outcome scorer skipped: $sql_path not found"
    l6_record_score "$db" "$run_id" "$flow" "outcome" 1 "" "no-config"
    return 0
  fi

  # Run the SQL; expect rows of form: pass(0|1)|description
  local results
  results=$(sqlite3 -separator '|' "$db" < "$sql_path" 2>&1)
  if [ -z "$results" ]; then
    echo "  ✗ outcome scorer: SQL returned no rows (expected ≥1 assertion)"
    l6_record_score "$db" "$run_id" "$flow" "outcome" 0 "no-rows" "outcome.sql produced no assertion rows"
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
    l6_record_score "$db" "$run_id" "$flow" "outcome" 1 "${passed}/${total}" "all assertions passed"
    return 0
  else
    echo "  ✗ outcome: $passed/$total assertions passed; failed: $failed_descs" >&2
    l6_record_score "$db" "$run_id" "$flow" "outcome" 0 "${passed}/${total}" "$failed_descs"
    return 1
  fi
}

# l6_score_trajectory_required <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/tools-required.json (a JSON array of tool/MCP names).
# Asserts every listed tool was called at least once (superset semantics
# per LangSmith docs). Order-agnostic.
l6_score_trajectory_required() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local req_path="$scorer_dir/tools-required.json"

  if [ ! -f "$req_path" ]; then
    return 0  # no config = no scorer; not a failure
  fi

  local required missing=""
  required=$(jq -r '.[]' "$req_path")

  while IFS= read -r tool; do
    [ -z "$tool" ] && continue
    local count
    count=$(sqlite3 "$db" "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name = '$tool'" 2>/dev/null || echo 0)
    if [ "$count" = "0" ]; then
      missing="${missing}; $tool"
    fi
  done <<< "$required"

  if [ -z "$missing" ]; then
    echo "  ✓ trajectory_required: all required tools called"
    l6_record_score "$db" "$run_id" "$flow" "trajectory_required" 1 "" "all required tools present"
    return 0
  else
    echo "  ✗ trajectory_required: missing tools: $missing" >&2
    l6_record_score "$db" "$run_id" "$flow" "trajectory_required" 0 "missing" "$missing"
    return 1
  fi
}

# l6_score_trajectory_forbidden <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/tools-forbidden.json. Asserts none of the listed tools
# were called (subset/safety check).
l6_score_trajectory_forbidden() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local forb_path="$scorer_dir/tools-forbidden.json"

  if [ ! -f "$forb_path" ]; then
    return 0
  fi

  local forbidden present=""
  forbidden=$(jq -r '.[]' "$forb_path")

  while IFS= read -r tool; do
    [ -z "$tool" ] && continue
    local count
    count=$(sqlite3 "$db" "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name = '$tool'" 2>/dev/null || echo 0)
    if [ "$count" != "0" ]; then
      present="${present}; ${tool}(${count}x)"
    fi
  done <<< "$forbidden"

  if [ -z "$present" ]; then
    echo "  ✓ trajectory_forbidden: no forbidden tools called"
    l6_record_score "$db" "$run_id" "$flow" "trajectory_forbidden" 1 "" "no forbidden tools present"
    return 0
  else
    echo "  ✗ trajectory_forbidden: forbidden tools called: $present" >&2
    l6_record_score "$db" "$run_id" "$flow" "trajectory_forbidden" 0 "violations" "$present"
    return 1
  fi
}

# l6_score_cost <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/cost-budget.json with {max_tokens_total, max_latency_ms_p99,
# fail_above_max}. Reports tokens + latency from debug_trajectory; fails only
# if hard cap exceeded AND fail_above_max=true.
l6_score_cost() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local budget_path="$scorer_dir/cost-budget.json"

  local total_in total_out total_tokens p99_latency
  total_in=$(sqlite3 "$db" "SELECT COALESCE(SUM(tokens_in), 0) FROM debug_trajectory" 2>/dev/null || echo 0)
  total_out=$(sqlite3 "$db" "SELECT COALESCE(SUM(tokens_out), 0) FROM debug_trajectory" 2>/dev/null || echo 0)
  total_tokens=$((total_in + total_out))
  # Approximate p99 as max for small N; the trajectory rarely has >100 rows.
  p99_latency=$(sqlite3 "$db" "SELECT COALESCE(MAX(latency_ms), 0) FROM debug_trajectory" 2>/dev/null || echo 0)

  local explanation="tokens_total=$total_tokens (in=$total_in out=$total_out) p99_latency_ms=$p99_latency"

  if [ ! -f "$budget_path" ]; then
    # No budget config — purely observational.
    echo "  ⊘ cost (observational): $explanation"
    l6_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation"
    return 0
  fi

  local max_tokens max_latency fail_above
  max_tokens=$(jq -r '.max_tokens_total // 0' "$budget_path")
  max_latency=$(jq -r '.max_latency_ms_p99 // 0' "$budget_path")
  fail_above=$(jq -r '.fail_above_max // false' "$budget_path")

  local violation=""
  if [ "$max_tokens" != "0" ] && [ "$total_tokens" -gt "$max_tokens" ]; then
    violation="${violation}; tokens($total_tokens > $max_tokens)"
  fi
  if [ "$max_latency" != "0" ] && [ "$p99_latency" -gt "$max_latency" ]; then
    violation="${violation}; p99_latency_ms($p99_latency > $max_latency)"
  fi

  if [ -z "$violation" ]; then
    echo "  ✓ cost: within budget — $explanation"
    l6_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation"
    return 0
  fi

  if [ "$fail_above" = "true" ]; then
    echo "  ✗ cost: budget exceeded$violation" >&2
    l6_record_score "$db" "$run_id" "$flow" "cost" 0 "$total_tokens" "$explanation $violation"
    return 1
  else
    echo "  ⚠ cost: soft-warn budget exceeded$violation"
    l6_record_score "$db" "$run_id" "$flow" "cost" 1 "$total_tokens" "$explanation $violation (soft)"
    return 0
  fi
}
