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

# ----- tests: shape hook enforces attempt_n + subagent_session_id anchors ----

SHAPE_HOOK="$PLUGIN_ROOT/scripts/hooks/pr-reviewer-spawn-prompt-shape.sh"

test_case "pr-reviewer spawn with legacy four anchors but no attempt_n/subagent_session_id is denied"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"pr-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" "attempt_n" "missing attempt_n named"
assert_contains "$out" "subagent_session_id" "missing subagent_session_id named"

test_case "pr-reviewer spawn with all six anchors passes shape check silently"
prompt="task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin attempt_n=1 subagent_session_id=sess-xyz"
payload=$(jq -n --arg p "$prompt" '{tool_name:"Agent",tool_input:{subagent_type:"pr-reviewer",prompt:$p}}')
out=$(printf '%s' "$payload" | bash "$SHAPE_HOOK" 2>/dev/null || true)
assert_eq "" "$out" "silent pass — all six anchors present"

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

test_case "context union: dispatcher merges additionalContext from stub hooks"
# Validate the union path by pointing at a temp hook directory with a stub
# hook that emits additionalContext rather than a deny.
TMPDIR=$(mktemp -d)
STUB_HOOKS_DIR="$TMPDIR/hooks"
mkdir -p "$STUB_HOOKS_DIR"

# Stub hook A: emits additionalContext "part-A"
cat > "$STUB_HOOKS_DIR/hook-a.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"part-A"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/hook-a.sh"

# Stub hook B: emits additionalContext "part-B"
cat > "$STUB_HOOKS_DIR/hook-b.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"part-B"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/hook-b.sh"

# Stub dispatcher referencing only the two stubs (not the real hooks).
cat > "$STUB_HOOKS_DIR/test-dispatch.sh" <<'DISPATCH'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
HOOKS=("$SCRIPT_DIR/hook-a.sh" "$SCRIPT_DIR/hook-b.sh")
CONTEXT_PARTS=()
for hook in "${HOOKS[@]}"; do
  [ -x "$hook" ] || continue
  OUT=$(printf '%s' "$INPUT" | bash "$hook" 2>/dev/null) || true
  [ -n "$OUT" ] || continue
  DECISION=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)
  if [ "$DECISION" = "deny" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi
  CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
  [ -n "$CTX" ] && CONTEXT_PARTS+=("$CTX")
done
if [ "${#CONTEXT_PARTS[@]}" -gt 0 ]; then
  MERGED=""
  for part in "${CONTEXT_PARTS[@]}"; do
    if [ -n "$MERGED" ]; then
      MERGED="${MERGED}

---

${part}"
    else
      MERGED="$part"
    fi
  done
  jq -nc --arg ctx "$MERGED" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
fi
exit 0
DISPATCH
chmod +x "$STUB_HOOKS_DIR/test-dispatch.sh"

out=$(printf '{}' | bash "$STUB_HOOKS_DIR/test-dispatch.sh" 2>/dev/null || true)
assert_contains "$out" "part-A" "first context part present"
assert_contains "$out" "part-B" "second context part present"
assert_contains "$out" "additionalContext" "result wrapped in additionalContext"
rm -rf "$TMPDIR"

# ----- tests: deny short-circuits context collection -----------------------

test_case "deny in first hook short-circuits; second hook context not emitted"
TMPDIR=$(mktemp -d)
STUB_HOOKS_DIR="$TMPDIR/hooks"
mkdir -p "$STUB_HOOKS_DIR"

cat > "$STUB_HOOKS_DIR/deny-hook.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",denyReason:"BLOCKED: first hook denied"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/deny-hook.sh"

cat > "$STUB_HOOKS_DIR/context-hook.sh" <<'EOF'
#!/usr/bin/env bash
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"should-not-appear"}}'
EOF
chmod +x "$STUB_HOOKS_DIR/context-hook.sh"

cat > "$STUB_HOOKS_DIR/test-dispatch.sh" <<'DISPATCH'
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
HOOKS=("$SCRIPT_DIR/deny-hook.sh" "$SCRIPT_DIR/context-hook.sh")
CONTEXT_PARTS=()
for hook in "${HOOKS[@]}"; do
  [ -x "$hook" ] || continue
  OUT=$(printf '%s' "$INPUT" | bash "$hook" 2>/dev/null) || true
  [ -n "$OUT" ] || continue
  DECISION=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)
  if [ "$DECISION" = "deny" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi
  CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
  [ -n "$CTX" ] && CONTEXT_PARTS+=("$CTX")
done
if [ "${#CONTEXT_PARTS[@]}" -gt 0 ]; then
  MERGED=""
  for part in "${CONTEXT_PARTS[@]}"; do
    [ -n "$MERGED" ] && MERGED="${MERGED}

---

${part}" || MERGED="$part"
  done
  jq -nc --arg ctx "$MERGED" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
fi
exit 0
DISPATCH
chmod +x "$STUB_HOOKS_DIR/test-dispatch.sh"

out=$(printf '{}' | bash "$STUB_HOOKS_DIR/test-dispatch.sh" 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "deny present"
assert_contains "$out" "first hook denied" "deny reason from first hook"
assert_not_contains "$out" "should-not-appear" "second hook context not emitted"
rm -rf "$TMPDIR"

summarize
