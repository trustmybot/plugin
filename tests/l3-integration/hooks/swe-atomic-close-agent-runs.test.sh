#!/usr/bin/env bash
# Tests for the agent_runs WRITE path of scripts/hooks/swe-atomic-close.sh.
#
#   1. Binding — the row lands on the task named by task_id=<N> in the spawn
#      prompt (plain-string or block content), for any task status; a spawn
#      with no task id writes an agent_runs_capture_skipped audit row and no
#      agent_runs row.
#   2. Status — a SWE that stops with commits while its task is running (the
#      spawn set it) auto-completes it; one that stops while its task is failed
#      gets metrics only.
#   3. One row per spawn — the row task_brief opened is UPDATEd (started_at
#      preserved); a re-fire with the same agent_id updates, never duplicates.
#   4. Measures — every token column is a per-message sum (the bro-row units).
#   5. Effort — a swe row carries its task's effort; a code-reviewer spawn gets
#      one metering row carrying plugin_config.reviewer_effort (high when unset).
#   6. No usage — a stop whose transcript yields no tokens closes its row
#      unmeasured and keeps any tokens an earlier stop metered.
#   7. Plugin version — an inserted swe or code-reviewer row carries the
#      manifest version, a later UPDATE leaves it, and with CLAUDE_PLUGIN_ROOT
#      unset the insert writes NULL (GH 1884).
#   8. Checkpoint (GH 1905) — a checkpoint written in the run keeps a committed
#      running task running and the swe-stop-cause recorder writes stop_cause
#      budget; an older checkpoint auto-completes and is cleared; without
#      dist/hooks.js the hook still completes.
#   9. Hook block (GH 1914) — a run whose last tool_result is a PreToolUse deny
#      and that made no completion report records stop_cause hook_block and bro
#      gets a sentence naming the block, commits or not; a successful completed
#      task_update_status call after the deny records no stop_cause.
#  10. Tool output (GH 1957) — a swe or code-reviewer stop writes one
#      agent_run_tool_output row per tool on its run, idempotently; without
#      dist/hooks.js it writes none.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-atomic-close.sh"
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/swe-atomic-close.sh"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-swe-atomic-close-agent-runs.XXXXXX")
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
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
PLUGIN_VERSION=$(jq -r .version "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json")

# Task 140 (running, as the spawn left it) has a commit in its worktree: the
# stop auto-completes it as it would a pending task.
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

test_case "a resumed spawn's duplicate unkeyed swe row is marked unmeasured, the metered row untouched"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES
    (150, 1, 'fix/task-150', 'dev', 'd', 'failed', '$NOW', '$NOW'),
    (151, 1, 'fix/task-151', 'dev', 'd', 'running', '$NOW', '$NOW');
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES
    (150, 1, 'swe', '2026-06-16T19:30:01.000Z', '2026-06-16T19:30:02.000Z'),
    (150, 1, 'swe', '2026-06-16T19:30:03.000Z', NULL);
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES
    (151, 1, 'swe', '2026-06-16T19:30:03.000Z', NULL);
"
T150="$TMPDIR/t150.jsonl"
transcript 150 "$T150"
run_hook "$(stop_input "$T150" agent-150)" >/dev/null
assert_eq "2" "$(runs 150)" "no third row"
assert_eq "1|40|4" "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(tokens_in), MAX(tokens_out) FROM agent_runs WHERE task_id=150 AND usage_source='subagent_stop';")" "exactly one row carries the transcript sums"
assert_eq "unmeasured|swept_orphan|1" \
  "$(sqlite3 "$DB" "SELECT usage_source, exit_reason, completed_at IS NOT NULL FROM agent_runs WHERE task_id=150 AND COALESCE(usage_source, '') <> 'subagent_stop';")" \
  "the other row is unmeasured, swept_orphan, closed"
assert_eq "|0" "$(sqlite3 "$DB" "SELECT COALESCE(usage_source, ''), completed_at IS NOT NULL FROM agent_runs WHERE task_id=151;")" "sibling task row unchanged"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=150 AND completed_at IS NOT NULL AND (usage_source IS NULL OR usage_source <> 'unmeasured') AND COALESCE(tokens_in, 0)=0 AND COALESCE(tokens_out, 0)=0 AND COALESCE(cache_read_tokens, 0)=0 AND COALESCE(cache_creation_tokens, 0)=0;")" "swe_runs_metered predicate returns 0"

