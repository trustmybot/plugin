#!/usr/bin/env bash
# Unit-style tests for the new coherence + git scorers (Phase 1).
# Builds a synthetic scratch project + DB, exercises pass/fail paths.
# Run: bash tests/l5-l6/lib/scorers-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$HERE/scorers.sh"

PASS=0
FAIL=0
TMPDIR_ROOT=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/scorers-test-XXXXXX")
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ---- helpers --------------------------------------------------------------

mk_project() {
  local p
  p=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/scorers-XXXXXX")
  (
    cd "$p" || exit 1
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
    echo init > README.md
    git add . && git commit -qm init
  ) >/dev/null 2>&1
  mkdir -p "$p/.claude/tmb"
  # Schema runs PRAGMA journal_mode = WAL which echoes "wal" to stdout — redirect.
  sqlite3 "$p/.claude/tmb/trajectory.db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  echo "$p"
}

mk_flow_dir() {
  mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/scorers-flow-XXXXXX"
}

assert_exit() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $label — expected exit=$expected, got exit=$actual"
  fi
}

# ---- coherence scorer -----------------------------------------------------

echo "== coherence: missing config = no-op (pass) =="
P=$(mk_project) && FD=$(mk_flow_dir)
l5_score_coherence "$P" "test" "$FD" "run-1" >/dev/null 2>&1
assert_exit 0 $? "no outcome-coherence.json → exit 0"

echo "== coherence: empty config = no-op (pass) =="
echo '{}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-2" >/dev/null 2>&1
assert_exit 0 $? "empty config → exit 0"

echo "== coherence: assertion satisfied =="
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now'));"
echo '{"expected_writes": {"issues": ">=1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-3" >/dev/null 2>&1
assert_exit 0 $? "issues>=1 with one row → pass"

echo "== coherence: assertion violated =="
echo '{"expected_writes": {"issues": ">=5"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-4" >/dev/null 2>&1
assert_exit 1 $? "issues>=5 with one row → fail"

echo "== coherence: WHERE clause filtering =="
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (1, 1, 'feat/foo', 'main', '', 'pending', datetime('now'), datetime('now'));"
echo '{"expected_writes": {"tasks WHERE branch_id != \"main\"": ">=1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-5" >/dev/null 2>&1
assert_exit 0 $? "tasks WHERE branch != main → pass"

echo "== coherence: exact-match operator =="
echo '{"expected_writes": {"tasks": "1"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-6" >/dev/null 2>&1
assert_exit 0 $? "tasks = 1 → pass"

echo "== coherence: != operator =="
echo '{"expected_writes": {"audit": "!=99"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-7" >/dev/null 2>&1
assert_exit 0 $? "audit !=99 → pass"

echo "== coherence: invalid operator =="
echo '{"expected_writes": {"issues": "wat"}}' > "$FD/outcome-coherence.json"
l5_score_coherence "$P" "test" "$FD" "run-8" >/dev/null 2>&1
assert_exit 1 $? "invalid operator → fail"

# ---- git scorer -----------------------------------------------------------

echo "== git: missing config = no-op (pass) =="
P=$(mk_project) && FD=$(mk_flow_dir)
l5_score_git "$P" "test" "$FD" "run-g1" >/dev/null 2>&1
assert_exit 0 $? "no outcome-git.json → exit 0"

echo "== git: base_branch_unchanged matches pre-run snapshot =="
echo '{"base_branch_unchanged": true}' > "$FD/outcome-git.json"
# Simulate what l5_run_claude does before firing claude-p.
mkdir -p "$P/.claude/tmb"
PRE_HEAD=$(git -C "$P" rev-parse HEAD)
printf '{"head":"%s","branch":"main"}\n' "$PRE_HEAD" > "$P/.claude/tmb/_l5_pre_run_git.json"
l5_score_git "$P" "test" "$FD" "run-g2" >/dev/null 2>&1
assert_exit 0 $? "base SHA unchanged from pre-run → pass"

echo "== git: base_branch_unchanged catches a commit during the run =="
(cd "$P" && echo "more" >> README.md && git add . && git commit -qm "bro committed to base!") >/dev/null 2>&1
l5_score_git "$P" "test" "$FD" "run-g3" >/dev/null 2>&1
assert_exit 1 $? "base advanced post-snapshot → fail"

