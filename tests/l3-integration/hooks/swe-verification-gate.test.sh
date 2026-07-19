#!/usr/bin/env bash
# Tests for scripts/hooks/swe-verification-gate.sh
#
# Hook contract: PreToolUse gate on task_update_status(agent=swe, status=completed).
# Reads the typed `verification` column (JSON array of command strings, Typed
# Rails #673), runs each command in the task worktree. Deny on non-zero exit or
# total timeout. Allow on pass, empty array, or valid waiver.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-verification-gate.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Plugin-subdir layout (mirrors the real TMB workspace):
#   <ws>/.claude/tmb/trajectory.db        — DB lives at the workspace root
#   <ws>/plugin/                          — the repo (a subdir of the workspace)
#   <ws>/plugin/.claude/worktrees/<slug>/ — worktrees hang off the REPO, not ws
#
# The verification gate resolves the worktree base from the task's repo
# (tasks.repo → repos.path), exactly as ensure-swe-worktree.sh creates it — a
# workspace-rooted guess (<ws>/.claude/worktrees) is wrong here. (#156)
WS="$TMPDIR/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Repo dir — a subdir of the workspace. Worktrees hang off the repo's .claude.
REPO_DIR="$WS/plugin"
mkdir -p "$REPO_DIR"
WT_ROOT="$REPO_DIR/.claude/worktrees"
mkdir -p "$WT_ROOT/my-feature"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    branch_id TEXT NOT NULL,
    repo TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    branch_id TEXT,
    from_node TEXT NOT NULL DEFAULT 'swe',
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO repos VALUES (1, 'plugin', '$REPO_DIR');
  INSERT INTO tasks VALUES (1, 1, 'feat/my-feature', 'plugin', 'pending', '', '[\"bash tests/run.sh\"]');
  INSERT INTO tasks VALUES (2, 1, 'feat/no-verify', 'plugin', 'pending', '', '[]');
  INSERT INTO tasks VALUES (3, 1, 'feat/fail-verify', 'plugin', 'pending', '', '[\"exit 1\"]');
  INSERT INTO tasks VALUES (4, 1, 'feat/multi-cmd', 'plugin', 'pending', '', '[\"echo ok\",\"exit 0\"]');
"

# Create a passing test runner in the worktree.
mkdir -p "$WT_ROOT/my-feature/tests"
echo '#!/usr/bin/env bash' > "$WT_ROOT/my-feature/tests/run.sh"
echo 'echo "all tests pass"' >> "$WT_ROOT/my-feature/tests/run.sh"
chmod +x "$WT_ROOT/my-feature/tests/run.sh"
mkdir -p "$WT_ROOT/fail-verify"
mkdir -p "$WT_ROOT/no-verify"
mkdir -p "$WT_ROOT/multi-cmd"

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

make_input() {
  local agent="$1" status="$2" task_id="$3"
  jq -n --arg a "$agent" --arg s "$status" --arg t "$task_id" '{
    tool_name: "mcp__tmb__trajectory-server__task_update_status",
    tool_input: {agent: $a, status: $s, task_id: $t}
  }'
}

# ---- Non-SWE caller: allowed ------------------------------------------------
test_case "non-SWE caller (bro) completing task: allowed"
out=$(run_hook "$(make_input bro completed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro completing should not be gated"

# ---- SWE setting status != completed: allowed -------------------------------
test_case "SWE setting status=running: allowed (not completing)"
out=$(run_hook "$(make_input swe running 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "status=running should not trigger gate"

test_case "SWE setting status=failed: allowed"
out=$(run_hook "$(make_input swe failed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "status=failed should not trigger gate"

# ---- Empty typed verification[]: allow with advisory ------------------------
test_case "SWE completing task with empty typed verification[]: allowed with advisory"
out=$(run_hook "$(make_input swe completed 2)")
assert_not_contains "$out" '"permissionDecision":"deny"' "empty verification[] should allow"
assert_contains "$out" "additionalContext" "should emit advisory additionalContext"
assert_contains "$out" "no typed verification" "advisory should mention missing typed field"

# ---- Passing verification: allowed ------------------------------------------
test_case "SWE completing task with passing verification: allowed"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 1)")
assert_not_contains "$out" '"permissionDecision":"deny"' "passing verification should allow"

# ---- Failing verification: DENIED ------------------------------------------
test_case "SWE completing task with failing verification command: DENIED"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 3)")
assert_contains "$out" '"permissionDecision":"deny"' "failing verification should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Failing verification: deny carries permissionDecisionReason (not denyReason) ---
# Claude Code only surfaces hookSpecificOutput.permissionDecisionReason; a
# denyReason field would render as a silent deny with no explanation.
test_case "failing verification: deny uses permissionDecisionReason with a non-empty value, no denyReason"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 3)")
REASON=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null || true)
assert_contains "$REASON" "verification failed" "deny must carry a non-empty permissionDecisionReason"
HAS_DENY_REASON=$(printf '%s' "$out" | jq -r 'if (.hookSpecificOutput | has("denyReason")) then "yes" else "no" end' 2>/dev/null || echo "no")
assert_eq "no" "$HAS_DENY_REASON" "deny must not carry a denyReason key"

