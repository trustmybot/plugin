#!/usr/bin/env bash
# Tests for scripts/hooks/agent-spawn-dispatch.sh
#
# Dispatcher contract:
#   - Runs the five Agent-spawn gate hooks in order.
#   - Short-circuits on the first deny: emits that deny verbatim and exits.
#   - On full pass: emits union of any additionalContext blocks (currently
#     none of the five produce context, but the merge path is exercised).
#   - A non-deny, non-context output from any hook is ignored.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCHER="$PLUGIN_ROOT/scripts/hooks/agent-spawn-dispatch.sh"

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
      spec_body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      objective TEXT NOT NULL DEFAULT 'test',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
TMPDIR=$(mktemp -d)
db=$(setup_db "$TMPDIR")
insert_task "$db" 1 "pending" "fix/1-foo" "## spec"
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"swe",prompt:"do the thing"}}')
out=$(run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "SWE spawn requires task_id" "require-task-spec wording present"
rm -rf "$TMPDIR"

# ----- tests: first-deny short-circuit (pr-reviewer-spawn-prompt-shape) -----

test_case "pr-reviewer spawn with missing anchors is denied"
TMPDIR=$(mktemp -d)
db=$(setup_db "$TMPDIR")
insert_task "$db" 5 "closed" "fix/5-pr" "## spec"
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"pr-reviewer",prompt:"please review this PR"}}')
out=$(TMB_SKIP_PR_REVIEWER_CLOSE_GATE=1 run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "missing required anchors" "prompt-shape wording present"
rm -rf "$TMPDIR"

# ----- tests: pr-reviewer-no-worktree short-circuits before shape check -----

test_case "pr-reviewer with isolation=worktree is denied before shape check (hook order preserved)"
TMPDIR=$(mktemp -d)
db=$(setup_db "$TMPDIR")
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"pr-reviewer",isolation:"worktree",prompt:"review"}}')
out=$(run_dispatcher "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "must NOT run with isolation" "no-worktree wording present (fired before shape check)"
rm -rf "$TMPDIR"

# ----- tests: clean swe spawn passes silently --------------------------------

test_case "clean swe spawn with valid task_id and existing branch passes silently"
TMPDIR=$(mktemp -d)
setup_repo "$TMPDIR" "dev" "fix/1-foo"
db="$TMPDIR/trajectory.db"
sqlite3 "$db" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL DEFAULT 1,
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    spec_body TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues (id) VALUES (1);
  INSERT INTO tasks (id, issue_id, branch_id, status, spec_body)
    VALUES (1, 1, 'fix/1-foo', 'pending', '## spec body');
" >/dev/null
payload=$(jq -n '{tool_name:"Agent",tool_input:{subagent_type:"swe",prompt:"task_id=1 worktree=/some/path You are SWE."}}')
out=$(
  cd "$TMPDIR" || exit 1
  printf '%s' "$payload" | TRAJECTORY_DB_PATH="$db" bash "$DISPATCHER" 2>/dev/null || true
)
assert_eq "" "$out" "silent pass — no deny, no context"
rm -rf "$TMPDIR"

# ----- tests: non-Agent tool is a no-op ------------------------------------

test_case "non-Agent tool input passes silently (hooks self-filter)"
payload=$(jq -n '{tool_name:"Bash",tool_input:{command:"ls"}}')
out=$(run_dispatcher "$payload" "/nonexistent.db")
assert_eq "" "$out" "silent no-op for non-Agent tool"

# ----- tests: context union -------------------------------------------------

test_case "context union: real dispatcher merges additionalContext from gate hooks"
# Drive the REAL dispatcher (copied verbatim) against stub gate hooks named
# exactly as the dispatcher expects. SCRIPT_DIR resolves to the temp dir, so the
# shipped union logic is exercised — no reimplemented dispatcher.
TMPDIR=$(mktemp -d)
STUB_HOOKS_DIR="$TMPDIR/hooks"
mkdir -p "$STUB_HOOKS_DIR"
cp "$DISPATCHER" "$STUB_HOOKS_DIR/agent-spawn-dispatch.sh"

# First and last gate in the dispatcher's fixed order emit additionalContext;
# the union must carry both, separated.
cat > "$STUB_HOOKS_DIR/require-task-spec.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"part-A"}}'
EOF
cat > "$STUB_HOOKS_DIR/pr-reviewer-after-atomic-close.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"part-B"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/require-task-spec.sh" "$STUB_HOOKS_DIR/pr-reviewer-after-atomic-close.sh"

out=$(printf '{}' | bash "$STUB_HOOKS_DIR/agent-spawn-dispatch.sh" 2>/dev/null || true)
assert_contains "$out" "part-A" "first context part present"
assert_contains "$out" "part-B" "second context part present"
assert_contains "$out" "additionalContext" "result wrapped in additionalContext"
rm -rf "$TMPDIR"

# ----- tests: deny short-circuits context collection -----------------------

test_case "deny in first gate short-circuits real dispatcher; later context not emitted"
TMPDIR=$(mktemp -d)
STUB_HOOKS_DIR="$TMPDIR/hooks"
mkdir -p "$STUB_HOOKS_DIR"
cp "$DISPATCHER" "$STUB_HOOKS_DIR/agent-spawn-dispatch.sh"

# First gate denies; a later gate emits context that must never be reached.
cat > "$STUB_HOOKS_DIR/require-task-spec.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",denyReason:"BLOCKED: first hook denied"}}'
EOF
cat > "$STUB_HOOKS_DIR/require-feature-branch-active.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"should-not-appear"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/require-task-spec.sh" "$STUB_HOOKS_DIR/require-feature-branch-active.sh"

out=$(printf '{}' | bash "$STUB_HOOKS_DIR/agent-spawn-dispatch.sh" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny present"
assert_contains "$out" "first hook denied" "deny reason from first hook"
assert_not_contains "$out" "should-not-appear" "later gate context not emitted"
rm -rf "$TMPDIR"

summarize
