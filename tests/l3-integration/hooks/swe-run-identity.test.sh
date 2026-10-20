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
#   5. Refused spawn (GH 1509) — an unbound row older than 90 s no longer
#      blocks a respawn and is swept_orphan by it; PostToolUse(Agent) binds the
#      row to tool_response.agentId; PermissionDenied(Agent) closes it and
#      returns the task to pending; a bound row is never closed by any of them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCH="$PLUGIN_ROOT/scripts/hooks/dispatch.sh"
STOP_HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/tmb-swe-run-identity.XXXXXX")
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

# agent_event <event> <task_id> <tool_use_id> [<extra json>] — an Agent tool payload for task <task_id>;
# an empty tool_use_id leaves the key out. SPAWN_NOTE ends the prompt, so two
# otherwise identical spawns are two events to dispatch.sh.
agent_event() {
  local extra="${4:-}"
  [ -n "$extra" ] || extra='{}'
  jq -nc --arg e "$1" --arg t "$2" --arg u "$3" --arg n "${SPAWN_NOTE:-}" --argjson x "$extra" \
    '{hook_event_name:$e, tool_name:"Agent", session_id:"sess-main",
      tool_input:{subagent_type:"swe", effort:"medium", prompt:("task_id=" + $t + " You are swe." + $n)}}
     + (if $u == "" then {} else {tool_use_id:$u} end) + $x'
}

# spawn <task_id> <tool_use_id> — the bro Agent spawn through the PreToolUse(Agent) chain.
spawn() {
  (cd "$REPO" && agent_event PreToolUse "$1" "$2" | bash "$DISPATCH" agent-spawn-dispatch 2>/dev/null || true)
}

# bind <task_id> <tool_use_id> <agentId> — PostToolUse(Agent) once CC accepted the spawn.
bind() {
  (cd "$REPO" && agent_event PostToolUse "$1" "$2" "$(jq -nc --arg a "$3" '{tool_response:{status:"async_launched", agentId:$a}}')" \
    | bash "$DISPATCH" swe-spawn-bind >/dev/null 2>&1 || true)
}