test_case "a row already closed by a terminal status update still takes the spawn's metrics"
sqlite3 "$DB" "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES (141, 1, 'swe', '2026-06-16T19:30:01.000Z', '2026-06-16T19:30:03.000Z');"
T141="$TMPDIR/t141.jsonl"
transcript 141 "$T141"
run_hook "$(stop_input "$T141" agent-141)" >/dev/null
assert_eq "1" "$(runs 141)" "the closed task_brief row is reused, no duplicate"
assert_eq "40|agent-141" "$(sqlite3 "$DB" "SELECT tokens_in, spawn_id FROM agent_runs WHERE task_id=141;")" "metrics written"

test_case "a failed task gets metrics only — status unchanged"
assert_eq "failed" "$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=141;")" "still failed"

test_case "a running task with commits is auto-completed"
T140="$TMPDIR/t140.jsonl"
transcript 140 "$T140"
OUT=$(run_hook "$(stop_input "$T140" agent-140)")
assert_eq "" "$OUT" "no additionalContext"
assert_eq "completed|$(git -C "$REPO/.claude/worktrees/task-140" rev-parse HEAD)" \
  "$(sqlite3 "$DB" "SELECT status, COALESCE(commit_sha, '') FROM tasks WHERE id=140;")" "completed at the worktree HEAD"
assert_eq "1" "$(runs 140)" "metrics row written for the running task"

test_case "a running task with no commits stays running and bro is warned"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (145, 1, 'fix/task-145', 'dev', 'd', 'running', '$NOW', '$NOW');"
T145="$TMPDIR/t145.jsonl"
transcript 145 "$T145"
OUT=$(run_hook "$(stop_input "$T145" agent-145)")
assert_contains "$OUT" "stopped without committing" "warn-no-commits context"
assert_eq "running" "$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=145;")" "still running"

test_case "a stop with no usage in its transcript closes the row unmeasured (GH 1673)"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (146, 1, 'fix/task-146', 'dev', 'd', 'failed', '$NOW', '$NOW');
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (146, 1, 'swe', '2026-06-16T19:30:01.000Z', 'agent-146');"
T146_EMPTY="$TMPDIR/t146-empty.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id=146 You are swe."}}' > "$T146_EMPTY"
run_hook "$(stop_input "$T146_EMPTY" agent-146)" >/dev/null
assert_eq "1|unmeasured|failed|0|0" \
  "$(sqlite3 "$DB" "SELECT completed_at IS NOT NULL, usage_source, exit_reason, tokens_in, tokens_out FROM agent_runs WHERE task_id=146;")" \
  "closed, failed, unmeasured, zero tokens"

test_case "a later stop with no usage keeps the tokens and source an earlier stop metered"
T146="$TMPDIR/t146.jsonl"
transcript 146 "$T146"
run_hook "$(stop_input "$T146" agent-146)" >/dev/null
assert_eq "subagent_stop|40|4" "$(sqlite3 "$DB" "SELECT usage_source, tokens_in, tokens_out FROM agent_runs WHERE task_id=146;")" "metered"
run_hook "$(stop_input "$T146_EMPTY" agent-146)" >/dev/null
assert_eq "1|subagent_stop|40|4" \
  "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(usage_source), MAX(tokens_in), MAX(tokens_out) FROM agent_runs WHERE task_id=146;")" \
  "one row, metering kept"

test_case "a stop with no usage and no open row inserts an unmeasured row"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (147, 1, 'fix/task-147', 'dev', 'd', 'failed', '$NOW', '$NOW');"
T147="$TMPDIR/t147.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id=147 You are swe."}}' > "$T147"
run_hook "$(stop_input "$T147" agent-147)" >/dev/null
assert_eq "1|unmeasured" "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(usage_source) FROM agent_runs WHERE task_id=147;")" "one unmeasured row"

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
assert_eq "completed" "$(sqlite3 "$DB" "SELECT exit_reason FROM agent_runs WHERE task_id=140;")" "a spawn that auto-completes its task ends completed"
assert_eq "failed" "$(sqlite3 "$DB" "SELECT exit_reason FROM agent_runs WHERE task_id=145;")" "a spawn that stops on a running task without commits ends failed"
assert_eq "claude" "$(sqlite3 "$DB" "SELECT DISTINCT host FROM agent_runs WHERE task_id IS NOT NULL;")" "every spawn row carries host claude"