# ---- Multi-command verification that passes: allowed ------------------------
test_case "SWE completing task with multi-command verification (all pass): allowed"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 4)")
assert_not_contains "$out" '"permissionDecision":"deny"' "multi-command all-pass should allow"

# ---- Waiver with >=10 chars: allowed + audit row ----------------------------
test_case "SWE completing with valid waiver (>=10 chars): allowed"
WAIVER="emergency hotfix, tests not applicable here"
INPUT=$(jq -n --arg w "$WAIVER" '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "3", waive_verification_gate_reason: $w}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "valid waiver should allow"
AUDIT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived';" 2>/dev/null)
assert_eq "1" "$AUDIT" "waiver should write audit row"

# ---- Waiver with <10 chars: NOT a valid waiver, falls through to verification ---
test_case "SWE completing with short waiver (<10 chars): not treated as waiver"
INPUT=$(jq -n '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "3", waive_verification_gate_reason: "short"}
}')
out=$(cd "$REPO_DIR" && run_hook "$INPUT")
assert_contains "$out" '"permissionDecision":"deny"' "short waiver should not bypass verification"

# ---- No DB: allowed ---------------------------------------------------------
test_case "No DB: gate allows silently"
out=$(echo '{"tool_input":{"agent":"swe","status":"completed","task_id":"1"}}' | \
  TRAJECTORY_DB_PATH="$TMPDIR/nonexistent.db" bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "no DB should allow"

# ---- Timeout: DENIED --------------------------------------------------------
test_case "Verification timeout: DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (99, 1, 'feat/slow-test', 'plugin', 'pending', '', '[\"sleep 5\",\"echo done\"]');
"
mkdir -p "$WT_ROOT/slow-test"
out=$(cd "$REPO_DIR" && \
  TMB_VERIFICATION_TIMEOUT_S=0 run_hook "$(make_input swe completed 99)")
assert_contains "$out" '"permissionDecision":"deny"' "timeout should deny"
assert_contains "$out" "timed out" "deny reason should mention timeout"

# ---- Timeout mid-command: deny carries permissionDecisionReason mentioning timeout ---
# Drive a real per-command timeout (budget 1s, command sleeps 5s) so the deny is
# emitted from the mid-command branch, and assert it surfaces via the field CC
# reads (permissionDecisionReason), not denyReason.
test_case "timeout path: deny uses permissionDecisionReason mentioning the timeout, no denyReason"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (98, 1, 'feat/slow-mid', 'plugin', 'pending', '', '[\"sleep 5\"]');
"
mkdir -p "$WT_ROOT/slow-mid"
out=$(cd "$REPO_DIR" && \
  TMB_VERIFICATION_TIMEOUT_S=1 run_hook "$(make_input swe completed 98)")
assert_contains "$out" '"permissionDecision":"deny"' "mid-command timeout should deny"
REASON=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null || true)
assert_contains "$REASON" "timed out" "timeout deny must carry permissionDecisionReason mentioning the timeout"
HAS_DENY_REASON=$(printf '%s' "$out" | jq -r 'if (.hookSpecificOutput | has("denyReason")) then "yes" else "no" end' 2>/dev/null || echo "no")
assert_eq "no" "$HAS_DENY_REASON" "timeout deny must not carry a denyReason key"

# ---- SQL injection via task_id: treated as missing ---------------------------
test_case "Injection: task_id='1; DROP TABLE tasks;--' treated as missing (no SQL error, no row)"
AUDIT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
INPUT=$(jq -n '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "1; DROP TABLE tasks;--", waive_verification_gate_reason: "waiver text long enough"}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "injected task_id should be treated as missing (allow)"
assert_not_contains "$out" "Error" "injected task_id should not surface a SQL error"
TASKS_TABLE=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';")
assert_eq "tasks" "$TASKS_TABLE" "tasks table must survive injection attempt"
AUDIT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit;")
assert_eq "$AUDIT_BEFORE" "$AUDIT_AFTER" "no audit row should be written for injected task_id"

# ---- Waiver reason with single quotes: audit row written intact --------------
test_case "Waiver reason containing single quotes: allowed, audit row intact"
WAIVER="tests can't run here — it's a doc-only change"
INPUT=$(jq -n --arg w "$WAIVER" '{
  tool_name: "mcp__tmb__trajectory-server__task_update_status",
  tool_input: {agent: "swe", status: "completed", task_id: "4", waive_verification_gate_reason: $w}
}')
out=$(run_hook "$INPUT")
assert_not_contains "$out" '"permissionDecision":"deny"' "quoted waiver should allow"
ROW=$(sqlite3 "$DB" "SELECT content_json FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;")
assert_contains "$ROW" "it's a doc-only change" "stored content_json should retain single quotes"
EXTRACTED=$(sqlite3 "$DB" "SELECT json_extract(content_json, '\$.waiver_reason') FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;")
assert_contains "$EXTRACTED" "can't run here" "content_json should be valid JSON (json_extract works)"

# ---- Multi-command typed verification[]: passing -----------------------------
test_case "multi-command typed verification[]: all pass → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (10, 1, 'feat/typed-pass', 'plugin', 'pending', '', '[\"echo typed-ok\",\"exit 0\"]');
"
mkdir -p "$WT_ROOT/typed-pass"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "typed multi-command all-pass should allow"

# ---- Typed verification[]: failing command -----------------------------------
test_case "typed verification[]: failing command → DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (11, 1, 'feat/typed-fail', 'plugin', 'pending', '', '[\"exit 1\"]');
"
mkdir -p "$WT_ROOT/typed-fail"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 11)")
assert_contains "$out" '"permissionDecision":"deny"' "typed failing cmd should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Typed verification[] with shell metacharacters in a command -------------
test_case "typed verification[]: command with pipes/redirects runs verbatim → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (12, 1, 'feat/typed-shell', 'plugin', 'pending', '', '[\"echo a | grep a\"]');
"
mkdir -p "$WT_ROOT/typed-shell"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 12)")
assert_not_contains "$out" '"permissionDecision":"deny"' "shell-metachar command should run and pass"

