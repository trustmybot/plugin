#!/usr/bin/env bash
# Tests for the agent_runs WRITE path of scripts/hooks/swe-atomic-close.sh.
#
#   1. Binding — the row lands on the task named by task_id=<N> in the spawn
#      prompt (plain-string or block content), for any task status; a spawn
#      with no task id writes an agent_runs_capture_skipped audit row and no
#      agent_runs row.
#   2. Status — a SWE that stops while its task is running or failed gets
#      metrics only, never an auto-complete.
#   3. One row per spawn — the row task_brief opened is UPDATEd (started_at
#      preserved); a re-fire with the same agent_id updates, never duplicates.
#   4. Measures — every token column is a per-message sum (the bro-row units).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Step out of the plugin checkout before any git work so a stray bare git call
# can never touch the caller's branch, then assert the move stuck. Every commit
# below targets its sandbox via `git -C "$REPO"`; this is belt-and-suspenders.
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

REPO="$TMPDIR/repo"
git init -q -b dev "$REPO"
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
echo init > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm init

# The real schema, so FKs, CHECKs and the (task_id, spawn_id) index apply.
DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-06-16T19:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'metering', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES
    (137, 1, 'fix/task-137', 'dev', 'd', 'completed', '$NOW', '$NOW'),
    (138, 1, 'fix/task-138', 'dev', 'd', 'completed', '$NOW', '2026-06-16T19:59:00.000Z'),
    (140, 1, 'fix/task-140', 'dev', 'd', 'running',   '$NOW', '$NOW'),
    (141, 1, 'fix/task-141', 'dev', 'd', 'failed',    '$NOW', '$NOW'),
    (142, 1, 'fix/task-142', 'dev', 'd', 'pending',   '$NOW', '$NOW');
"
export TRAJECTORY_DB_PATH="$DB"

# Task 140 (running) has a commit in its worktree: a pending task would be
# auto-completed, a running one must not be.
git -C "$REPO" branch fix/task-140 HEAD
git -C "$REPO" worktree add -q "$REPO/.claude/worktrees/task-140" fix/task-140
(cd "$REPO/.claude/worktrees/task-140" && echo w > w.txt && git add w.txt && git commit -qm "feat: w")

run_hook() {
  (cd "$REPO" && echo "$1" | bash "$HOOK" 2>&1 || true)
}

# stop_input <transcript> <agent_id>
stop_input() {
  jq -n --arg tp "$1" --arg id "$2" \
    '{agent_type: "tmb:swe", agent_id: $id, session_id: "sess-1", agent_transcript_path: $tp, hook_event_name: "SubagentStop"}'
}

# transcript <task_id> <file>: a two-message spawn with plain-string prompt content.
transcript() {
  printf '%s\n' \
    '{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id='"$1"' You are swe."}}' \
    '{"type":"assistant","timestamp":"2026-06-16T19:30:04.000Z","message":{"id":"m1","usage":{"input_tokens":40,"output_tokens":4},"content":[]}}' \
    > "$2"
}

runs() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=$1;"
}

skipped() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='agent_runs_capture_skipped' AND from_node='hook:swe-atomic-close' AND issue_id=-1;"
}

