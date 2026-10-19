#!/usr/bin/env bash
# Tests for the swe agent_runs identity lifecycle (GH 1502, GH 1500):
#
#   1. Spawn — the Agent spawn (agent-spawn-dispatch.sh → record-swe-spawn.sh)
#      moves the pending task to running and opens one swe row carrying
#      spawn_id tool_use:<id>, session_id and effort.
#   2. Bind — the swe's task_brief (swe-brief-gate.sh, then the handler) binds
#      that row to its agent_id; repeated briefs keep one row.
#   3. Live — a bound row is never swept_orphan, however old.
#   4. Resume — a failed stop, a resumed brief and a committed stop leave one
#      row whose exit_reason is the latest stop's (completed).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCH="$PLUGIN_ROOT/scripts/hooks/dispatch.sh"
STOP_HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

REPO="$TMPDIR/repo"
git init -q -b dev "$REPO"
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
echo init > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm init

DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-06-16T19:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'run identity', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, created_at, updated_at) VALUES
    (7, 1, 'fix/7-identity', 'dev', 'd', 'pending', '## spec', 'medium', '$NOW', '$NOW'),
    (8, 1, 'fix/8-resume',   'dev', 'd', 'pending', '## spec', 'medium', '$NOW', '$NOW');
"
export TRAJECTORY_DB_PATH="$DB"
export CLAUDE_PROJECT_DIR="$REPO"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

for slug in 7-identity 8-resume; do
  git -C "$REPO" branch "fix/$slug" HEAD
  git -C "$REPO" worktree add -q "$REPO/.claude/worktrees/$slug" "fix/$slug"
done

# spawn <task_id> <tool_use_id> — the bro Agent spawn through the PreToolUse(Agent) chain.
spawn() {
  local payload
  payload=$(jq -nc --arg t "$1" --arg u "$2" \
    '{hook_event_name:"PreToolUse", tool_name:"Agent", tool_use_id:$u, session_id:"sess-main",
      tool_input:{subagent_type:"swe", effort:"medium", prompt:("task_id=" + $t + " You are swe.")}}')
  (cd "$REPO" && printf '%s' "$payload" | bash "$DISPATCH" agent-spawn-dispatch 2>/dev/null || true)
}

