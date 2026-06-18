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

# shellcheck source=tests/l5-l6/lib/assert-usage.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/assert-usage.sh"

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
# Reads scorer_dir/tools-required.json (a JSON array). Each entry is either:
#   - a plain string (tool name always required), or
#   - an object {"tool":"name","skip_if_pre_state_sql":"SELECT 1 FROM ..."}
#     where the SQL is evaluated against $project/.claude/tmb/_l6_pre_step.db
#     when that file exists; if the query returns any row the requirement is
#     waived (pre-state condition already satisfied — the tool is only needed
#     when the pre-state lacks the resource). In L5 mode (no pre-step DB) the
#     condition is ignored and the tool remains required.
# Asserts every non-waived tool was called at least once (superset semantics
# per LangSmith docs). Order-agnostic. Reads tool_use names from trajectory.jsonl.
l5_score_trajectory_required() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local db="$project/.claude/tmb/trajectory.db"
  local pre_step_db="$project/.claude/tmb/_l6_pre_step.db"
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

  local entry_count missing=""
  entry_count=$(jq -r 'length' "$req_path" 2>/dev/null || echo 0)

  local i
  if [ "${entry_count:-0}" -gt 0 ]; then
    for i in $(seq 0 $((entry_count - 1))); do
      local entry_type tool skip_sql
      entry_type=$(jq -r ".[$i] | type" "$req_path" 2>/dev/null)

      if [ "$entry_type" = "string" ]; then
        tool=$(jq -r ".[$i]" "$req_path")
        skip_sql=""
      else
        tool=$(jq -r ".[$i].tool" "$req_path" 2>/dev/null)
        skip_sql=$(jq -r ".[$i].skip_if_pre_state_sql // empty" "$req_path" 2>/dev/null)
      fi

      [ -z "$tool" ] && continue

      if [ -n "$skip_sql" ] && [ -f "$pre_step_db" ]; then
        local hit
        hit=$(sqlite3 "$pre_step_db" "$skip_sql" 2>/dev/null | head -1)
        if [ -n "$hit" ]; then
          echo "  ⊘ trajectory_required: $tool waived (pre-state condition met)"
          continue
        fi
      fi

      if ! echo "$tools_called" | grep -qFx "$tool"; then
        missing="${missing}; $tool"
      fi
    done
  fi

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

# l5_score_files <flow_dir> <workspace_dir>
# Reads flow_dir/outcome-files.json. Asserts file existence, absence, and
# minimum byte size for each entry. Opt-in: silently returns 0 when no
# outcome-files.json is present. Returns 0 if all assertions pass, 1 if any fail.
l5_score_files() {
  local flow_dir="$1"
  local workspace_dir="$2"
  local budget_file="$flow_dir/outcome-files.json"

  [ -f "$budget_file" ] || return 0

  local fail=0

  local entries
  entries=$(jq -c '.files[]' "$budget_file" 2>/dev/null) || {
    echo "  ✗ files: invalid JSON in $budget_file" >&2
    return 1
  }

  while IFS= read -r entry; do
    local path must_exist must_not_exist min_bytes
    path=$(echo "$entry" | jq -r '.path')
    must_exist=$(echo "$entry" | jq -r '.must_exist // false')
    must_not_exist=$(echo "$entry" | jq -r '.must_not_exist // false')
    min_bytes=$(echo "$entry" | jq -r '.min_bytes // 0')

    local full_path="$workspace_dir/$path"

    if [ "$must_exist" = "true" ]; then
      if [ ! -f "$full_path" ]; then
        echo "  ✗ files: $path does not exist" >&2
        fail=1
        continue
      fi
      if [ "$min_bytes" -gt 0 ]; then
        local actual_bytes
        actual_bytes=$(wc -c < "$full_path" | tr -d ' ')
        if [ "$actual_bytes" -lt "$min_bytes" ]; then
          echo "  ✗ files: $path is $actual_bytes bytes, expected >=$min_bytes" >&2
          fail=1
          continue
        fi
        echo "  ✓ files: $path exists (>=$min_bytes bytes)"
      else
        echo "  ✓ files: $path exists"
      fi
    fi

    if [ "$must_not_exist" = "true" ]; then
      if [ -f "$full_path" ]; then
        echo "  ✗ files: $path exists but should not" >&2
        fail=1
      else
        echo "  ✓ files: $path does not exist"
      fi
    fi
  done <<< "$entries"

  return $fail
}