# ---- Transcript for task 137 (block content, cumulative cache) -------------
TRANSCRIPT_137="$TMPDIR/transcript-137.jsonl"
cat > "$TRANSCRIPT_137" <<'JSONL'
{"timestamp":"2026-06-16T19:10:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=137 branch_id=fix/task-137 implement the thing"}]}}
{"timestamp":"2026-06-16T19:10:05.000Z","message":{"id":"a","role":"assistant","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200000,"cache_creation_input_tokens":50000},"content":[{"type":"text","text":"thinking"}]}}
{"timestamp":"2026-06-16T19:10:05.000Z","message":{"id":"a","role":"assistant","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200000,"cache_creation_input_tokens":50000},"content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]}}
{"timestamp":"2026-06-16T19:10:30.000Z","message":{"id":"b","role":"assistant","usage":{"input_tokens":2000,"output_tokens":800,"cache_read_input_tokens":17200000,"cache_creation_input_tokens":60000},"content":[{"type":"tool_use","id":"t2","name":"edit","input":{}}]}}
{"timestamp":"2026-06-16T19:10:55.000Z","message":{"id":"c","role":"assistant","usage":{"input_tokens":3000,"output_tokens":900,"cache_read_input_tokens":18400000,"cache_creation_input_tokens":70000},"content":[]}}
JSONL

test_case "first SubagentStop writes exactly one agent_runs row for task 137"
run_hook "$(stop_input "$TRANSCRIPT_137" agent-137)" >/dev/null
assert_eq "1" "$(runs 137)" "one row after first stop"
assert_eq "swe|agent-137|sess-1|subagent_stop|2026-06-16T19:10:00.000Z|1" \
  "$(sqlite3 "$DB" "SELECT agent_type, spawn_id, session_id, usage_source, started_at, issue_id FROM agent_runs WHERE task_id=137;")" \
  "spawn_id = agent_id; started_at = first transcript timestamp"

test_case "re-fire with the same agent_id updates the row, never duplicates"
run_hook "$(stop_input "$TRANSCRIPT_137" agent-137)" >/dev/null
assert_eq "1" "$(runs 137)" "still one row after second stop"

test_case "no row bled onto sibling task 138"
assert_eq "0" "$(runs 138)" "sibling task 138 has zero rows"

test_case "tokens_in/out are summed once per message (split content-block lines dedupe)"
assert_eq "6000|2200" "$(sqlite3 "$DB" "SELECT tokens_in, tokens_out FROM agent_runs WHERE task_id=137;")" "in = 1000+2000+3000, out = 500+800+900"

test_case "cache_read / cache_creation are per-message sums (split content-block lines dedupe)"
assert_eq "35800000|180000" "$(sqlite3 "$DB" "SELECT cache_read_tokens, cache_creation_tokens FROM agent_runs WHERE task_id=137;")" "200K+17.2M+18.4M and 50K+60K+70K"

test_case "tool_uses counts the tool_use blocks"
assert_eq "2" "$(sqlite3 "$DB" "SELECT tool_uses FROM agent_runs WHERE task_id=137;")" "two tool_use blocks"

# ---- task_brief-opened row is UPDATEd, started_at preserved --------------
test_case "the swe row task_brief opened is UPDATEd with started_at preserved"
sqlite3 "$DB" "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (142, 1, 'swe', '2026-06-16T19:30:01.000Z');"
OPENED_ID=$(sqlite3 "$DB" "SELECT MAX(id) FROM agent_runs;")
T142="$TMPDIR/t142.jsonl"
transcript 142 "$T142"
run_hook "$(stop_input "$T142" agent-142)" >/dev/null
assert_eq "1" "$(runs 142)" "no second row"
assert_eq "${OPENED_ID}|2026-06-16T19:30:01.000Z|agent-142|40|4|subagent_stop" \
  "$(sqlite3 "$DB" "SELECT id, started_at, spawn_id, tokens_in, tokens_out, usage_source FROM agent_runs WHERE task_id=142;")" \
  "same row, started_at kept, metrics + spawn_id written"
assert_eq "1" "$(sqlite3 "$DB" "SELECT completed_at IS NOT NULL FROM agent_runs WHERE task_id=142;")" "row closed"

test_case "a row already closed by a terminal status update still takes the spawn's metrics"
sqlite3 "$DB" "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES (141, 1, 'swe', '2026-06-16T19:30:01.000Z', '2026-06-16T19:30:03.000Z');"
T141="$TMPDIR/t141.jsonl"
transcript 141 "$T141"
run_hook "$(stop_input "$T141" agent-141)" >/dev/null
assert_eq "1" "$(runs 141)" "the closed task_brief row is reused, no duplicate"
assert_eq "40|agent-141" "$(sqlite3 "$DB" "SELECT tokens_in, spawn_id FROM agent_runs WHERE task_id=141;")" "metrics written"

test_case "a failed task gets metrics only — status unchanged"
assert_eq "failed" "$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=141;")" "still failed"

