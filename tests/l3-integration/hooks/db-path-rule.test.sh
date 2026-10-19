#!/usr/bin/env bash
# The one trajectory-DB location rule (docs/reference/TRAJECTORY_DB_LOCATION.md)
# across the hooks, and the fail-closed gate semantics that ride on it.
#
# Part A — the TMB workspace layout: DB at <ws>/.claude/tmb/trajectory.db, the
# repo at <ws>/plugin with its own .git, hooks running with cwd inside the
# repo. Every hook that used to carry a private copy of the path rule must
# resolve the workspace DB, both with CLAUDE_PROJECT_DIR=<ws> (step 2) and
# with CLAUDE_PROJECT_DIR unset (step 3, the outermost walk).
#
# Part B — every deny-capable gate: (a) DB unresolved → allow, (b) DB present
# but unreadable → deny with the "trajectory DB unavailable" reason, (c) the
# normal path still decides as before.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOKS="$PLUGIN_ROOT/scripts/hooks"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

BASE=$(cd "$(mktemp -d)" && pwd -P)
trap 'chmod -R u+rw "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT
unset CLAUDE_PROJECT_DIR TRAJECTORY_DB_PATH CLAUDE_PLUGIN_ROOT

FAKE_HOME="$BASE/home"
mkdir -p "$FAKE_HOME/.claude"

mkdir -p "$BASE/bin"
cat > "$BASE/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
echo 99999
STUB
chmod +x "$BASE/bin/pgrep"
LIVE_PATH="$BASE/bin:$PATH"

# schema <db>: the columns/tables the hooks under test read.
schema() {
  sqlite3 "$1" "
    CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT DEFAULT 'o', status TEXT DEFAULT 'open', repo TEXT, updated_at TEXT DEFAULT '2026-01-01');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER DEFAULT 1, branch_id TEXT, status TEXT, spec_body TEXT DEFAULT '## spec', repo TEXT, parent_branch_id TEXT, files TEXT, verification TEXT, prompt_bearing INTEGER DEFAULT 0, commit_sha TEXT);
    CREATE TABLE repos (name TEXT, path TEXT, target_branch TEXT, branching_model TEXT, protected_branches TEXT);
    CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER);
    CREATE TABLE agents (name TEXT, kind TEXT);
    CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, author TEXT, kind TEXT, body TEXT, created_at TEXT);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, from_node TEXT, event_type TEXT, summary TEXT, content_json TEXT, repo TEXT, created_at TEXT);
    CREATE TABLE validation_attempts (task_id TEXT, verdict TEXT);
    CREATE TABLE debug_trajectory (session_id TEXT, step_n INTEGER, kind TEXT, tool_or_mcp_name TEXT, args_json TEXT, created_at TEXT);
    INSERT INTO plugin_meta (schema_version) VALUES (30);
  " >/dev/null
}

git_init() {
  git -C "$1" init -q -b main
  git -C "$1" config user.email t@example.com
  git -C "$1" config user.name T
  echo x > "$1/README.md"
  git -C "$1" add README.md
  git -C "$1" commit -qm init
}

# ----------------------------------------------------------------------------
# Part A — TMB layout
# ----------------------------------------------------------------------------
WS="$BASE/ws"
REPO="$WS/plugin"
mkdir -p "$WS/.claude/tmb" "$REPO/src"
WS_DB="$WS/.claude/tmb/trajectory.db"
schema "$WS_DB"
git_init "$REPO"
ORIGIN="$BASE/origin.git"
git clone -q --bare "$REPO" "$ORIGIN"
git -C "$REPO" remote add origin "$ORIGIN"
git -C "$REPO" fetch -q origin
git -C "$REPO" branch feat/stale main
( cd "$REPO" && echo y >> README.md && git commit -qam ahead && git push -q origin main )
sqlite3 "$WS_DB" "
  INSERT INTO plugin_config VALUES ('onboarded', 'true');
  INSERT INTO issues (id, objective) VALUES (1, 'one'), (2, 'two'), (3, 'three');
  INSERT INTO repos (name, path, target_branch) VALUES ('plugin', '$REPO', 'main');
"

# run_ws <mode> <hook> <payload> [env...]: runs <hook> with cwd inside the repo.
# mode=root sets CLAUDE_PROJECT_DIR=<ws>; mode=walk leaves it unset and drops
# the test flags, under which the resolver never walks.
run_ws() {
  local mode="$1" hook="$2" payload="$3"
  shift 3
  local -a envs=(HOME="$FAKE_HOME")
  if [ "$mode" = "root" ]; then
    envs+=(CLAUDE_PROJECT_DIR="$WS")
  else
    envs=(-u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC "${envs[@]}")
  fi
  (cd "$REPO/src" && printf '%s' "$payload" | env "${envs[@]}" "$@" bash "$HOOKS/$hook" 2>/dev/null) || true
}