# ---- Repo-subdir layout: worktree resolves under the REPO, not the ws --------
# Layout: ws/.claude/tmb/trajectory.db  +  ws/plugin/.claude/worktrees/<slug>/
# Hook runs from ws/plugin (the repo). The worktree hangs off the repo subdir,
# NOT the workspace root. A workspace-rooted guess (ws/.claude/worktrees) would
# silently miss the worktree; the repo-rooted resolution (tasks.repo → repos.path)
# finds ws/plugin/.claude/worktrees/. (#156)
test_case "repo-subdir layout: gate resolves worktree under the repo root and runs"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (20, 1, 'feat/repo-subdir', 'plugin', 'pending', '', '[\"echo repo-subdir-ok\"]');
"
mkdir -p "$WT_ROOT/repo-subdir"
# A decoy worktree at the WORKSPACE root must NOT be picked up — only the
# repo-rooted one is valid. A workspace-rooted resolver would run the decoy's
# (absent) commands and behave differently.
mkdir -p "$WS/.claude/worktrees/repo-subdir"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 20)")
assert_not_contains "$out" "verification gate skipped" "repo-subdir gate must not skip"
assert_not_contains "$out" '"permissionDecision":"deny"' "repo-subdir passing cmd should allow"

# ---- Minimal hook PATH: toolchain (mise/homebrew) tool resolves (#673) --------
# The swe-subagent PreToolUse hook process starts with a minimal, login-stripped
# PATH where npm/node/shellcheck are absent (they live in mise/homebrew). The
# gate must resolve the user toolchain PATH so such a verification[] command
# runs instead of exiting 127 (false DENY).
#
# We pick a real toolchain tool (node via mise, else shellcheck via homebrew),
# capture its bin dir, then run the hook under a PATH that DELIBERATELY excludes
# that bin dir (but keeps the hook's own deps: jq, sqlite3, the timeout impl).
# If the gate's PATH resolution works, the command resolves and runs.
TOOL=""; TOOL_BIN=""
for cand in node npm shellcheck; do
  p=$(command -v "$cand" 2>/dev/null || true)
  if [ -n "$p" ]; then TOOL="$cand"; TOOL_BIN=$(dirname "$p"); break; fi
done