# refuse <task_id> <tool_use_id> — PermissionDenied(Agent): auto mode refused the spawn.
refuse() {
  (cd "$REPO" && agent_event PermissionDenied "$1" "$2" '{"reason":"auto mode refused"}' \
    | bash "$DISPATCH" swe-spawn-rollback >/dev/null 2>&1 || true)
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


# reset7 — task 7 pending with no runs, for the GH 1509 fixtures; each fixture's
# payloads carry their own SPAWN_NOTE, so dispatch.sh never dedupes them
# against the previous fixture's.
RESETS=0
reset7() {
  q "DELETE FROM agent_runs WHERE task_id=7; UPDATE tasks SET status='pending' WHERE id=7;"
  RESETS=$((RESETS + 1))
  SPAWN_NOTE=" fixture $RESETS"
}
backdate() { q "UPDATE agent_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-$2 seconds') WHERE spawn_id = '$1';"; }
OPEN_UNBOUND7="SELECT COUNT(*) FROM agent_runs WHERE agent_type='swe' AND completed_at IS NULL AND spawn_id GLOB 'tool_use:*' AND task_id=7;"

test_case "(g) a refused spawn's unbound row older than 90 s is swept_orphan by the next spawn (GH 1509)"
reset7
spawn 7 tu-1 >/dev/null
assert_eq "running" "$(q "SELECT status FROM tasks WHERE id=7;")" "PREPARE moved task 7 to running"
backdate tool_use:tu-1 91
out=$(spawn 7 tu-2)
assert_not_contains "$out" '"deny"' "the second spawn passes require-task-spec"
assert_eq "swept_orphan|1|unmeasured" \
  "$(q "SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-1';")" \
  "tu-1 swept_orphan with completed_at set"
assert_eq "1" "$(q "$OPEN_UNBOUND7")" "one open unbound swe row: the new spawn's"
assert_eq "tool_use:tu-2" "$(q "SELECT spawn_id FROM agent_runs WHERE task_id=7 AND completed_at IS NULL;")" "record-swe-spawn opened tu-2"

test_case "(h) without a tool_use_id: denied inside 90 s, swept after it"
reset7
spawn 7 "" >/dev/null
FIRST=$(q "SELECT spawn_id FROM agent_runs WHERE task_id=7;")
assert_contains "$FIRST" "tool_use:sess-main:" "session fallback spawn_id"
out=$(SPAWN_NOTE="$SPAWN_NOTE retry 1" spawn 7 "")
assert_contains "$out" "live swe run" "a respawn inside the 90 s window is denied"
assert_eq "1" "$(q "SELECT COUNT(*) FROM agent_runs WHERE task_id=7;")" "the denied respawn opened no row"
backdate "$FIRST" 91
out=$(SPAWN_NOTE="$SPAWN_NOTE retry 2" spawn 7 "")
assert_not_contains "$out" '"deny"' "a respawn after 90 s passes"
assert_eq "swept_orphan|1" "$(q "SELECT exit_reason, completed_at IS NOT NULL FROM agent_runs WHERE spawn_id='$FIRST';")" "the first row swept_orphan"
assert_eq "1" "$(q "$OPEN_UNBOUND7")" "one open unbound swe row"

test_case "(i) PostToolUse(Agent) binds the spawn's row to tool_response.agentId"
reset7
spawn 7 tu-1 >/dev/null
bind 7 tu-1 ag-1
assert_eq "ag-1||" "$(q "SELECT spawn_id, COALESCE(completed_at, ''), COALESCE(exit_reason, '') FROM agent_runs WHERE task_id=7;")" "tu-1 bound to ag-1, still open"
assert_eq "ok" "$(brief 7 ag-1 toolu_brief6)" "the swe's task_brief"
assert_eq "1|ag-1" "$(q "SELECT COUNT(*), MAX(spawn_id) FROM agent_runs WHERE task_id=7;")" "task_brief keeps the one bound row"

test_case "(j) PermissionDenied(Agent) closes the refused spawn's row and returns the task to pending"
reset7
spawn 7 tu-1 >/dev/null
refuse 7 tu-1
assert_eq "swept_orphan|1|unmeasured" \
  "$(q "SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-1';")" \
  "tu-1 swept_orphan"
assert_eq "pending" "$(q "SELECT status FROM tasks WHERE id=7;")" "task 7 pending"

test_case "(k) a bound row an hour old is never closed by the sweep, PermissionDenied or SubagentStop"
reset7
q "UPDATE tasks SET status='running' WHERE id=7;
   INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, host)
   VALUES (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'), 'ag-1', 'claude');"
BOUND="SELECT COALESCE(completed_at, '') || '|' || COALESCE(exit_reason, '') FROM agent_runs WHERE spawn_id='ag-1';"
assert_contains "$(spawn 7 tu-9)" "live swe run" "require-task-spec still treats the bound row as live"
(cd "$REPO" && agent_event PreToolUse 7 tu-9 | bash "$PLUGIN_ROOT/scripts/hooks/record-swe-spawn.sh" >/dev/null 2>&1 || true)
assert_eq "|" "$(q "$BOUND")" "record-swe-spawn's sweep leaves ag-1 open"
refuse 7 tu-9
assert_eq "swept_orphan" "$(q "SELECT exit_reason FROM agent_runs WHERE spawn_id='tool_use:tu-9';")" "PermissionDenied closes tu-9"
assert_eq "|" "$(q "$BOUND")" "PermissionDenied leaves ag-1 open"
assert_eq "running" "$(q "SELECT status FROM tasks WHERE id=7;")" "an open bound run keeps the task running"
q "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, host) VALUES
     (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'), 'tool_use:tu-old', 'claude'),
     (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'ag-2', 'claude');"
stop 7 ag-2
assert_eq "subagent_stop" "$(q "SELECT usage_source FROM agent_runs WHERE spawn_id='ag-2';")" "SubagentStop metered ag-2"
assert_eq "swept_orphan|1|unmeasured" \
  "$(q "SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-old';")" \
  "SubagentStop sweeps the unbound tool_use row older than 90 s"
assert_eq "|" "$(q "$BOUND")" "SubagentStop leaves ag-1 open"

summarize
