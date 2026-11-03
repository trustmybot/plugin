#!/usr/bin/env bash
# Tests for the TypeScript agent-spawn-dispatch gate
#
# Dispatcher contract:
#   - Runs the nine Agent-spawn gate hooks in order.
#   - Short-circuits on the first deny: emits that deny verbatim and exits.
#   - On full pass: emits union of any additionalContext blocks (currently
#     none of the nine produce context, but the merge path is exercised).
#   - A non-deny, non-context output from any hook is ignored.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCHER="$PLUGIN_ROOT/tests/lib/ts-hooks/agent-spawn-dispatch.sh"
TMB_TEST_NODE="$(node -p process.execPath)"
export TMB_TEST_NODE

# ----- fixture helpers ------------------------------------------------------

# Create an isolated trajectory DB with a tasks table.
setup_db() {
  local dir="$1"
  local db="$dir/trajectory.db"
  sqlite3 "$db" "
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL DEFAULT 1,
      branch_id TEXT NOT NULL DEFAULT 'fix/test',
      status TEXT NOT NULL,
      spec_body TEXT NOT NULL DEFAULT '',
      files TEXT
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      objective TEXT NOT NULL DEFAULT 'test',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    INSERT INTO issues (id) VALUES (1);
  "
  echo "$db"
}

# Insert a task row.
insert_task() {
  local db="$1" task_id="$2" status="$3" branch_id="$4" spec_body="${5:-## body}"
  sqlite3 "$db" "
    INSERT INTO tasks (id, issue_id, branch_id, status, spec_body)
      VALUES ($task_id, 1, '$branch_id', '$status', '$spec_body');
  " >/dev/null
}

# Create a minimal git repo with an optional branch.
setup_repo() {
  local dir="$1" base_branch="${2:-dev}" extra_branch="${3:-}"
  (
    cd "$dir" || exit 1
    git init -q -b "$base_branch"
    git config user.email "test@example.com"
    git config user.name  "Test"
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
    [ -n "$extra_branch" ] && git branch "$extra_branch"
  )
}

run_dispatcher() {
  local payload="$1"
  local db="${2:-/nonexistent.db}"
  local extra_env="${3:-}"
  (
    if [ -n "$extra_env" ]; then
      eval "export $extra_env"
    fi
    printf '%s' "$payload" | TRAJECTORY_DB_PATH="$db" bash "$DISPATCHER" 2>/dev/null
  ) || true
}

# ----- tests: first-deny short-circuit (require-task-spec) ------------------