# ---- effort ------------------------------------------------------------------
test_case "a swe row carries its task's effort"
assert_eq "medium" "$(sqlite3 "$DB" "SELECT effort FROM agent_runs WHERE task_id=137;")" "task 137 defaults to medium"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, effort, created_at, updated_at) VALUES (144, 1, 'fix/task-144', 'dev', 'd', 'completed', 'high', '$NOW', '$NOW');"
T144="$TMPDIR/t144.jsonl"
transcript 144 "$T144"
run_hook "$(stop_input "$T144" agent-144)" >/dev/null
assert_eq "swe|high" "$(sqlite3 "$DB" "SELECT agent_type, effort FROM agent_runs WHERE task_id=144;")" "the swe row copies tasks.effort high"

# pr_stop_input <transcript> <agent_id>
pr_stop_input() {
  jq -n --arg tp "$1" --arg id "$2" \
    '{agent_type: "tmb:code-reviewer", agent_id: $id, session_id: "sess-1", agent_transcript_path: $tp, hook_event_name: "SubagentStop"}'
}
pr_runs() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=$1 AND agent_type='code-reviewer';"
}

test_case "a code-reviewer spawn gets one metering row carrying reviewer_effort (high when unset)"
TR1="$TMPDIR/tr1.jsonl"
printf '%s\n' \
  '{"type":"user","timestamp":"2026-06-16T19:50:00.000Z","message":{"role":"user","content":"task_id=144 commit_sha=abc1234 branch_id=fix/task-144 repo=plugin attempt_n=1 subagent_session_id=s"}}' \
  '{"type":"assistant","timestamp":"2026-06-16T19:50:09.000Z","message":{"id":"r1","model":"claude-opus-9","usage":{"input_tokens":70,"output_tokens":7},"content":[]}}' \
  > "$TR1"
run_hook "$(pr_stop_input "$TR1" agent-rev-1)" >/dev/null
assert_eq "1" "$(pr_runs 144)" "one code-reviewer row"
assert_eq "agent-rev-1|70|7|subagent_stop|claude-opus-9|claude|$(cd "$REPO" && pwd -P)|completed|high|2026-06-16T19:50:00.000Z" \
  "$(sqlite3 "$DB" "SELECT spawn_id, tokens_in, tokens_out, usage_source, model, host, root_dir, exit_reason, effort, started_at FROM agent_runs WHERE task_id=144 AND agent_type='code-reviewer';")" \
  "metered, root_dir = the project root, effort = reviewer_effort default high"
assert_eq "completed|" "$(sqlite3 "$DB" "SELECT status, COALESCE(commit_sha, '') FROM tasks WHERE id=144;")" "no task status side effect"

test_case "a code-reviewer re-fire updates its row in place"
run_hook "$(pr_stop_input "$TR1" agent-rev-1)" >/dev/null
assert_eq "1" "$(pr_runs 144)" "still one code-reviewer row"

test_case "a configured reviewer_effort lands on the next code-reviewer row"
sqlite3 "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '\"medium\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;"
run_hook "$(pr_stop_input "$TR1" agent-rev-2)" >/dev/null
assert_eq "high
medium" "$(sqlite3 "$DB" "SELECT effort FROM agent_runs WHERE task_id=144 AND agent_type='code-reviewer' ORDER BY id;")" "the earlier row keeps high, the new one carries medium"

test_case "an unbound code-reviewer spawn writes nothing"
TOTAL_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs;")
run_hook "$(pr_stop_input "$TRANSCRIPT_NO_ID" agent-rev-noid)" >/dev/null
assert_eq "$TOTAL_BEFORE" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs;")" "no agent_runs row"
assert_eq "1" "$(skipped)" "no capture-skipped audit row for a code-reviewer"

# ---- plugin_version (GH 1884) -------------------------------------------------
OTHER_ROOT="$TMPDIR/other-plugin"
mkdir -p "$OTHER_ROOT/.claude-plugin"
echo '{"name":"tmb","version":"0.0.1-other"}' > "$OTHER_ROOT/.claude-plugin/plugin.json"