# l5_score_coherence <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/outcome-coherence.json. Asserts row counts per table
# satisfy the comparison operator. Catches "empty-table" doctrine violations
# (e.g. a planning flow that didn't write any discussions row) without each
# flow author having to spell out the SQL in outcome.sql.
#
# Schema:
#   {
#     "expected_writes": {
#       "<table>": "<op><N>",
#       "<table> WHERE <where-clause>": "<op><N>"
#     }
#   }
#
# Operators: ">=N", "<=N", "=N", "!=N", or bare "N" (interpreted as "=N").
# Opt-in: silently returns 0 when no outcome-coherence.json is present.
l5_score_coherence() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local cfg="$scorer_dir/outcome-coherence.json"
  local db="$project/.claude/tmb/trajectory.db"

  [ -f "$cfg" ] || return 0

  local fail=0
  local checked=0

  # Iterate keys of expected_writes (table specs, possibly with WHERE suffix).
  local keys
  keys=$(jq -r '(.expected_writes // {}) | to_entries[] | .key' "$cfg" 2>/dev/null)

  while IFS= read -r key; do
    [ -z "$key" ] && continue
    checked=$((checked + 1))

    local op_value
    op_value=$(jq -r --arg k "$key" '.expected_writes[$k]' "$cfg")

    # Split "<table>[ WHERE <clause>]"
    local table where_clause=""
    if [[ "$key" == *" WHERE "* ]]; then
      table="${key%% WHERE *}"
      where_clause=" WHERE ${key#* WHERE }"
    else
      table="$key"
    fi

    # Parse op + number
    local op num
    case "$op_value" in
      ">="*) op=">="; num="${op_value#>=}" ;;
      "<="*) op="<="; num="${op_value#<=}" ;;
      "!="*) op="!="; num="${op_value#!=}" ;;
      "="*)  op="=";  num="${op_value#=}"  ;;
      *)
        # Bare number = exact match.
        if [[ "$op_value" =~ ^[0-9]+$ ]]; then
          op="="; num="$op_value"
        else
          echo "  ✗ coherence: invalid operator in '$op_value' for $key" >&2
          fail=1
          continue
        fi
        ;;
    esac

    local count
    count=$(sqlite3 "$db" "SELECT COUNT(*) FROM ${table}${where_clause};" 2>/dev/null)
    if [ -z "$count" ]; then
      echo "  ✗ coherence: query failed for ${table}${where_clause}" >&2
      fail=1
      continue
    fi

    local pass=0
    case "$op" in
      ">=") [ "$count" -ge "$num" ] && pass=1 ;;
      "<=") [ "$count" -le "$num" ] && pass=1 ;;
      "=")  [ "$count" -eq "$num" ] && pass=1 ;;
      "!=") [ "$count" -ne "$num" ] && pass=1 ;;
    esac

    if [ "$pass" = "1" ]; then
      echo "  ✓ coherence: ${table}${where_clause} = $count (expected $op_value)"
    else
      echo "  ✗ coherence: ${table}${where_clause} = $count (expected $op_value)" >&2
      fail=1
    fi
  done <<< "$keys"

  if [ "$checked" = "0" ]; then
    # Empty config — treat as no-op rather than fail.
    return 0
  fi

  l5_record_score "$db" "$run_id" "$flow" "coherence" \
    "$([ "$fail" = "0" ] && echo 1 || echo 0)" \
    "" \
    "$([ "$fail" = "0" ] && echo "$checked check(s) passed" || echo "$fail of $checked check(s) failed")"
  return "$fail"
}