for MODE in root walk; do
  test_case "[$MODE] activation-routine reads the workspace DB"
  out=$(run_ws "$MODE" activation-routine.sh '{"prompt":"hey bro"}' PATH="$LIVE_PATH")
  assert_contains "$out" "onboarded=yes" "onboarded marker from the workspace DB"
  assert_contains "$out" "pending=#3" "pending issue from the workspace DB"

  test_case "[$MODE] branch-up-to-date-with-remote gates (was inert in this layout)"
  out=$(run_ws "$MODE" branch-up-to-date-with-remote.sh \
    "$(jq -nc --arg c "cd $REPO && git worktree add .claude/worktrees/s feat/stale" '{tool_name:"Bash",tool_input:{command:$c}}')")
  assert_contains "$out" '"permissionDecision":"deny"' "stale branch denied"
  assert_contains "$out" "behind origin/main" "behind-remote reason"

  test_case "[$MODE] no-worktree-branch-create gates (was inert in this layout)"
  out=$(run_ws "$MODE" no-worktree-branch-create.sh \
    '{"tool_name":"Bash","tool_input":{"command":"git worktree add -b feat/x .claude/worktrees/x"}}')
  assert_contains "$out" "cannot create a branch" "branch-create denied"

  test_case "[$MODE] debug-trajectory writes to the workspace DB"
  before=$(sqlite3 "$WS_DB" "SELECT COUNT(*) FROM debug_trajectory;")
  run_ws "$MODE" debug-trajectory.sh '{"tool_name":"Read","tool_input":{"file_path":"x"}}' \
    TMB_EVAL_MODE=1 TMB_DEBUG_TRAJECTORY=1 >/dev/null
  assert_eq "$((before + 1))" "$(sqlite3 "$WS_DB" "SELECT COUNT(*) FROM debug_trajectory;")" "one debug row in the workspace DB"

  test_case "[$MODE] no-source-edit-from-main guards the registered repo"
  out=$(run_ws "$MODE" no-source-edit-from-main.sh \
    "$(jq -nc --arg t "$REPO/src/main.ts" '{tool_name:"Write",tool_input:{file_path:$t}}')")
  assert_contains "$out" "source edits from the main checkout are denied" "main-checkout source edit denied"

  test_case "[$MODE] session-start-prescan reads the workspace DB"
  out=$(run_ws "$MODE" session-start-prescan.sh '{}' TMB_SKIP_AUTO_PRESCAN=1)
  assert_contains "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')" "Open issues:       3" "issue count from the workspace DB"

  test_case "[$MODE] mcp-health-check logs the workspace DB, beside it"
  WS_HEALTH_LOG="$(dirname "$WS_DB")/logs/mcp-health.log"
  rm -f "$WS_HEALTH_LOG"
  run_ws "$MODE" mcp-health-check.sh '{"hook_event_name":"SessionStart","session_id":"s"}' TMB_MCP_HEALTH_SAMPLES=1 >/dev/null
  assert_eq "$WS_DB" "$(tail -1 "$WS_HEALTH_LOG" | jq -r '.db_path')" "db_path logged"

  test_case "[$MODE] orphan-scan anchors on the workspace project"
  SLUG=$(printf '%s' "$WS" | sed -E 's/[^A-Za-z0-9]+/-/g')
  mkdir -p "$FAKE_HOME/.claude/projects/$SLUG"
  : > "$FAKE_HOME/.claude/projects/$SLUG/trajectory.db"
  out=$(run_ws "$MODE" orphan-scan.sh '{}' TMB_ORPHAN_SCAN_HOME="$FAKE_HOME" TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE=" ")
  assert_contains "$out" "stale trajectory DB (this project): $FAKE_HOME/.claude/projects/$SLUG/trajectory.db" "stale DB of the workspace project reported"
  rm -rf "$FAKE_HOME/.claude/projects"

  test_case "[$MODE] ensure-gitignore covers the registered repo, not the cwd"
  out=$(run_ws "$MODE" ensure-gitignore.sh '{}')
  assert_eq "" "$out" "no stdout"
  grep -qxF '.claude/' "$REPO/.gitignore" && _pass || _fail ".claude/ ignored in the repo"
done