if [ -n "$TOOL" ]; then
  # Build a PATH that keeps the hook's runtime deps but drops the tool's bin dir.
  DEP_DIRS=""
  for dep in jq sqlite3 timeout gtimeout perl date dirname tail head bash sort tr; do
    dp=$(command -v "$dep" 2>/dev/null || true)
    [ -n "$dp" ] || continue
    d=$(dirname "$dp")
    case ":$DEP_DIRS:" in *":$d:"*) ;; *) DEP_DIRS="${DEP_DIRS:+$DEP_DIRS:}$d" ;; esac
  done
  # Strip the tool's bin dir from the dep PATH so it is genuinely unresolvable
  # before the gate prepends the toolchain dirs.
  MINIMAL_PATH=""
  IFS=: read -ra _dirs <<< "$DEP_DIRS"
  for d in "${_dirs[@]}"; do
    [ "$d" = "$TOOL_BIN" ] && continue
    MINIMAL_PATH="${MINIMAL_PATH:+$MINIMAL_PATH:}$d"
  done
  MINIMAL_PATH="${MINIMAL_PATH}:/usr/bin:/bin:/usr/sbin:/sbin"

  run_hook_min_path() {
    echo "$1" | env PATH="$MINIMAL_PATH" bash "$HOOK" 2>&1 || true
  }

  # Sanity: under the minimal PATH the tool is genuinely unresolvable.
  test_case "minimal PATH: chosen toolchain tool ($TOOL) is unresolvable before gate resolution"
  unresolved=$(env PATH="$MINIMAL_PATH" bash -c "command -v $TOOL >/dev/null 2>&1 && echo found || echo missing")
  assert_eq "missing" "$unresolved" "$TOOL must be off the minimal PATH for this test to be meaningful"

  # Passing: a verification command invoking the toolchain tool resolves and runs.
  test_case "minimal PATH: passing verification using mise/homebrew tool resolves and ALLOWS (#673)"
  sqlite3 "$DB" "
    INSERT INTO tasks VALUES (30, 1, 'feat/toolchain-pass', 'plugin', 'pending', '', '[\"$TOOL --version\"]');
  "
  mkdir -p "$WT_ROOT/toolchain-pass"
  out=$(cd "$REPO_DIR" && run_hook_min_path "$(make_input swe completed 30)")
  assert_not_contains "$out" '"permissionDecision":"deny"' "toolchain tool should resolve and pass (no false 127 DENY)"

  # Failing: the same tool exits non-zero → genuine DENY (resolution still works).
  test_case "minimal PATH: failing verification using mise/homebrew tool resolves and DENIES (#673)"
  sqlite3 "$DB" "
    INSERT INTO tasks VALUES (31, 1, 'feat/toolchain-fail', 'plugin', 'pending', '', '[\"$TOOL --no-such-flag-xyz; exit 1\"]');
  "
  mkdir -p "$WT_ROOT/toolchain-fail"
  out=$(cd "$REPO_DIR" && run_hook_min_path "$(make_input swe completed 31)")
  assert_contains "$out" '"permissionDecision":"deny"' "genuinely failing toolchain command should still DENY"
  assert_contains "$out" "verification failed" "deny reason should say verification failed"
fi

# ---- No worktree + non-empty verification[]: fail CLOSED (deny, never skip) ---
# When the task's worktree cannot be located but verification[] is non-empty,
# the gate must DENY with a named remediation — never skip (the silent skip let
# tasks atomic-close without the gate enforcing verification, a safety hole) and
# never silently fall back to the active checkout (that would let SWE pass the
# gate from an arbitrary cwd). (#156)
test_case "no worktree + non-empty verification[]: fail CLOSED with a named reason (deny)"
sqlite3 "$DB" "
  INSERT INTO tasks VALUES (40, 1, 'feat/no-worktree', 'plugin', 'pending', '', '[\"echo should-not-run\"]');
"
# Deliberately do NOT create the worktree dir for this slug. The repo resolves
# (repos.path), but no worktree exists under it → the gate must fail closed.
ACTIVE_CHECKOUT=$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$PLUGIN_ROOT")
out=$(cd "$ACTIVE_CHECKOUT" && run_hook "$(make_input swe completed 40)")
assert_not_contains "$out" "verification gate skipped" "no-worktree gate must not emit the silent-skip note"
assert_contains "$out" '"permissionDecision":"deny"' "unlocatable worktree must DENY (fail closed)"
assert_contains "$out" "could not locate the task worktree" "deny reason should name the missing-worktree remediation"
assert_contains "$out" ".claude/worktrees/no-worktree" "deny reason should name the expected repo-rooted worktree path"

summarize