test_case "an inserted swe row carries the manifest plugin_version; a later UPDATE leaves it"
assert_eq "$PLUGIN_VERSION" "$(sqlite3 "$DB" "SELECT plugin_version FROM agent_runs WHERE task_id=144 AND agent_type='swe';")" "swe insert"
CLAUDE_PLUGIN_ROOT="$OTHER_ROOT" run_hook "$(stop_input "$T144" agent-144)" >/dev/null
assert_eq "1|$PLUGIN_VERSION" \
  "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(plugin_version) FROM agent_runs WHERE task_id=144 AND agent_type='swe';")" \
  "the re-fire under another version updates the row and keeps its plugin_version"
assert_eq "" "$(sqlite3 "$DB" "SELECT COALESCE(plugin_version, '') FROM agent_runs WHERE task_id=142;")" "the UPDATE of a row opened without a version writes none"

test_case "an inserted code-reviewer row carries the manifest plugin_version; a re-fire leaves it"
assert_eq "$PLUGIN_VERSION" "$(sqlite3 "$DB" "SELECT plugin_version FROM agent_runs WHERE spawn_id='agent-rev-1';")" "code-reviewer insert"
CLAUDE_PLUGIN_ROOT="$OTHER_ROOT" run_hook "$(pr_stop_input "$TR1" agent-rev-1)" >/dev/null
assert_eq "1|$PLUGIN_VERSION" \
  "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(plugin_version) FROM agent_runs WHERE spawn_id='agent-rev-1';")" \
  "the re-fire under another version keeps it"

test_case "with CLAUDE_PLUGIN_ROOT unset the insert still succeeds and writes NULL"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (148, 1, 'fix/task-148', 'dev', 'd', 'completed', '$NOW', '$NOW');"
T148="$TMPDIR/t148.jsonl"
transcript 148 "$T148"
(unset CLAUDE_PLUGIN_ROOT; run_hook "$(stop_input "$T148" agent-148)" >/dev/null)
assert_eq "1|40|1" \
  "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(tokens_in), MAX(plugin_version IS NULL) FROM agent_runs WHERE task_id=148;")" \
  "one metered row, plugin_version NULL"

# ---- checkpoint handback and stop_cause (GH 1905) -----------------------------
# committed_task <task_id>: a running task whose worktree carries one commit.
committed_task() {
  sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES ($1, 1, 'fix/task-$1', 'dev', 'd', 'running', '$NOW', '$NOW');"
  git -C "$REPO" branch "fix/task-$1" dev
  git -C "$REPO" worktree add -q "$REPO/.claude/worktrees/task-$1" "fix/task-$1"
  (cd "$REPO/.claude/worktrees/task-$1" && echo "c$1" > "c$1.txt" && git add "c$1.txt" && git commit -qm "feat: c$1")
}

test_case "a checkpoint from this run plus commits keeps the task running and records stop_cause budget"
committed_task 160
sqlite3 "$DB" "UPDATE tasks SET checkpoint = json_object('done', 'half', 'left', 'rest', 'files', json_array('a.ts'), 'at', '2026-06-16T19:30:02.000Z') WHERE id=160;"
T160="$TMPDIR/t160.jsonl"
transcript 160 "$T160"
OUT=$(run_hook "$(stop_input "$T160" agent-160)")
assert_contains "$OUT" "handed back a checkpoint" "checkpoint context for bro"
assert_contains "$OUT" "task_brief.checkpoint" "context points at task_brief.checkpoint"
assert_eq "running|1" "$(sqlite3 "$DB" "SELECT status, checkpoint IS NOT NULL FROM tasks WHERE id=160;")" "still running, checkpoint kept"
assert_eq "budget||failed" "$(sqlite3 "$DB" "SELECT stop_cause, COALESCE(stop_detail, ''), exit_reason FROM agent_runs WHERE task_id=160;")" "the spawn row records budget"