test_case "[root] a nested repo DB does not shadow the project-root DB"
mkdir -p "$REPO/.claude/tmb"
schema "$REPO/.claude/tmb/trajectory.db"
out=$(run_ws root activation-routine.sh '{"prompt":"hey bro"}' PATH="$LIVE_PATH")
assert_contains "$out" "pending=#3" "still the workspace DB"
test_case "[walk] the outermost DB wins over a nested repo DB"
out=$(run_ws walk activation-routine.sh '{"prompt":"hey bro"}' PATH="$LIVE_PATH")
assert_contains "$out" "pending=#3" "outermost workspace DB"
rm -rf "$REPO/.claude"

test_case "[root] CLAUDE_PROJECT_DIR without a DB is unresolved (no walking)"
out=$( (cd "$REPO/src" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git worktree add -b feat/x .claude/worktrees/x"}}' \
  | env HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$REPO" bash "$HOOKS/no-worktree-branch-create.sh" 2>/dev/null) || true)
assert_eq "" "$out" "unresolved → allow"

# ----------------------------------------------------------------------------
# Part B — deny-capable gates: unresolved / unreadable / normal
# ----------------------------------------------------------------------------
GATE_DIR="$BASE/gate"
GATE_REPO="$GATE_DIR/repo"
WT_SLUG="db-rule"
WT="$GATE_REPO/.claude/worktrees/$WT_SLUG"
mkdir -p "$GATE_REPO" "$WT/src" "$WT/agents"
git_init "$GATE_REPO"
GOOD_DB="$GATE_DIR/good.db"
schema "$GOOD_DB"
sqlite3 "$GOOD_DB" "
  INSERT INTO issues (id) VALUES (1);
  INSERT INTO repos (name, path, target_branch) VALUES ('repo', '$GATE_REPO', 'main');
  INSERT INTO tasks (id, branch_id, status, repo, files) VALUES
    (1, 'feat/missing-branch', 'pending', 'repo', NULL),
    (2, 'feat/open', 'running', NULL, NULL),
    (3, 'feat/$WT_SLUG', 'running', NULL, '[\"docs/\"]'),
    (4, 'feat/done', 'completed', NULL, NULL);
  INSERT INTO agents VALUES ('security', 'consultant');
"
CORRUPT_DB="$GATE_DIR/corrupt.db"
printf 'this is not a sqlite database, only text' > "$CORRUPT_DB"
LOCKED_DB="$GATE_DIR/locked.db"
cp "$GOOD_DB" "$LOCKED_DB"
chmod 000 "$LOCKED_DB"
MISSING_DB="$GATE_DIR/missing.db"

# run_gate <hook> <payload> <db> [cwd]
run_gate() {
  local hook="$1" payload="$2" db="$3" cwd="${4:-$GATE_REPO}"
  (cd "$cwd" && printf '%s' "$payload" | env HOME="$FAKE_HOME" TRAJECTORY_DB_PATH="$db" bash "$HOOKS/$hook" 2>/dev/null) || true
}

# gate <hook> <payload> <normal-substring> [cwd]
gate() {
  local hook="$1" payload="$2" normal="$3" cwd="${4:-$GATE_REPO}" out
  test_case "$hook: unresolved DB allows"
  out=$(run_gate "$hook" "$payload" "$MISSING_DB" "$cwd")
  assert_not_contains "$out" '"permissionDecision":"deny"' "no deny"
  assert_not_contains "$out" '"decision":"block"' "no block"

  test_case "$hook: corrupt DB denies as unavailable"
  out=$(run_gate "$hook" "$payload" "$CORRUPT_DB" "$cwd")
  assert_contains "$out" "trajectory DB unavailable" "unavailable reason"

  test_case "$hook: unreadable (chmod 000) DB denies as unavailable"
  out=$(run_gate "$hook" "$payload" "$LOCKED_DB" "$cwd")
  assert_contains "$out" "trajectory DB unavailable" "unavailable reason"

  test_case "$hook: normal path unchanged"
  out=$(run_gate "$hook" "$payload" "$GOOD_DB" "$cwd")
  if [ -n "$normal" ]; then
    assert_contains "$out" "$normal" "normal decision"
  else
    assert_eq "" "$out" "normal allow"
  fi
  assert_not_contains "$out" "trajectory DB unavailable" "not the unavailable reason"
}

gate require-task-spec.sh \
  '{"tool_name":"Agent","tool_input":{"subagent_type":"swe","prompt":"task_id=4"}}' \
  "has status=completed"
gate require-feature-branch-active.sh \
  '{"tool_name":"Agent","tool_input":{"subagent_type":"swe","prompt":"task_id=1"}}' \
  "needs branch feat/missing-branch"
gate pr-reviewer-after-atomic-close.sh \
  '{"tool_name":"Agent","tool_input":{"subagent_type":"pr-reviewer","prompt":"task_id=4"}}' \
  "status=closed but actual status=completed"
gate stay-on-base-guard.sh \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout feat/open"}}' \
  "belongs to open task #2"