echo "== git: missing pre-run snapshot is reported =="
P=$(mk_project) && FD=$(mk_flow_dir)
echo '{"base_branch_unchanged": true}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g3b" >/dev/null 2>&1
assert_exit 1 $? "no pre-run snapshot → fail (loud signal)"

echo "== git: worktree HEAD on expected branch =="
P=$(mk_project) && FD=$(mk_flow_dir)
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now')); INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (1, 1, 'feat/check', 'main', '', 'pending', datetime('now'), datetime('now'));"
(cd "$P" && git branch feat/check HEAD && mkdir -p .claude/worktrees && git worktree add -q .claude/worktrees/check feat/check)
echo '{"worktrees": [{"path": ".claude/worktrees/<slug>", "head_branch": "<task.branch_id>"}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g4" >/dev/null 2>&1
assert_exit 0 $? "worktree on feat/check → pass"

echo "== git: worktree HEAD on forbidden branch =="
echo '{"worktrees": [{"path": ".claude/worktrees/check", "head_not_branch": ["feat/check"]}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g5" >/dev/null 2>&1
assert_exit 1 $? "worktree on forbidden 'feat/check' → fail"

echo "== git: worktree path missing =="
echo '{"worktrees": [{"path": ".claude/worktrees/missing", "head_branch": "main"}]}' > "$FD/outcome-git.json"
l5_score_git "$P" "test" "$FD" "run-g6" >/dev/null 2>&1
assert_exit 1 $? "worktree path missing → fail"

# ---- trajectory scorers ---------------------------------------------------

T_INTENT="mcp__plugin_tmb_trajectory-server__intent_start"
T_ISSUE="mcp__plugin_tmb_trajectory-server__issue_create"
T_BATCH="mcp__plugin_tmb_trajectory-server__task_create_batch"
T_VALID="mcp__plugin_tmb_trajectory-server__validation_record"

write_assistant_line() {
  local file="$1" tool="$2" parent="${3:-}"
  if [ -n "$parent" ]; then
    jq -nc --arg t "$tool" --arg p "$parent" '{type:"assistant", parent_tool_use_id:$p, message:{content:[{type:"tool_use", name:$t}]}}' >> "$file"
  else
    jq -nc --arg t "$tool" '{type:"assistant", parent_tool_use_id:null, message:{content:[{type:"tool_use", name:$t}]}}' >> "$file"
  fi
}

echo "== trajectory_forbidden: subagent call is not attributed to bro =="
P=$(mk_project) && FD=$(mk_flow_dir)
write_assistant_line "$P/trajectory.jsonl" "$T_INTENT"
write_assistant_line "$P/trajectory.jsonl" "$T_VALID" "toolu_x"
jq -nc --arg t "$T_VALID" '[$t]' > "$FD/tools-forbidden.json"
l5_score_trajectory_forbidden "$P" "test" "$FD" "run-tf1" >/dev/null 2>&1
assert_exit 0 $? "subagent validation_record → pass"

echo "== trajectory_forbidden: top-level call is a violation =="
write_assistant_line "$P/trajectory.jsonl" "$T_VALID"
l5_score_trajectory_forbidden "$P" "test" "$FD" "run-tf2" >/dev/null 2>&1
assert_exit 1 $? "top-level validation_record → fail"

echo "== trajectory_required: any_of satisfied by one alternative =="
P=$(mk_project) && FD=$(mk_flow_dir)
write_assistant_line "$P/trajectory.jsonl" "$T_INTENT"
jq -nc --arg a "$T_ISSUE" --arg b "$T_INTENT" '[{any_of:[$a,$b]}]' > "$FD/tools-required.json"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr1" >/dev/null 2>&1
assert_exit 0 $? "any_of(issue_create|intent_start) with intent_start called → pass"

echo "== trajectory_required: any_of unsatisfied =="
jq -nc --arg a "$T_ISSUE" --arg b "$T_BATCH" '[{any_of:[$a,$b]}]' > "$FD/tools-required.json"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr2" >/dev/null 2>&1
assert_exit 1 $? "any_of(issue_create|task_create_batch) with neither called → fail"