# brief <task_id> <agent_id> <tool_use_id> — the swe's task_brief: its PreToolUse gate, then the built handler.
brief() {
  local payload
  payload=$(jq -nc --arg t "$1" --arg a "$2" --arg u "$3" \
    '{hook_event_name:"PreToolUse", tool_name:"mcp__plugin_tmb_trajectory-server__task_brief",
      tool_use_id:$u, agent_type:"tmb:swe", agent_id:$a, session_id:"sess-main",
      tool_input:{agent:"swe", task_id:($t | tonumber)}}')
  (cd "$REPO" && printf '%s' "$payload" | bash "$DISPATCH" swe-brief-gate >/dev/null 2>&1 || true)
  (cd "$REPO" && node --experimental-sqlite --no-warnings --input-type=module -e "
    const { TrajectoryDB } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js');
    const { compositeTools } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/tools/composites.js');
    const db = new TrajectoryDB('$DB');
    const res = await compositeTools(db, '$DB', null).handlers.task_brief({ agent: 'swe', task_id: $1 });
    db.close();
    process.stdout.write(res.isError ? 'error' : 'ok');
  " 2>/dev/null)
}

# stop <task_id> <agent_id> — the swe's SubagentStop.
stop() {
  local tp="$TMPDIR/transcript-$1.jsonl"
  printf '%s\n' \
    '{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id='"$1"' You are swe."}}' \
    '{"type":"assistant","timestamp":"2026-06-16T19:30:04.000Z","message":{"id":"m1","usage":{"input_tokens":40,"output_tokens":4},"content":[]}}' \
    > "$tp"
  jq -nc --arg tp "$tp" --arg id "$2" \
    '{agent_type:"tmb:swe", agent_id:$id, session_id:"sess-main", agent_transcript_path:$tp, hook_event_name:"SubagentStop"}' \
    | (cd "$REPO" && bash "$STOP_HOOK" >/dev/null 2>&1 || true)
}

q() { sqlite3 "$DB" "$1"; }

test_case "(a) an Agent spawn moves task 7 to running and opens one identified swe row"
spawn 7 toolu_spawn7 >/dev/null
assert_eq "running" "$(q "SELECT status FROM tasks WHERE id=7;")" "task 7 running"
assert_eq "1" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=7 AND agent_type='swe';")" "one swe row"
assert_eq "tool_use:toolu_spawn7|sess-main|medium|claude" \
  "$(q "SELECT spawn_id, session_id, effort, host FROM agent_runs WHERE task_id=7;")" \
  "spawn_id, session_id and effort set at spawn"
assert_eq "$REPO/.claude/worktrees/7-identity" "$(q "SELECT root_dir FROM agent_runs WHERE task_id=7;")" "root_dir is the task worktree"

test_case "(b) two task_brief calls from one agent_id leave one row keyed by it"
assert_eq "ok" "$(brief 7 agent-7 toolu_brief1)" "first task_brief"
assert_eq "ok" "$(brief 7 agent-7 toolu_brief2)" "second task_brief"
assert_eq "1" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=7 AND agent_type='swe';")" "still one swe row"
assert_eq "agent-7|sess-main|medium|" \
  "$(q "SELECT spawn_id, session_id, effort, COALESCE(completed_at, '') FROM agent_runs WHERE task_id=7;")" \
  "bound to the agent_id, still open"

test_case "(e) no open unbound swe row survives spawn + brief"
assert_eq "0" "$(q "SELECT COUNT(*) FROM agent_runs WHERE agent_type='swe' AND completed_at IS NULL AND spawn_id IS NULL;")" "zero open spawn_id NULL swe rows"

test_case "(c) task_brief 11 minutes later keeps the bound row open"
q "UPDATE agent_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes') WHERE task_id=7;"
assert_eq "ok" "$(brief 7 agent-7 toolu_brief3)" "task_brief after 11 minutes"
assert_eq "1" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=7;")" "no new row"
assert_eq "agent-7||" "$(q "SELECT spawn_id, COALESCE(exit_reason, ''), COALESCE(completed_at, '') FROM agent_runs WHERE task_id=7;")" "not swept_orphan"

test_case "(d) failed stop, resume, committed stop leave one completed row"
spawn 8 toolu_spawn8 >/dev/null
assert_eq "ok" "$(brief 8 agent-8 toolu_brief4)" "task_brief binds"
stop 8 agent-8
assert_eq "running" "$(q "SELECT status FROM tasks WHERE id=8;")" "a stop without commits leaves the task running"
assert_eq "failed" "$(q "SELECT exit_reason FROM agent_runs WHERE task_id=8;")" "the first stop records failed"
assert_eq "ok" "$(brief 8 agent-8 toolu_brief5)" "the resumed spawn's task_brief"
assert_eq "|" "$(q "SELECT COALESCE(exit_reason, ''), COALESCE(completed_at, '') FROM agent_runs WHERE task_id=8;")" "the row reopens"
(cd "$REPO/.claude/worktrees/8-resume" && echo w > w.txt && git add w.txt && git commit -qm "feat: w")
stop 8 agent-8
assert_eq "completed" "$(q "SELECT status FROM tasks WHERE id=8;")" "the committed stop completes the task"
assert_eq "1" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=8;")" "one row"
assert_eq "agent-8|completed" "$(q "SELECT spawn_id, exit_reason FROM agent_runs WHERE task_id=8;")" "the latest stop's exit_reason"
assert_eq "0" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=8 AND exit_reason='swept_orphan';")" "zero swept_orphan rows"

test_case "(f) no closed task's latest bound swe row reads failed (GH 1500)"
q "UPDATE tasks SET status='closed' WHERE id=8;"
assert_eq "0" "$(q "SELECT COUNT(*) FROM agent_runs a JOIN tasks t ON t.id=a.task_id WHERE a.agent_type='swe' AND t.status='closed' AND a.exit_reason='failed' AND a.id=(SELECT MAX(id) FROM agent_runs WHERE task_id=a.task_id AND agent_type='swe' AND spawn_id IS NOT NULL);")" "GH 1500 query"

summarize