# l5_score_git <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/outcome-git.json. Asserts git-state invariants the flow
# must hold post-run. Catches "bro committed to dev directly" / "worktree
# on detached HEAD" / "uncommitted slop in worktree" — failures that look
# like a passing flow on the trajectory + DB scorers.
#
# Schema:
#   {
#     "base_branch_unchanged":   true,                 // base = pr_target config; only init commit
#     "uncommitted_in_worktree": false,                // applies to the most-recent task's worktree
#     "worktrees": [
#       {
#         "path":            ".claude/worktrees/<slug>",  // <slug> = most-recent tasks.branch_id slug
#         "head_branch":     "<task.branch_id>",          // literal branch name or placeholder
#         "head_not_branch": ["dev", "main"]              // assert HEAD is not on any of these
#       }
#     ]
#   }
#
# Opt-in: silently returns 0 when no outcome-git.json is present.
l5_score_git() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local cfg="$scorer_dir/outcome-git.json"
  local db="$project/.claude/tmb/trajectory.db"

  [ -f "$cfg" ] || return 0

  local fail=0 checked=0

  # Resolve the most-recent task's branch_id (used for placeholder
  # substitution and worktree slug derivation).
  local task_branch=""
  local task_slug=""
  task_branch=$(sqlite3 "$db" "SELECT branch_id FROM tasks ORDER BY id DESC LIMIT 1;" 2>/dev/null)
  task_slug="${task_branch##*/}"

  # Resolve pr_target for base-branch checks.
  local pr_target
  pr_target=$(sqlite3 "$db" "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='pr_target';" 2>/dev/null)
  pr_target="${pr_target:-main}"

  # 1) base_branch_unchanged — base branch tip should match the snapshot
  # captured by l5_run_claude immediately before bro fired. This isolates
  # "bro committed to base during the run" from setup commits the flow's
  # run.sh made beforehand (e.g., flow 13 seeds .DS_Store files via a
  # commit on main before bro is even spawned).
  if [ "$(jq -r '.base_branch_unchanged // false' "$cfg")" = "true" ]; then
    checked=$((checked + 1))
    local pre_run="$project/.claude/tmb/_l5_pre_run_git.json"
    if [ ! -f "$pre_run" ]; then
      echo "  ✗ git: pre-run snapshot missing at $pre_run (did l5_run_claude run?)" >&2
      fail=1
    else
      local pre_head post_head
      pre_head=$(jq -r '.head // ""' "$pre_run")
      post_head=$(git -C "$project" rev-parse "$pr_target" 2>/dev/null || echo "")
      if [ -z "$pre_head" ] || [ -z "$post_head" ]; then
        echo "  ✗ git: base branch '$pr_target' SHA not resolvable (pre=$pre_head post=$post_head)" >&2
        fail=1
      elif [ "$pre_head" = "$post_head" ]; then
        echo "  ✓ git: base branch '$pr_target' unchanged since pre-run snapshot"
      else
        local delta
        delta=$(git -C "$project" rev-list --count "$pre_head..$post_head" 2>/dev/null || echo "?")
        echo "  ✗ git: base branch '$pr_target' advanced $delta commit(s) during the run. Did bro commit to base?" >&2
        fail=1
      fi
    fi
  fi

  # 2) uncommitted_in_worktree — most-recent task's worktree should be clean.
  local uncommitted_setting
  uncommitted_setting=$(jq -r '.uncommitted_in_worktree // null' "$cfg")
  if [ "$uncommitted_setting" = "false" ] && [ -n "$task_slug" ] && [ -d "$project/.claude/worktrees/$task_slug" ]; then
    checked=$((checked + 1))
    local dirty
    dirty=$(git -C "$project/.claude/worktrees/$task_slug" status --porcelain 2>/dev/null || true)
    if [ -z "$dirty" ]; then
      echo "  ✓ git: worktree '$task_slug' is clean (no uncommitted changes)"
    else
      echo "  ✗ git: worktree '$task_slug' has uncommitted changes:" >&2
      echo "$dirty" | head -5 >&2
      fail=1
    fi
  fi

  # 3) worktrees[] — per-worktree HEAD assertions.
  local wt_count
  wt_count=$(jq -r '(.worktrees // []) | length' "$cfg" 2>/dev/null)
  wt_count="${wt_count:-0}"
  if [ "$wt_count" -gt 0 ]; then
    local i
    for ((i=0; i < wt_count; i++)); do
      checked=$((checked + 1))
      local wt_path wt_head_should
      wt_path=$(jq -r ".worktrees[$i].path // \"\"" "$cfg")
      wt_head_should=$(jq -r ".worktrees[$i].head_branch // \"\"" "$cfg")

      # Placeholder substitution.
      wt_path="${wt_path//<slug>/$task_slug}"
      wt_head_should="${wt_head_should//<task.branch_id>/$task_branch}"

      local full_path="$project/$wt_path"
      if [ ! -d "$full_path" ]; then
        echo "  ✗ git: worktree path missing: $wt_path" >&2
        fail=1
        continue
      fi

      local actual
      actual=$(git -C "$full_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      if [ -z "$actual" ]; then
        echo "  ✗ git: could not resolve HEAD branch in $wt_path" >&2
        fail=1
        continue
      fi

      # Required branch (positive)
      if [ -n "$wt_head_should" ]; then
        if [ "$actual" = "$wt_head_should" ]; then
          echo "  ✓ git: $wt_path HEAD on '$actual'"
        else
          echo "  ✗ git: $wt_path HEAD on '$actual' (expected '$wt_head_should')" >&2
          fail=1
        fi
      fi

      # head_not_branch list
      local not_count
      not_count=$(jq -r ".worktrees[$i].head_not_branch // [] | length" "$cfg")
      if [ "$not_count" -gt 0 ]; then
        local j
        for ((j=0; j < not_count; j++)); do
          local forbidden
          forbidden=$(jq -r ".worktrees[$i].head_not_branch[$j]" "$cfg")
          if [ "$actual" = "$forbidden" ]; then
            echo "  ✗ git: $wt_path HEAD on forbidden branch '$forbidden'" >&2
            fail=1
          fi
        done
      fi
    done
  fi

  if [ "$checked" = "0" ]; then
    return 0
  fi

  l5_record_score "$db" "$run_id" "$flow" "git" \
    "$([ "$fail" = "0" ] && echo 1 || echo 0)" \
    "" \
    "$([ "$fail" = "0" ] && echo "$checked check(s) passed" || echo "$fail of $checked check(s) failed")"
  return "$fail"
}