test_case "swe spawn without task_id is denied with require-task-spec wording"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
db=$(setup_db "$WORK")
insert_task "$db" 1 "pending" "fix/1-foo" "## spec"
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"swe",prompt:"do the thing"}}')
out=$(run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "SWE spawn requires task_id" "require-task-spec wording present"
rm -rf "$WORK"

# ----- tests: first-deny short-circuit (code-reviewer-spawn-prompt-shape) -----

test_case "code-reviewer spawn with missing anchors is denied"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
db=$(setup_db "$WORK")
insert_task "$db" 5 "closed" "fix/5-pr" "## spec"
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",effort:"high",prompt:"please review this PR"}}')
out=$(TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1 run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "missing required anchors" "prompt-shape wording present"
rm -rf "$WORK"

# ----- tests: code-reviewer-spawn-note caps the prose beyond the anchors -------

test_case "code-reviewer spawn with the seven anchors and over 300 chars of prose is denied naming spawn_note"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
db=$(setup_db "$WORK")
insert_task "$db" 5 "closed" "fix/5-pr" "## spec"
anchors="task_id=5 commit_sha=abc1234 branch_id=fix/5-pr repo=plugin repo_path=/work/plugin attempt_n=1 subagent_session_id=sess-xyz"
prose=$(printf 'Context the reviewer could read from task_brief. %.0s' 1 2 3 4 5 6 7 8)
payload=$(jq -n --arg p "$anchors $prose" '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",effort:"high",prompt:$p}}')
out=$(TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1 TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1 run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "spawn_note" "spawn-note wording present"
payload=$(jq -n --arg p "$anchors Focus on the migration." '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",effort:"high",prompt:$p}}')
out=$(TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1 TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1 run_dispatcher "$payload" "$db")
assert_not_contains "$out" "spawn_note" "anchors plus a short line pass the spawn-note gate"
rm -rf "$WORK"

# ----- tests: shape hook enforces attempt_n + subagent_session_id anchors ----

SHAPE_HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/code-reviewer-spawn-prompt-shape.sh"

test_case "code-reviewer spawn with legacy four anchors but no attempt_n/subagent_session_id is denied"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "attempt_n" "missing attempt_n named"
assert_contains "$out" "subagent_session_id" "missing subagent_session_id named"

test_case "code-reviewer spawn without repo_path is denied naming repo_path"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin attempt_n=1 subagent_session_id=sess-xyz"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "anchors: repo_path." "missing repo_path named alone"

test_case "code-reviewer spawn with repo_path but no repo= is denied naming repo"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo_path=/work/plugin attempt_n=1 subagent_session_id=sess-xyz"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "anchors: repo." "missing repo named alone"

test_case "code-reviewer spawn with all seven anchors passes shape check silently"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin repo_path=/work/plugin attempt_n=1 subagent_session_id=sess-xyz"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_eq "" "$out" "silent pass — all seven anchors present"

# ----- tests: code-reviewer-no-worktree short-circuits before shape check -----

test_case "code-reviewer with isolation=worktree is denied before shape check (hook order preserved)"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
db=$(setup_db "$WORK")
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"code-reviewer",effort:"high",isolation:"worktree",prompt:"review"}}')
out=$(run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "must NOT run with isolation" "no-worktree wording present (fired before shape check)"
rm -rf "$WORK"

# ----- tests: clean swe spawn passes silently --------------------------------

test_case "clean swe spawn with valid task_id and existing branch passes silently"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
setup_repo "$WORK" "dev" "fix/1-foo"
git -C "$WORK" worktree add -q "$WORK/.claude/worktrees/1-foo" "fix/1-foo"
db="$WORK/trajectory.db"
sqlite3 "$db" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL DEFAULT 1,
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    spec_body TEXT NOT NULL DEFAULT '',
    repo TEXT,
    parent_branch_id TEXT,
    files TEXT,
    effort TEXT NOT NULL DEFAULT 'medium'
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE repos (name TEXT, path TEXT);
  CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, verdict TEXT, created_at TEXT);
  CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, task_id INTEGER, author TEXT, kind TEXT, created_at TEXT);
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_type TEXT, exit_reason TEXT, stop_cause TEXT, started_at TEXT);
  INSERT INTO repos (name, path) VALUES ('fixture', '$WORK');
  INSERT INTO issues (id) VALUES (1);
  INSERT INTO tasks (id, issue_id, branch_id, status, spec_body)
    VALUES (1, 1, 'fix/1-foo', 'pending', '## spec body');
" >/dev/null
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"swe",effort:"medium",prompt:"task_id=1 worktree=/some/path You are SWE."}}')
spawn() {
  (
    cd "$WORK" || exit 1
    printf '%s' "$payload" | TRAJECTORY_DB_PATH="$db" bash "$DISPATCHER" 2>/dev/null || true
  )
}
out=$(spawn)
assert_eq "" "$out" "silent pass — no deny, no context"

test_case "rework-limit: a swe spawn after two review FAILs is denied until a Human waiver"
sqlite3 "$db" "
  INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES
    (1, 'fail', '2026-10-25T10:01:00.000Z'), (1, 'fail', '2026-10-25T10:02:00.000Z');
" >/dev/null
out=$(spawn)
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "task FAILs: 2 review FAILs on the task since its last pass" "rework-limit names the task-FAILs limit"
assert_contains "$out" 'waive task 1' "rework-limit names the Human waiver"
sqlite3 "$db" "INSERT INTO discussions (issue_id, task_id, author, kind, created_at) VALUES (1, 1, 'bro', 'decision', '2026-10-25T11:00:00.000Z');" >/dev/null
out=$(spawn)
assert_contains "$out" '"permissionDecision":"deny"' "a newer bro decision keeps the spawn denied"
sqlite3 "$db" "INSERT INTO discussions (issue_id, task_id, author, kind, created_at) VALUES (1, 1, 'human', 'decision', '2026-10-25T12:00:00.000Z');" >/dev/null
out=$(spawn)
assert_not_contains "$out" '"permissionDecision":"deny"' "a newer Human decision lets the spawn through"
rm -rf "$WORK"

# ----- tests: non-Agent tool is a no-op ------------------------------------

test_case "non-Agent tool input passes silently (hooks self-filter)"
payload=$(jq -n '{tool_name:"Bash",tool_input:{command:"ls"}}')
out=$(run_dispatcher "$payload" "/nonexistent.db")
assert_eq "" "$out" "silent no-op for non-Agent tool"

# ----- tests: context union -------------------------------------------------