test_case "an older checkpoint plus commits auto-completes and clears the checkpoint"
committed_task 161
sqlite3 "$DB" "UPDATE tasks SET checkpoint = json_object('done', 'half', 'left', 'rest', 'files', json_array(), 'at', '2026-06-16T19:00:00.000Z') WHERE id=161;"
T161="$TMPDIR/t161.jsonl"
transcript 161 "$T161"
OUT=$(run_hook "$(stop_input "$T161" agent-161)")
assert_eq "" "$OUT" "no additionalContext"
assert_eq "completed|$(git -C "$REPO/.claude/worktrees/task-161" rev-parse HEAD)|1" \
  "$(sqlite3 "$DB" "SELECT status, COALESCE(commit_sha, ''), checkpoint IS NULL FROM tasks WHERE id=161;")" \
  "completed at the worktree HEAD, checkpoint NULL"
assert_eq "|completed" "$(sqlite3 "$DB" "SELECT COALESCE(stop_cause, ''), exit_reason FROM agent_runs WHERE task_id=161;")" "no stop_cause"

# ---- a run that ends on a hook block with no completion report (GH 1914) -----
BLOCK_DENY='PreToolUse:Bash hook error: BLOCKED: write target "python3" cannot be judged; use Edit or Write on the literal path.'
BLOCK_SENTENCE="ended on a hook block with no completion report"

# deny_transcript <task_id> <file> [report]: the spawn's last tool_result is a
# PreToolUse:Bash deny; with "report", a successful task_update_status
# completed call follows it.
deny_transcript() {
  {
    printf '%s\n' \
      '{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id='"$1"' You are swe."}}' \
      '{"type":"assistant","timestamp":"2026-06-16T19:30:04.000Z","message":{"id":"m1","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tb1","name":"Bash","input":{"command":"python3 x.py"}}]}}'
    jq -cn --arg d "$BLOCK_DENY" \
      '{type:"user",timestamp:"2026-06-16T19:30:05.000Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"tb1",is_error:true,content:$d}]}}'
    if [ "${3:-}" = "report" ]; then
      printf '%s\n' \
        '{"type":"assistant","timestamp":"2026-06-16T19:30:06.000Z","message":{"id":"m2","usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"tool_use","id":"tr1","name":"mcp__plugin_tmb_trajectory-server__task_update_status","input":{"agent":"swe","task_id":"'"$1"'","status":"completed"}}]}}' \
        '{"type":"user","timestamp":"2026-06-16T19:30:07.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tr1","content":"{\"ok\":true}"}]}}'
    fi
  } > "$2"
}

test_case "a deny with no report and no commits records hook_block and names the block beside the no-commit warning"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (170, 1, 'fix/task-170', 'dev', 'd', 'running', '$NOW', '$NOW');"
T170="$TMPDIR/t170.jsonl"
deny_transcript 170 "$T170"
OUT=$(run_hook "$(stop_input "$T170" agent-170)")
assert_eq "hook_block|1" \
  "$(sqlite3 "$DB" "SELECT stop_cause, substr(stop_detail, 1, length('$BLOCK_DENY')) = '$BLOCK_DENY' FROM agent_runs WHERE task_id=170;")" \
  "stop_cause hook_block, stop_detail starts with the deny"
CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null || true)
assert_contains "$CTX" "stopped without committing" "the no-commit warning stays"
assert_contains "$CTX" "SWE for task #170 $BLOCK_SENTENCE" "the hook-block sentence follows it"
assert_contains "$CTX" "PreToolUse:Bash hook error: BLOCKED" "the sentence quotes the deny"
assert_contains "$CTX" "task_brief.last_stop" "the sentence points at task_brief.last_stop"
assert_contains "$CTX" "rework spawn_note" "the sentence asks bro to name the block in the spawn_note"

test_case "a deny with no report and commits auto-completes and still names the block"
committed_task 171
T171="$TMPDIR/t171.jsonl"
deny_transcript 171 "$T171"
OUT=$(run_hook "$(stop_input "$T171" agent-171)")
assert_eq "completed" "$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=171;")" "the task auto-completes"
assert_eq "hook_block" "$(sqlite3 "$DB" "SELECT stop_cause FROM agent_runs WHERE task_id=171;")" "stop_cause hook_block"
CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null || true)
assert_contains "$CTX" "SWE for task #171 $BLOCK_SENTENCE" "the context names the block"

