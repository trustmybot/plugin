#!/usr/bin/env bash
# Tests for the agent_runs WRITE path of scripts/hooks/swe-atomic-close.sh (#685).
#
# Three regressions covered:
#   1. Idempotency — driving the hook twice for the SAME spawn (same
#      agent_transcript_path) produces exactly ONE agent_runs row; the second
#      SubagentStop UPDATEs the existing row instead of INSERTing a duplicate.
#   2. cache_read measure — the recorded cache_read_tokens is the spawn's own
#      high-water mark, NOT a per-message cumulative sum (which multicounts the
#      cached prefix into the tens of millions).
#   3. Attribution — the row lands on the task named by the transcript's
#      task_id=, never a same-batch sibling reached via the updated_at fallback.
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

# ---- Fixture: repo + two attached worktrees for two same-batch tasks -----
# Every git write targets the sandbox via `git -C "$REPO"` so cwd never leaks
# the bootstrap commit onto the caller's branch.
REPO="$TMPDIR/repo"
git init -q -b dev "$REPO"
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
echo init > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm init

DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL DEFAULT 1,
    branch_id TEXT NOT NULL,
    parent_branch_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    spec_body TEXT NOT NULL DEFAULT '',
    commit_sha TEXT,
    repo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE repos (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    issue_id INTEGER,
    agent_type TEXT NOT NULL DEFAULT 'swe',
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tokens_total INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    usage_baseline_json TEXT
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '\"\"'
  );
  -- task 137 + 138 are same-batch siblings. 138 sorts most-recent so the
  -- updated_at fallback would (wrongly) bind 137's spawn to 138.
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (137, 'fix/task-137', 'dev', 'completed', datetime('now', '-10 seconds'));
  INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (138, 'fix/task-138', 'dev', 'completed', datetime('now', '+10 seconds'));
  INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '\"dev\"');
"
export TRAJECTORY_DB_PATH="$DB"

run_hook() {
  (cd "$REPO" && echo "$1" | bash "$HOOK" 2>&1 || true)
}

# ---- Transcript for task 137's spawn ------------------------------------
# First message carries the spawn prompt with task_id=137. The cache-read
# field is CUMULATIVE: each successive message re-reports a larger cached
# prefix (200K → 17.2M → 18.4M). The spawn's own read is the max (18.4M-ish),
# NOT the sum (~35.8M).
TRANSCRIPT_137="$TMPDIR/transcript-137.jsonl"
cat > "$TRANSCRIPT_137" <<'JSONL'
{"timestamp":"2026-06-16T19:10:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=137 branch_id=fix/task-137 implement the thing"}]}}
{"timestamp":"2026-06-16T19:10:05.000Z","message":{"role":"assistant","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200000,"cache_creation_input_tokens":50000},"content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]}}
{"timestamp":"2026-06-16T19:10:30.000Z","message":{"role":"assistant","usage":{"input_tokens":2000,"output_tokens":800,"cache_read_input_tokens":17200000,"cache_creation_input_tokens":60000},"content":[{"type":"tool_use","id":"t2","name":"edit","input":{}}]}}
{"timestamp":"2026-06-16T19:10:55.000Z","message":{"role":"assistant","usage":{"input_tokens":3000,"output_tokens":900,"cache_read_input_tokens":18400000,"cache_creation_input_tokens":70000},"content":[]}}
JSONL

spawn_input() {
  jq -n --arg tp "$TRANSCRIPT_137" '{agent_type: "swe", agent_transcript_path: $tp, hook_event_name: "SubagentStop"}'
}

# ========================================================
# Idempotency: drive the hook twice for the same spawn
# ========================================================

test_case "first SubagentStop writes exactly one agent_runs row for task 137"
run_hook "$(spawn_input)" >/dev/null
COUNT_137=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=137;")
assert_eq "1" "$COUNT_137" "one row after first stop"

test_case "second SubagentStop for same spawn does NOT insert a duplicate"
run_hook "$(spawn_input)" >/dev/null
COUNT_137_AGAIN=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=137;")
assert_eq "1" "$COUNT_137_AGAIN" "still one row after second stop (idempotent)"

test_case "no row bled onto sibling task 138"
COUNT_138=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=138;")
assert_eq "0" "$COUNT_138" "sibling task 138 has zero rows"

# ========================================================
# cache_read measure: max cumulative, not per-message sum
# ========================================================

test_case "cache_read_tokens is the spawn's own high-water mark, not a sum"
CR_137=$(sqlite3 "$DB" "SELECT cache_read_tokens FROM agent_runs WHERE task_id=137 LIMIT 1;")
assert_eq "18400000" "$CR_137" "cache_read = max cumulative (18.4M), not sum (~35.8M)"

test_case "cache_creation_tokens is also the max, not a sum"
CC_137=$(sqlite3 "$DB" "SELECT cache_creation_tokens FROM agent_runs WHERE task_id=137 LIMIT 1;")
assert_eq "70000" "$CC_137" "cache_creation = max (70K), not sum (180K)"

test_case "tool_uses is the snapshot count of tool_use blocks"
TU_137=$(sqlite3 "$DB" "SELECT tool_uses FROM agent_runs WHERE task_id=137 LIMIT 1;")
assert_eq "2" "$TU_137" "tool_uses counts the two tool_use blocks"

test_case "tokens_in is the per-message sum (disjoint, correctly summed)"
TI_137=$(sqlite3 "$DB" "SELECT tokens_in FROM agent_runs WHERE task_id=137 LIMIT 1;")
assert_eq "6000" "$TI_137" "tokens_in = 1000+2000+3000"

# ========================================================
# Attribution: weak updated_at fallback must NOT bind a sibling
# ========================================================
# A transcript is present but carries NO task_id= token. The only reachable
# task is via the updated_at fallback (would pick 138). The hook must refuse
# to attribute, leaving 138 with zero rows.

TRANSCRIPT_NO_ID="$TMPDIR/transcript-no-id.jsonl"
cat > "$TRANSCRIPT_NO_ID" <<'JSONL'
{"timestamp":"2026-06-16T19:20:00.000Z","message":{"role":"user","content":[{"type":"text","text":"do the work, no id here"}]}}
{"timestamp":"2026-06-16T19:20:05.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":300000},"content":[]}}
JSONL

no_id_input() {
  jq -n --arg tp "$TRANSCRIPT_NO_ID" '{agent_type: "swe", agent_transcript_path: $tp, hook_event_name: "SubagentStop"}'
}

test_case "transcript without task_id + updated_at fallback → no sibling attribution"
run_hook "$(no_id_input)" >/dev/null
COUNT_138_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_runs WHERE task_id=138;")
assert_eq "0" "$COUNT_138_AFTER" "no agent_runs row written under ambiguous fallback"

summarize