echo "== trajectory_required: plain string entries =="
jq -nc --arg a "$T_INTENT" '[$a]' > "$FD/tools-required.json"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr3" >/dev/null 2>&1
assert_exit 0 $? "string entry for called tool → pass"
jq -nc --arg a "$T_BATCH" '[$a]' > "$FD/tools-required.json"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr4" >/dev/null 2>&1
assert_exit 1 $? "string entry for uncalled tool → fail"

echo "== trajectory_required: subagent calls still count =="
write_assistant_line "$P/trajectory.jsonl" "$T_BATCH" "toolu_y"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr5" >/dev/null 2>&1
assert_exit 0 $? "string entry satisfied by subagent call → pass"

echo "== trajectory_required: row 06 waives Agent + bro_atomic_close when step 5 already closed the task =="
ROW06="$PLUGIN_ROOT/tests/l5-l6/rows/06/06-swe-atomic-close"
P=$(mk_project) && FD=$(mk_flow_dir)
cp "$ROW06/tools-required.json" "$FD/tools-required.json"
write_assistant_line "$P/trajectory.jsonl" "$T_INTENT"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr6" >/dev/null 2>&1
assert_exit 1 $? "no pre-step DB (L5 mode), neither tool called → fail"
ROW06_OUT=$(l5_score_trajectory_required "$P" "test" "$FD" "run-tr6b" 2>&1)
case "$ROW06_OUT" in
  *Agent*bro_atomic_close*) PASS=$((PASS + 1)); echo "  PASS failure names both tools" ;;
  *) FAIL=$((FAIL + 1)); echo "  FAIL failure names both tools — got: $ROW06_OUT" ;;
esac
cp "$P/.claude/tmb/trajectory.db" "$P/.claude/tmb/_l6_pre_step.db"
sqlite3 "$P/.claude/tmb/_l6_pre_step.db" "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now')); INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (1, 1, 'feat/pending', 'main', '', 'pending', datetime('now'), datetime('now'));"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr7" >/dev/null 2>&1
assert_exit 1 $? "pre-step DB with only a pending task, neither tool called → fail"
sqlite3 "$P/.claude/tmb/_l6_pre_step.db" "UPDATE tasks SET status = 'closed' WHERE id = 1;"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr8" >/dev/null 2>&1
assert_exit 1 $? "pre-step DB with a closed task but no swe run, neither tool called → fail"
sqlite3 "$P/.claude/tmb/_l6_pre_step.db" "INSERT INTO agent_runs (task_id, issue_id, agent_type) VALUES (1, 1, 'swe');"
l5_score_trajectory_required "$P" "test" "$FD" "run-tr9" >/dev/null 2>&1
assert_exit 0 $? "pre-step DB with a closed task and a swe run, neither tool called → pass"
rm -rf "$P" "$FD"

# ---- no_sandbox scorer (GH 1549) ------------------------------------------

echo "== no_sandbox: TEST MODE pins the sandbox answer to no =="
P=$(mk_project) && FD=$(mk_flow_dir)
l5_score_no_sandbox "$P" "test" "$FD" "run-ns1" >/dev/null 2>&1
assert_exit 0 $? "no settings.local.json, no answer → pass"
sqlite3 "$P/.claude/tmb/trajectory.db" "INSERT INTO plugin_config (key, value_json) VALUES ('sandbox_enforcement', '\"no\"');"
echo '{"permissions":{"allow":["Bash"]}}' > "$P/.claude/settings.local.json"
l5_score_no_sandbox "$P" "test" "$FD" "run-ns2" >/dev/null 2>&1
assert_exit 0 $? "settings without a sandbox block, answer no → pass"
echo '{"sandbox":{"enabled":true}}' > "$P/.claude/settings.local.json"
l5_score_no_sandbox "$P" "test" "$FD" "run-ns3" >/dev/null 2>&1
assert_exit 1 $? "sandbox block present → fail"
echo '{}' > "$P/.claude/settings.local.json"
sqlite3 "$P/.claude/tmb/trajectory.db" "UPDATE plugin_config SET value_json = '\"yes\"' WHERE key = 'sandbox_enforcement';"
l5_score_no_sandbox "$P" "test" "$FD" "run-ns4" >/dev/null 2>&1
assert_exit 1 $? "sandbox_enforcement = yes → fail"
rm -rf "$P" "$FD"

# ---- summary --------------------------------------------------------------

echo
echo "scorers-test: $PASS pass / $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