# l5_score_usage <project_dir> <flow> <scorer_dir> <run_id>
# Reads scorer_dir/outcome-usage.json: a JSON array of skill/plugin names that
# bro must have invoked this row. Each name is checked against the per-row
# stream-json run log ($project/trajectory.jsonl) via tmb_usage_in_log — the
# log-based replacement for the (retiring, #118) skill_invocations table.
#
# Schema:
#   { "skills_used": ["tmb_planning", "tmb:tmb_review"] }
#
# KNOWN LIMITATION — subagent (swe) skills. swe runs in its own CC session
# whose stream-json is not merged into bro's run log, so a skill swe loads
# leaves no signal here. Only assert bro-side skills with this scorer (see
# assert-usage.sh).
#
# Opt-in: silently returns 0 when no outcome-usage.json is present.
l5_score_usage() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local cfg="$scorer_dir/outcome-usage.json"
  local db="$project/.claude/tmb/trajectory.db"
  local run_log="$project/trajectory.jsonl"

  [ -f "$cfg" ] || return 0

  if [ ! -f "$run_log" ]; then
    echo "  ✗ usage: $run_log not found (runner must produce stream-json)" >&2
    l5_record_score "$db" "$run_id" "$flow" "usage" 0 "no-log" "trajectory.jsonl missing"
    return 1
  fi

  local names
  names=$(jq -r '(.skills_used // [])[]' "$cfg" 2>/dev/null)

  local checked=0 missing=""
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    checked=$((checked + 1))
    if tmb_usage_in_log "$run_log" "$name"; then
      echo "  ✓ usage: '$name' invoked (run log)"
    else
      echo "  ✗ usage: '$name' not found in run log" >&2
      missing="${missing}; $name"
    fi
  done <<< "$names"

  if [ "$checked" = "0" ]; then
    return 0
  fi

  if [ -z "$missing" ]; then
    l5_record_score "$db" "$run_id" "$flow" "usage" 1 "${checked}" "all skills used"
    return 0
  else
    l5_record_score "$db" "$run_id" "$flow" "usage" 0 "missing" "$missing"
    return 1
  fi
}