test_case "a running task with commits gets metrics only — no auto-complete"
T140="$TMPDIR/t140.jsonl"
transcript 140 "$T140"
OUT=$(run_hook "$(stop_input "$T140" agent-140)")
assert_eq "" "$OUT" "no additionalContext"
assert_eq "running|" "$(sqlite3 "$DB" "SELECT status, COALESCE(commit_sha, '') FROM tasks WHERE id=140;")" "running, no commit_sha"
assert_eq "1" "$(runs 140)" "metrics row written for the running task"

# ---- no task id → capture-skipped audit row, no agent_runs write --------
TRANSCRIPT_NO_ID="$TMPDIR/transcript-no-id.jsonl"
cat > "$TRANSCRIPT_NO_ID" <<'JSONL'
{"timestamp":"2026-06-16T19:20:00.000Z","message":{"role":"user","content":"do the work, no id here"}}
{"timestamp":"2026-06-16T19:20:05.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":300000},"content":[]}}
JSONL

test_case "transcript without task_id → capture-skipped audit row, no agent_runs write"
TOTAL_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs;")
run_hook "$(stop_input "$TRANSCRIPT_NO_ID" agent-noid)" >/dev/null
assert_eq "1" "$(skipped)" "one agent_runs_capture_skipped audit row"
assert_eq "$TOTAL_BEFORE" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs;")" "no agent_runs row"
assert_eq "0" "$(runs 138)" "the most recently updated sibling is not guessed"
assert_contains "$(sqlite3 "$DB" "SELECT content_json FROM audit WHERE event_type='agent_runs_capture_skipped';")" '"spawn_id":"agent-noid"' "audit row names the spawn"

test_case "foreign keys stay clean"
assert_eq "" "$(sqlite3 "$DB" "PRAGMA foreign_key_check;")" "foreign_key_check empty"

test_case "the spawn row carries the dominant model, host, worktree root_dir and exit_reason"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (143, 1, 'fix/task-143', 'dev', 'd', 'completed', '$NOW', '$NOW');"
T143="$TMPDIR/t143.jsonl"
printf '%s\n' \
  '{"type":"user","timestamp":"2026-06-16T19:40:00.000Z","message":{"role":"user","content":"task_id=143 You are swe."}}' \
  '{"type":"assistant","timestamp":"2026-06-16T19:40:01.000Z","message":{"id":"x1","model":"claude-small-1","usage":{"input_tokens":10,"output_tokens":1},"content":[]}}' \
  '{"type":"assistant","timestamp":"2026-06-16T19:40:02.000Z","message":{"id":"x2","model":"claude-big-9","usage":{"input_tokens":900,"output_tokens":1},"content":[]}}' \
  '{"type":"assistant","timestamp":"2026-06-16T19:40:03.000Z","message":{"id":"x3","model":"<synthetic>","usage":{"input_tokens":5000,"output_tokens":0},"content":[]}}' \
  > "$T143"
run_hook "$(stop_input "$T143" agent-143)" >/dev/null
assert_eq "claude-big-9|claude|$(cd "$REPO" && pwd -P)/.claude/worktrees/task-143|completed" \
  "$(sqlite3 "$DB" "SELECT model, host, root_dir, exit_reason FROM agent_runs WHERE task_id=143;")" \
  "model by tokens (<synthetic> ignored); root_dir = the task worktree; a completed task ends completed"
assert_eq "failed" "$(sqlite3 "$DB" "SELECT exit_reason FROM agent_runs WHERE task_id=140;")" "a spawn that stops on a running task ends failed"
assert_eq "claude" "$(sqlite3 "$DB" "SELECT DISTINCT host FROM agent_runs WHERE task_id IS NOT NULL;")" "every spawn row carries host claude"

summarize