test_case "a deny followed by a successful completed report records no stop_cause and no hook-block sentence"
committed_task 172
T172="$TMPDIR/t172.jsonl"
deny_transcript 172 "$T172" report
OUT=$(run_hook "$(stop_input "$T172" agent-172)")
assert_eq "" "$(sqlite3 "$DB" "SELECT COALESCE(stop_cause, '') FROM agent_runs WHERE task_id=172;")" "stop_cause NULL"
assert_not_contains "$OUT" "$BLOCK_SENTENCE" "no hook-block sentence"

if [ "$HOOK_IMPL" != ts ]; then
test_case "with dist/hooks.js absent the hook still completes"
BARE_ROOT="$TMPDIR/bare-plugin"
mkdir -p "$BARE_ROOT"
cp -R "$PLUGIN_ROOT/scripts" "$BARE_ROOT/scripts"
assert_eq "absent" "$([ -e "$BARE_ROOT/mcp/trajectory-server/dist/hooks.js" ] && echo present || echo absent)" "no dist/hooks.js beside the copied hook"
committed_task 162
T162="$TMPDIR/t162.jsonl"
transcript 162 "$T162"
set +e
(cd "$REPO" && stop_input "$T162" agent-162 | bash "$BARE_ROOT/scripts/hooks/swe-atomic-close.sh" >/dev/null 2>&1)
BARE_RC=$?
set -e
assert_eq "0" "$BARE_RC" "the hook exits 0"
assert_eq "completed" "$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=162;")" "the task auto-completes"
assert_eq "1|40|" "$(sqlite3 "$DB" "SELECT COUNT(*), MAX(tokens_in), COALESCE(MAX(stop_cause), '') FROM agent_runs WHERE task_id=162;")" "the row is metered, no stop_cause written"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.task_id=162;")" "no tool-output rows without dist/hooks.js"
fi

# tool_transcript <task_id> <file> <prompt-suffix>: a spawn that calls Read and
# Bash and gets a 10-char and a 5-char result back.
tool_transcript() {
  printf '%s\n' \
    '{"type":"user","timestamp":"2026-06-16T19:40:00.000Z","message":{"role":"user","content":"task_id='"$1"' '"$3"'"}}' \
    '{"type":"assistant","timestamp":"2026-06-16T19:40:01.000Z","message":{"id":"m1","model":"claude-opus-9","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tu_r","name":"Read","input":{}}]}}' \
    '{"type":"user","timestamp":"2026-06-16T19:40:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_r","content":"0123456789"}]}}' \
    '{"type":"assistant","timestamp":"2026-06-16T19:40:03.000Z","message":{"id":"m2","model":"claude-opus-9","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tu_b","name":"Bash","input":{}}]}}' \
    '{"type":"user","timestamp":"2026-06-16T19:40:04.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_b","content":[{"type":"text","text":"abcde"}]}]}}' \
    > "$2"
}
tool_rows() {
  sqlite3 "$DB" "SELECT o.tool_name || ':' || o.calls || ':' || o.result_chars || ':' || o.est_tokens FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.task_id=$1 AND r.agent_type='$2' ORDER BY o.tool_name;"
}

test_case "a swe stop records its run's per-tool result sizes in agent_run_tool_output (GH 1957)"
committed_task 180
T180="$TMPDIR/t180.jsonl"
tool_transcript 180 "$T180" "You are swe."
run_hook "$(stop_input "$T180" agent-180)" >/dev/null
assert_eq "Bash:1:5:2
Read:1:10:3" "$(tool_rows 180 swe)" "one row per tool on the swe run"
run_hook "$(stop_input "$T180" agent-180)" >/dev/null
assert_eq "Bash:1:5:2
Read:1:10:3" "$(tool_rows 180 swe)" "a re-fire rewrites the rows, no duplicates"

test_case "a code-reviewer stop records its run's per-tool result sizes (GH 1957)"
TR180="$TMPDIR/tr180.jsonl"
tool_transcript 180 "$TR180" "commit_sha=abc1234 branch_id=fix/task-180 repo=plugin attempt_n=1"
run_hook "$(pr_stop_input "$TR180" agent-rev-180)" >/dev/null
assert_eq "Bash:1:5:2
Read:1:10:3" "$(tool_rows 180 code-reviewer)" "one row per tool on the code-reviewer run"
assert_eq "Bash:1:5:2
Read:1:10:3" "$(tool_rows 180 swe)" "the swe run's rows are untouched"

summarize