# stub_dispatch <stubs-json> — the real TypeScript dispatcher (dist) on '{}',
# with each gate named in <stubs-json> replaced by a stub printing its value and
# every other gate absent, so the shipped union and short-circuit are exercised.
stub_dispatch() {
  node --input-type=module -e '
    const [, mod, stubs] = process.argv;
    const { agentSpawnDispatch } = await import(mod);
    const table = JSON.parse(stubs);
    const find = (n) => (n in table ? () => ({ stdout: `${JSON.stringify(table[n])}\n`, code: 0 }) : undefined);
    process.stdout.write((await agentSpawnDispatch("{}", process.env, find)).stdout);
  ' "$PLUGIN_ROOT/mcp/trajectory-server/dist/hooks/agent-spawn-dispatch.js" "$1"
}

test_case "context union: real dispatcher merges additionalContext from gate hooks"
# First and last gate in the dispatcher's fixed order emit additionalContext;
# the union must carry both, separated.
out=$(stub_dispatch '{"require-task-spec":{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"part-A"}},
  "code-reviewer-after-atomic-close":{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"part-B"}}}' 2>/dev/null || true)
assert_contains "$out" "part-A" "first context part present"
assert_contains "$out" "part-B" "second context part present"
assert_contains "$out" "additionalContext" "result wrapped in additionalContext"

# ----- tests: deny short-circuits context collection -----------------------

test_case "deny in first gate short-circuits real dispatcher; later context not emitted"
# First gate denies; a later gate emits context that must never be reached.
out=$(stub_dispatch '{"require-task-spec":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: first hook denied"}},
  "require-feature-branch-active":{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"should-not-appear"}}}' 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny present"
assert_contains "$out" "first hook denied" "deny reason from first hook"
assert_not_contains "$out" "should-not-appear" "later gate context not emitted"

# ----- tests: tmb:code-reviewer passes every Agent-spawn gate (GH 1641) -------

test_case "tmb:code-reviewer spawn for a closed, verified task passes every Agent-spawn gate silently"
WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-agent-spawn-dispatch.XXXXXX")
mkdir -p "$WORK/repo"
setup_repo "$WORK/repo" dev fix/5-pr
git -C "$WORK/repo" checkout -q fix/5-pr
mkdir -p "$WORK/repo/changelog.d"
echo "- the change" > "$WORK/repo/changelog.d/5-pr.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" commit -qm "feature"
sha=$(git -C "$WORK/repo" rev-parse HEAD)
db="$WORK/trajectory.db"
sqlite3 "$db" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL,
    status TEXT NOT NULL, spec_body TEXT NOT NULL DEFAULT '', repo TEXT, parent_branch_id TEXT, files TEXT,
    commit_sha TEXT, effort TEXT NOT NULL DEFAULT 'medium');
  CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT NOT NULL DEFAULT 'test');
  CREATE TABLE repos (name TEXT, path TEXT, target_branch TEXT);
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE verification_runs (id INTEGER PRIMARY KEY, task_id INTEGER, commit_sha TEXT, exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, verdict TEXT, created_at TEXT);
  CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, task_id INTEGER, author TEXT, kind TEXT, created_at TEXT);
  INSERT INTO issues (id) VALUES (1);
  INSERT INTO repos (name, path, target_branch) VALUES ('plugin', '$WORK/repo', 'dev');
  INSERT INTO tasks (id, branch_id, status, repo, parent_branch_id, commit_sha) VALUES (5, 'fix/5-pr', 'closed', 'plugin', 'dev', '$sha');
  INSERT INTO verification_runs (task_id, commit_sha, exit_code) VALUES (5, '$sha', 0);
" >/dev/null
anchors="task_id=5 commit_sha=$sha branch_id=fix/5-pr repo=plugin repo_path=$WORK/repo attempt_n=1 subagent_session_id=sess-xyz"
payload=$(jq -n --arg p "$anchors" '{tool_name:"Agent",tool_input:{subagent_type:"tmb:code-reviewer",effort:"high",prompt:$p}}')
out=$(cd "$WORK/repo" && run_dispatcher "$payload" "$db")
assert_eq "" "$out" "no deny, no rewrite, no context for the canonical reviewer name"
sqlite3 "$db" "UPDATE tasks SET status = 'running' WHERE id = 5;"
out=$(cd "$WORK/repo" && run_dispatcher "$payload" "$db")
assert_contains "$out" "status=closed" "control: the same fixture with an open task is denied"
rm -rf "$WORK"

summarize
