#!/usr/bin/env bash
# Tests for scripts/hooks/require-spawn-effort.sh
#   1. swe — the Agent call's effort must equal tasks.effort of the task named
#      by task_id=<N>; a mismatched or missing effort is denied naming the
#      expected value and the fix.
#   2. pr-reviewer — the effort must equal plugin_config.reviewer_effort (high
#      when unset).
#   3. any other agent passes without an effort.
#   4. fail-closed: no jq, or a DB read error, denies.
#   5. agent-spawn-dispatch.sh runs it after require-task-spec.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
. "$HERE/fixtures/no-jq-path.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-spawn-effort.sh"
DISPATCHER="$PLUGIN_ROOT/scripts/hooks/agent-spawn-dispatch.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"

DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-17T12:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'effort', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, created_at, updated_at) VALUES
    (1, 1, 'feat/medium', 'dev', 'd', 'pending', '## Success Criteria', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, created_at, updated_at) VALUES
    (2, 1, 'feat/high', 'dev', 'd', 'pending', '## Success Criteria', 'high', '$NOW', '$NOW');
"

# payload <subagent_type> <prompt> [<effort>]
payload() {
  if [ $# -ge 3 ]; then
    jq -nc --arg t "$1" --arg p "$2" --arg e "$3" '{tool_name:"Agent",hook_event_name:"PreToolUse",tool_input:{subagent_type:$t,prompt:$p,effort:$e}}'
  else
    jq -nc --arg t "$1" --arg p "$2" '{tool_name:"Agent",hook_event_name:"PreToolUse",tool_input:{subagent_type:$t,prompt:$p}}'
  fi
}

run_hook() {
  printf '%s' "$1" | bash "$HOOK" 2>/dev/null || true
}

REVIEW_PROMPT="task_id=1 commit_sha=abc1234 branch_id=feat/medium repo=plugin attempt_n=1 subagent_session_id=s"

test_case "swe spawn whose effort matches tasks.effort passes"
assert_eq "" "$(run_hook "$(payload swe "task_id=1 You are swe." medium)")" "medium task, effort medium"
assert_eq "" "$(run_hook "$(payload tmb:swe "task_id=2 You are swe." high)")" "plugin-prefixed swe, high task, effort high"

test_case "swe spawn with a mismatched effort is denied naming the expected value and the fix"
out=$(run_hook "$(payload swe "task_id=2 You are swe." medium)")
assert_contains "$out" '"permissionDecision":"deny"' "deny"
assert_contains "$out" 'task_id=2 (tasks.effort) runs at effort \"high\"' "names the task and the expected value"
assert_contains "$out" 'passed effort=\"medium\"' "names what was passed"
assert_contains "$out" 'Pass effort=\"high\" on the Agent call' "names the fix"
assert_contains "$out" 'task_reopen(task_id=2, effort=...) for rework' "names how to change the task's effort"

test_case "swe spawn with no effort is denied naming the expected value"
out=$(run_hook "$(payload swe "task_id=1 You are swe.")")
assert_contains "$out" '"permissionDecision":"deny"' "deny"
assert_contains "$out" 'passed no effort' "names the missing effort"
assert_contains "$out" 'Pass effort=\"medium\" on the Agent call' "names the fix"

test_case "swe spawn without a task id or naming no task row is left to require-task-spec"
assert_eq "" "$(run_hook "$(payload swe "do the thing")")" "no task id: pass"
assert_eq "" "$(run_hook "$(payload swe "task_id=99 You are swe.")")" "no row: pass"

test_case "pr-reviewer spawn passes only with reviewer_effort (high when unset)"
assert_eq "" "$(run_hook "$(payload pr-reviewer "$REVIEW_PROMPT" high)")" "high passes while unset"
out=$(run_hook "$(payload tmb:pr-reviewer "$REVIEW_PROMPT" medium)")
assert_contains "$out" '"permissionDecision":"deny"' "medium denied while unset"
assert_contains "$out" 'config_set(key=\"reviewer_effort\"' "names how to change reviewer_effort"
assert_contains "$out" 'Pass effort=\"high\" on the Agent call' "names the fix"
out=$(run_hook "$(payload pr-reviewer "$REVIEW_PROMPT")")
assert_contains "$out" 'passed no effort' "missing effort denied"
sqlite3 "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '\"medium\"');"
assert_eq "" "$(run_hook "$(payload pr-reviewer "$REVIEW_PROMPT" medium)")" "medium passes once configured"
out=$(run_hook "$(payload pr-reviewer "$REVIEW_PROMPT" high)")
assert_contains "$out" 'Pass effort=\"medium\" on the Agent call' "high denied once medium is configured"
sqlite3 "$DB" "UPDATE plugin_config SET value_json = '\"max\"' WHERE key = 'reviewer_effort';"
assert_eq "" "$(run_hook "$(payload pr-reviewer "$REVIEW_PROMPT" high)")" "an invalid stored value reads as high"
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key = 'reviewer_effort';"

test_case "a consultant or other agent passes without an effort"
assert_eq "" "$(run_hook "$(payload security-consultant "review the auth flow")")" "consultant"
assert_eq "" "$(run_hook "$(payload general-purpose "task_id=2 look around")")" "general-purpose"
assert_eq "" "$(run_hook "$(payload swe-helper "task_id=2")")" "a name that only starts with swe"

test_case "missing jq fails closed"
NOJQ=$(no_jq_path "$TMPDIR/nojq")
out=$(printf '%s' "$(payload swe "task_id=1" medium)" | PATH="$NOJQ" bash "$HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny"
assert_contains "$out" "jq not found" "names jq"

test_case "a DB read error fails closed"
BAD="$TMPDIR/bad.db"
printf 'not a sqlite database' > "$BAD"
out=$(printf '%s' "$(payload swe "task_id=1" medium)" | TRAJECTORY_DB_PATH="$BAD" bash "$HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "swe: deny"
assert_contains "$out" "trajectory DB unavailable" "swe: names the DB"
out=$(printf '%s' "$(payload pr-reviewer "$REVIEW_PROMPT" high)" | TRAJECTORY_DB_PATH="$BAD" bash "$HOOK" 2>/dev/null || true)
assert_contains "$out" "trajectory DB unavailable" "pr-reviewer: names the DB"

test_case "no trajectory DB (project not onboarded): pass"
out=$(printf '%s' "$(payload swe "task_id=1")" | TRAJECTORY_DB_PATH="$TMPDIR/absent.db" bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out" "unresolved DB allows"

test_case "agent-spawn-dispatch.sh runs the gate after require-task-spec.sh"
order=$(grep -oE 'require-(task-spec|spawn-effort)\.sh"' "$DISPATCHER" | tr -d '"' | paste -sd, -)
assert_eq "require-task-spec.sh,require-spawn-effort.sh" "$order" "HOOKS order"
out=$(printf '%s' "$(payload swe "task_id=2 You are swe." low)" | bash "$DISPATCHER" 2>/dev/null || true)
assert_contains "$out" 'Pass effort=\"high\" on the Agent call' "the dispatcher returns the effort deny"

summarize