gate no-worktree-branch-create.sh \
  '{"tool_name":"Bash","tool_input":{"command":"git worktree add -b feat/x .claude/worktrees/x"}}' \
  "cannot create a branch"
gate no-source-edit-from-main.sh \
  "$(jq -nc --arg t "$GATE_REPO/main.ts" '{tool_name:"Write",tool_input:{file_path:$t}}')" \
  "source edits from the main checkout are denied"
gate branch-up-to-date-with-remote.sh \
  "$(jq -nc --arg c "cd $GATE_REPO && git worktree add .claude/worktrees/y main" '{tool_name:"Bash",tool_input:{command:$c}}')" \
  ""
gate consultant-persistence-gate.sh \
  '{"agent_type":"security","stop_hook_active":false}' \
  "Consultant persistence gate"

# swe-scope-fence only notes a write outside files[]: a DB error leaves it
# silent, never a deny.
# The swe's spawn transcript names task 3, whose worktree is $WT.
SPAWN_TR="$GATE_DIR/spawn-3.jsonl"
printf '{"message":{"content":[{"type":"text","text":"task_id=3"}]}}\n' > "$SPAWN_TR"
SF_PAYLOAD=$(jq -nc --arg t "$WT/src/x.ts" --arg tr "$SPAWN_TR" '{tool_name:"Edit",agent_type:"swe",agent_transcript_path:$tr,tool_input:{file_path:$t}}')
test_case "swe-scope-fence.sh: corrupt or unreadable DB stays silent"
assert_eq "" "$(run_gate swe-scope-fence.sh "$SF_PAYLOAD" "$CORRUPT_DB" "$WT")" "corrupt DB: no output"
assert_eq "" "$(run_gate swe-scope-fence.sh "$SF_PAYLOAD" "$LOCKED_DB" "$WT")" "unreadable DB: no output"
test_case "swe-scope-fence.sh: normal path notes the out-of-fence write"
assert_contains "$(run_gate swe-scope-fence.sh "$SF_PAYLOAD" "$GOOD_DB" "$WT")" "src/x.ts is outside this task's files[]" "the note"

# swe-boundary keeps its prompt-surface deny for un-onboarded projects (its rule
# needs no DB); the DB only grants prompt_bearing. So (a) asserts the reason is
# the prompt-surface one, never the unavailable one.
SB_PAYLOAD=$(jq -nc --arg t "$WT/agents/a.md" --arg tr "$SPAWN_TR" '{tool_name:"Edit",agent_type:"swe",agent_transcript_path:$tr,tool_input:{file_path:$t}}')
test_case "swe-boundary.sh: unresolved DB keeps the un-onboarded behaviour"
out=$(run_gate swe-boundary.sh "$SB_PAYLOAD" "$MISSING_DB" "$WT")
assert_contains "$out" "may not edit prompt-surface files" "prompt-surface reason"
assert_not_contains "$out" "trajectory DB unavailable" "not the unavailable reason"
test_case "swe-boundary.sh: corrupt DB denies as unavailable"
out=$(run_gate swe-boundary.sh "$SB_PAYLOAD" "$CORRUPT_DB" "$WT")
assert_contains "$out" "trajectory DB unavailable" "unavailable reason"
test_case "swe-boundary.sh: normal path unchanged"
out=$(run_gate swe-boundary.sh "$SB_PAYLOAD" "$GOOD_DB" "$WT")
assert_contains "$out" "may not edit prompt-surface files" "prompt-surface reason"
sqlite3 "$GOOD_DB" "UPDATE tasks SET prompt_bearing = 1 WHERE id = 3;"
out=$(run_gate swe-boundary.sh "$SB_PAYLOAD" "$GOOD_DB" "$WT")
assert_eq "" "$out" "prompt_bearing=1 task allows"

test_case "advisory hooks log one stderr line and allow on a DB error"
err=$( (cd "$GATE_REPO" && printf '%s' '{"prompt":"hey bro"}' | env HOME="$FAKE_HOME" PATH="$LIVE_PATH" TRAJECTORY_DB_PATH="$CORRUPT_DB" bash "$HOOKS/activation-routine.sh" 2>&1 >/dev/null) || true)
assert_contains "$err" "activation-routine: trajectory DB unavailable" "activation-routine stderr line"
out=$( (cd "$GATE_REPO" && printf '%s' '{"prompt":"hey bro"}' | env HOME="$FAKE_HOME" PATH="$LIVE_PATH" TRAJECTORY_DB_PATH="$CORRUPT_DB" bash "$HOOKS/activation-routine.sh" 2>/dev/null) || true)
assert_eq "" "$out" "activation-routine emits nothing"

summarize
