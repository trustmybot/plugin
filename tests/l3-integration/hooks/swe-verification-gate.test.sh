#!/usr/bin/env bash
# Tests for scripts/hooks/swe-verification-gate.sh
#
# Hook contract: PreToolUse gate on task_update_status(agent=swe, status=completed).
# Reads the typed `verification` column (JSON array of command strings, Typed
# Rails #673), runs each command in the task worktree and records the run in
# verification_runs + verification_run_commands. Deny on non-zero exit or
# budget spent. Allow on pass, empty array, valid waiver, or a passing run for
# the same (task, worktree HEAD) recorded within the hour. Through the
# trajectory-gates chain, a call agent-arg-matches-caller denies never reaches
# the gate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-verification-gate.sh"
. "$HERE/fixtures/wal-no-holder.sh"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-swe-verification-gate.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

# The gate's toolchain resolution may invoke mise, which keeps its own state
# under HOME; keep that inside the sandbox. The user's real mise installs (the
# inherited MISE_DATA_DIR, else the real home's) stay reachable for the
# minimal-PATH cases.
TOOLCHAIN_MISE_DATA="${MISE_DATA_DIR:-${TMB_TEST_REAL_HOME:-$HOME}/.local/share/mise}"
export MISE_DATA_DIR="$TMPDIR/mise/data" MISE_STATE_DIR="$TMPDIR/mise/state" MISE_CACHE_DIR="$TMPDIR/mise/cache"

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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    repo TEXT
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
    verification TEXT NOT NULL DEFAULT '[]',
    commit_sha TEXT
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    branch_id TEXT,
    from_node TEXT NOT NULL DEFAULT 'swe',
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    repo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE verification_runs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('gate','manual')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    budget_s INTEGER NOT NULL,
    timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE verification_run_commands (
    run_id INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER,
    elapsed_s REAL,
    output_tail TEXT,
    PRIMARY KEY (run_id, ordinal)
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'), NULL);
  INSERT INTO repos VALUES (1, 'plugin', '$REPO_DIR');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (1, 1, 'feat/my-feature', 'plugin', 'pending', '', '[\"bash tests/run.sh\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (2, 1, 'feat/no-verify', 'plugin', 'pending', '', '[]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (3, 1, 'feat/fail-verify', 'plugin', 'pending', '', '[\"exit 1\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (4, 1, 'feat/multi-cmd', 'plugin', 'pending', '', '[\"echo ok\",\"exit 0\"]');
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
  local agent="$1" status="$2" task_id="$3" sha="${4:-}"
  jq -n --arg a "$agent" --arg s "$status" --arg t "$task_id" --arg sha "$sha" '{
    tool_name: "mcp__tmb__trajectory-server__task_update_status",
    tool_input: ({agent: $a, status: $s, task_id: $t} + (if $sha == "" then {} else {commit_sha: $sha} end))
  }'
}

# git_worktree <slug> — the worktree as a git repo with one commit; prints HEAD.
git_worktree() {
  local wt="$WT_ROOT/$1"
  mkdir -p "$wt"
  git -C "$wt" init --quiet
  git -C "$wt" -c user.email=t@example.com -c user.name=t commit --quiet --allow-empty -m init
  git -C "$wt" rev-parse HEAD
}

git_commit() {
  git -C "$WT_ROOT/$1" -c user.email=t@example.com -c user.name=t commit --quiet --allow-empty -m "$2"
  git -C "$WT_ROOT/$1" rev-parse HEAD
}

reason_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null || true; }
runs_of() { sqlite3 "$DB" "SELECT COUNT(*) FROM verification_runs WHERE task_id = $1;"; }

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

# ---- Failing verification: deny forwards the FAIL lines before the tail ------
# A failing L3 run names its failing file early and then prints a long summary;
# the tail alone would drop the file name, so matching lines are forwarded too.
test_case "failing verification: deny reason names the failing file from FAIL lines beyond the tail"
mkdir -p "$WT_ROOT/l3-fail"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (5, 1, 'feat/l3-fail', 'plugin', 'pending', '', '[\"echo FAIL x.test.sh; for i in \$(seq 1 40); do echo filler \$i; done; exit 1\"]');"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 5)")
REASON=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null || true)
assert_contains "$REASON" "FAIL x.test.sh" "deny reason should forward the FAIL line"
assert_contains "$REASON" "Failure lines" "deny reason should label the forwarded failure lines"
assert_contains "$REASON" "filler 40" "deny reason should still carry the output tail"

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

# ---- Budget floor: 0 or a non-integer falls back to the default ------------
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (99, 1, 'feat/zero-budget', 'plugin', 'pending', '', '[\"sleep 1; echo done\"]');
"
git_worktree zero-budget >/dev/null

test_case "budget 0: falls back to the default 900 s with a warning naming the value"
out=$(cd "$REPO_DIR" && echo "$(make_input swe completed 99)" | TMB_VERIFICATION_TIMEOUT_S=0 bash "$HOOK" 2>"$TMPDIR/zero.err" || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "a 0 budget does not time the command out"
assert_contains "$(cat "$TMPDIR/zero.err")" "verification_timeout_s '0' is not an integer from 1 to 1800; using the default 900s" "stderr warns naming the bad value"
assert_eq "900|0" "$(sqlite3 "$DB" "SELECT budget_s || '|' || timed_out FROM verification_runs WHERE task_id = 99 ORDER BY id DESC LIMIT 1;")" "run records the default budget"

test_case "budget non-integer: falls back to the default with a warning naming the value"
git_commit zero-budget "abc" >/dev/null
out=$(cd "$REPO_DIR" && echo "$(make_input swe completed 99)" | TMB_VERIFICATION_TIMEOUT_S=abc bash "$HOOK" 2>"$TMPDIR/abc.err" || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "a non-integer budget does not deny"
assert_contains "$(cat "$TMPDIR/abc.err")" "verification_timeout_s 'abc'" "stderr warns naming the bad value"
assert_eq "900|0" "$(sqlite3 "$DB" "SELECT budget_s || '|' || timed_out FROM verification_runs WHERE task_id = 99 ORDER BY id DESC LIMIT 1;")" "run records the default budget"

# ---- Timeout mid-command: deny carries permissionDecisionReason mentioning timeout ---
# Drive a real per-command timeout (budget 1s, command sleeps 5s) so the deny is
# emitted from the mid-command branch, and assert it surfaces via the field CC
# reads (permissionDecisionReason), not denyReason.
test_case "timeout path: deny uses permissionDecisionReason mentioning the timeout, no denyReason"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (98, 1, 'feat/slow-mid', 'plugin', 'pending', '', '[\"sleep 5\"]');
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

# ---- Waiver is idempotent per (task, commit_sha) ------------------------------
test_case "Two waiver invocations for the same (task, sha) write one verification_gate_waived row"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification, commit_sha) VALUES (50, 1, 'feat/waive-twice', 'plugin', 'running', '', '[\"exit 1\"]', 'aaa1111');"
waive_input() {
  jq -n --arg sha "$1" '{
    tool_name: "mcp__tmb__trajectory-server__task_update_status",
    tool_input: ({agent: "swe", status: "completed", task_id: "50", waive_verification_gate_reason: "doc-only change, nothing to run"} + (if $sha == "" then {} else {commit_sha: $sha} end))
  }'
}
waived_rows() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived' AND json_extract(content_json, '\$.task_id') = 50 AND json_extract(content_json, '\$.commit_sha') = '$1';"; }
out1=$(run_hook "$(waive_input "")")
out2=$(run_hook "$(waive_input "")")
assert_not_contains "$out1$out2" '"permissionDecision":"deny"' "both waiver invocations allow"
assert_eq "1" "$(waived_rows aaa1111)" "same (task, task commit_sha) twice → one row"
out3=$(run_hook "$(waive_input bbb2222)")
out4=$(run_hook "$(waive_input bbb2222)")
assert_not_contains "$out3$out4" '"permissionDecision":"deny"' "waiver with an explicit commit_sha allows"
assert_eq "1" "$(waived_rows bbb2222)" "same (task, tool_input commit_sha) twice → one row"
assert_eq "1" "$(waived_rows aaa1111)" "the earlier commit's row is untouched"

# ---- Multi-command typed verification[]: passing -----------------------------
test_case "multi-command typed verification[]: all pass → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (10, 1, 'feat/typed-pass', 'plugin', 'pending', '', '[\"echo typed-ok\",\"exit 0\"]');
"
mkdir -p "$WT_ROOT/typed-pass"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "typed multi-command all-pass should allow"

# ---- Typed verification[]: failing command -----------------------------------
test_case "typed verification[]: failing command → DENIED"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (11, 1, 'feat/typed-fail', 'plugin', 'pending', '', '[\"exit 1\"]');
"
mkdir -p "$WT_ROOT/typed-fail"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 11)")
assert_contains "$out" '"permissionDecision":"deny"' "typed failing cmd should deny"
assert_contains "$out" "verification failed" "deny reason should say verification failed"

# ---- Typed verification[] with shell metacharacters in a command -------------
test_case "typed verification[]: command with pipes/redirects runs verbatim → allowed"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (12, 1, 'feat/typed-shell', 'plugin', 'pending', '', '[\"echo a | grep a\"]');
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
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (20, 1, 'feat/repo-subdir', 'plugin', 'pending', '', '[\"echo repo-subdir-ok\"]');
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
# then run the hook under a PATH that holds only the hook's own deps (jq,
# sqlite3, the timeout impl, coreutils), never the tool. If the gate's PATH
# resolution works, the command resolves and runs.
TOOL=""
for cand in node npm shellcheck; do
  if command -v "$cand" >/dev/null 2>&1; then TOOL="$cand"; break; fi
done

if [ -n "$TOOL" ]; then
  # Build the minimal PATH from a fresh dir holding symlinks to exactly the
  # hook's runtime deps, resolved from the current PATH now. Whole system or
  # package-manager bin dirs are never on it, so a node that shares a dir with
  # a dep (homebrew's timeout, a distro's /usr/bin) cannot leak in.
  MINIMAL_PATH="$TMPDIR/minimal-path-bin"
  mkdir -p "$MINIMAL_PATH"
  for dep in bash sh jq sqlite3 git timeout gtimeout perl date dirname basename \
      tail head sort tr cat sed awk grep mktemp rm mkdir env cut wc tee sleep \
      uname id ls readlink stat touch chmod mv cp ps kill od shasum xargs find; do
    dp=$(command -v "$dep" 2>/dev/null || true)
    case "$dp" in /*) ln -sf "$dp" "$MINIMAL_PATH/$dep" ;; esac
  done

  # Toolchain resolution reads the user's real mise/homebrew install, which
  # lives under the real home (run.sh points HOME at an empty footprint dir).
  run_hook_min_path() {
    echo "$1" | env MISE_DATA_DIR="$TOOLCHAIN_MISE_DATA" PATH="$MINIMAL_PATH" HOME="${TMB_TEST_REAL_HOME:-$HOME}" bash "$HOOK" 2>&1 || true
  }

  # Sanity: under the minimal PATH, with every mise/asdf/nvm variable unset so
  # no shim dir can leak in, the tool is genuinely unresolvable.
  test_case "minimal PATH: chosen toolchain tool ($TOOL) is unresolvable before gate resolution"
  unset_toolchain_env=(-u MISE_DATA_DIR -u MISE_CONFIG_DIR -u MISE_SHIMS -u ASDF_DIR -u NVM_DIR)
  while IFS='=' read -r name _; do
    case "$name" in *MISE*PATH*) unset_toolchain_env+=(-u "$name") ;; esac
  done < <(env)
  leaked=$(env "${unset_toolchain_env[@]}" PATH="$MINIMAL_PATH" bash -c "command -v $TOOL" 2>/dev/null || true)
  assert_eq "" "$leaked" "$TOOL must be off the minimal PATH ($MINIMAL_PATH) for this test to be meaningful; it resolved to: $leaked"

  # Passing: a verification command invoking the toolchain tool resolves and runs.
  test_case "minimal PATH: passing verification using mise/homebrew tool resolves and ALLOWS (#673)"
  sqlite3 "$DB" "
    INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (30, 1, 'feat/toolchain-pass', 'plugin', 'pending', '', '[\"$TOOL --version\"]');
  "
  mkdir -p "$WT_ROOT/toolchain-pass"
  out=$(cd "$REPO_DIR" && run_hook_min_path "$(make_input swe completed 30)")
  assert_not_contains "$out" '"permissionDecision":"deny"' "toolchain tool should resolve and pass (no false 127 DENY)"

  # Failing: the same tool exits non-zero → genuine DENY (resolution still works).
  test_case "minimal PATH: failing verification using mise/homebrew tool resolves and DENIES (#673)"
  sqlite3 "$DB" "
    INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (31, 1, 'feat/toolchain-fail', 'plugin', 'pending', '', '[\"$TOOL --no-such-flag-xyz; exit 1\"]');
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
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (40, 1, 'feat/no-worktree', 'plugin', 'pending', '', '[\"echo should-not-run\"]');
"
# Deliberately do NOT create the worktree dir for this slug. The repo resolves
# (repos.path), but no worktree exists under it → the gate must fail closed.
ACTIVE_CHECKOUT=$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$PLUGIN_ROOT")
out=$(cd "$ACTIVE_CHECKOUT" && run_hook "$(make_input swe completed 40)")
assert_not_contains "$out" "verification gate skipped" "no-worktree gate must not emit the silent-skip note"
assert_contains "$out" '"permissionDecision":"deny"' "unlocatable worktree must DENY (fail closed)"
assert_contains "$out" "could not locate the task worktree" "deny reason should name the missing-worktree remediation"
assert_contains "$out" ".claude/worktrees/no-worktree" "deny reason should name the expected repo-rooted worktree path"

test_case "unreadable trajectory DB: verification gate fails closed (tmb_gate_read __ERR__)"
BAD_DB="$TMPDIR/corrupt-trajectory.db"
printf 'not a sqlite database %.0s' 1 2 3 4 5 6 7 8 > "$BAD_DB"
out=$(cd "$REPO_DIR" && echo "$(make_input swe completed 1)" | TRAJECTORY_DB_PATH="$BAD_DB" bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "DB read error must deny, not skip the gate"
assert_contains "$out" "trajectory DB unavailable" "deny names the unavailable DB"

WAL_WS="$TMPDIR/wal-ws"
mkdir -p "$WAL_WS/.claude/tmb"
sqlite3 "$DB" ".backup '$WAL_WS/.claude/tmb/trajectory.db'"
# Task 3's verification[] fails: an empty verification[] read would print the
# "no typed verification" skip instead of the deny.
wal_gate_cases "swe-verification-gate" "$HOOK" "$WAL_WS/.claude/tmb/trajectory.db" "$WAL_WS" \
  "$(make_input swe completed 3)" "verification failed" "no typed verification" "$REPO_DIR"

# ---- Run lock: one verification run per (task, worktree HEAD) ---------------
# Two concurrent invocations (the gate registered twice) serialize on the lock;
# the second reuses the first's run when it passed and re-runs otherwise.
COUNT_FILE="$TMPDIR/verify-runs.log"
LOCK_ROOT="$WS/.claude/tmb/locks"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (60, 1, 'feat/lock-pass', 'plugin', 'pending', '', '[\"echo run >> $COUNT_FILE; sleep 2\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (61, 1, 'feat/lock-fail', 'plugin', 'pending', '', '[\"echo run >> $COUNT_FILE.fail; sleep 2; echo boom; exit 3\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (62, 1, 'feat/lock-stale', 'plugin', 'pending', '', '[\"echo run >> $COUNT_FILE.stale\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (63, 1, 'feat/lock-unstamped', 'plugin', 'pending', '', '[\"echo run >> $COUNT_FILE.unstamped\"]');
"
LOCK_PASS_SHA=$(git_worktree lock-pass)
LOCK_FAIL_SHA=$(git_worktree lock-fail)
LOCK_STALE_SHA=$(git_worktree lock-stale)
LOCK_UNSTAMPED_SHA=$(git_worktree lock-unstamped)

test_case "run lock: concurrent passing invocations run verification[] once, both allow"
(cd "$REPO_DIR" && run_hook "$(make_input swe completed 60)" > "$TMPDIR/lock-a.out") &
sleep 0.5
(cd "$REPO_DIR" && run_hook "$(make_input swe completed 60)" > "$TMPDIR/lock-b.out") &
wait
assert_eq "1" "$(wc -l < "$COUNT_FILE" | tr -d ' ')" "verification[] ran exactly once"
assert_not_contains "$(cat "$TMPDIR/lock-a.out")" '"permissionDecision":"deny"' "first invocation allows"
assert_not_contains "$(cat "$TMPDIR/lock-b.out")" '"permissionDecision":"deny"' "second invocation allows"
assert_contains "$(cat "$TMPDIR/lock-a.out" "$TMPDIR/lock-b.out")" "verification reused run #" "the waiter reuses the holder's run"
assert_eq "no" "$([ -d "$LOCK_ROOT/verify-60-$LOCK_PASS_SHA" ] && echo yes || echo no)" "lock removed on exit"
assert_eq "1" "$(runs_of 60)" "one verification_runs row for the pair"
assert_eq "0" "$(find "$LOCK_ROOT" -name '*.result' | wc -l | tr -d ' ')" "no verdict file beside the lock"

test_case "run lock: after a failing run the waiter runs verification[] itself"
(cd "$REPO_DIR" && run_hook "$(make_input swe completed 61)" > "$TMPDIR/lock-c.out") &
sleep 0.5
(cd "$REPO_DIR" && run_hook "$(make_input swe completed 61)" > "$TMPDIR/lock-d.out") &
wait
assert_eq "2" "$(wc -l < "$COUNT_FILE.fail" | tr -d ' ')" "a failing run is never reused"
assert_contains "$(cat "$TMPDIR/lock-c.out")" '"permissionDecision":"deny"' "holder denies"
assert_contains "$(cat "$TMPDIR/lock-d.out")" '"permissionDecision":"deny"' "waiter denies from its own run"
assert_contains "$(cat "$TMPDIR/lock-d.out")" "boom" "waiter's deny carries the output tail"
assert_eq "2" "$(runs_of 61)" "two runs recorded"
assert_eq "no" "$([ -d "$LOCK_ROOT/verify-61-$LOCK_FAIL_SHA" ] && echo yes || echo no)" "lock removed on exit"

test_case "run lock: a stale lock is reclaimed"
mkdir -p "$LOCK_ROOT/verify-62-$LOCK_STALE_SHA"
echo 1000 > "$LOCK_ROOT/verify-62-$LOCK_STALE_SHA/started"
out=$(cd "$REPO_DIR" && TMB_VERIFICATION_TIMEOUT_S=5 run_hook "$(make_input swe completed 62)")
assert_not_contains "$out" '"permissionDecision":"deny"' "reclaimed lock lets the run proceed"
assert_eq "1" "$(wc -l < "$COUNT_FILE.stale" | tr -d ' ')" "verification[] ran after reclaiming"
assert_eq "no" "$([ -d "$LOCK_ROOT/verify-62-$LOCK_STALE_SHA" ] && echo yes || echo no)" "reclaimed lock removed"

test_case "run lock: a stale lock without a started stamp is reclaimed by mtime"
mkdir -p "$LOCK_ROOT/verify-63-$LOCK_UNSTAMPED_SHA"
touch -t 200001010000 "$LOCK_ROOT/verify-63-$LOCK_UNSTAMPED_SHA"
out=$(cd "$REPO_DIR" && TMB_VERIFICATION_TIMEOUT_S=5 run_hook "$(make_input swe completed 63)")
assert_not_contains "$out" '"permissionDecision":"deny"' "unstamped stale lock lets the run proceed"
assert_eq "1" "$(wc -l < "$COUNT_FILE.unstamped" 2>/dev/null | tr -d ' ')" "verification[] ran after reclaiming the unstamped lock"
assert_eq "no" "$([ -d "$LOCK_ROOT/verify-63-$LOCK_UNSTAMPED_SHA" ] && echo yes || echo no)" "unstamped lock removed"

# ---- Lock-less path: run_verification runs in the hook's own shell ----------
# When the locks dir cannot be created the gate verifies without the lock, under
# the hook's `set -euo pipefail`; every failing command must still deny.
rm -rf "$LOCK_ROOT"
touch "$LOCK_ROOT"
mkdir -p "$WT_ROOT/nolock-quiet" "$WT_ROOT/nolock-loud"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (70, 1, 'feat/nolock-quiet', 'plugin', 'pending', '', '[\"echo quiet; exit 2\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (71, 1, 'feat/nolock-loud', 'plugin', 'pending', '', '[\"for i in \$(seq 1 20000); do echo FAIL line \$i; done; exit 1\"]');
"

test_case "no lock dir: a failing command with no failure line still denies"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 70)")
assert_contains "$out" '"permissionDecision":"deny"' "lock-less failing verification should deny"
assert_contains "$out" "quiet" "deny carries the output tail"
assert_not_contains "$out" "Failure lines" "no failure-lines section when nothing matched"

test_case "no lock dir: a failing command with 20000 failure lines denies with 15 shown"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 71)")
assert_contains "$out" '"permissionDecision":"deny"' "lock-less flood should deny"
HITS=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' 2>/dev/null | sed -n '/^Failure lines/,/^$/p' | grep -c '^FAIL line' || true)
assert_eq "15" "$HITS" "exactly 15 failure lines forwarded"
rm -f "$LOCK_ROOT"

# ---- Run record: one row per run, one command row per command ---------------
test_case "run record: a passing run writes the row, one command row per command, and finishes it"
MARK="$TMPDIR/rec-marker.log"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (80, 1, 'feat/rec-pass', 'plugin', 'pending', '', '[\"echo one >> $MARK\",\"sleep 1; echo two >> $MARK\",\"echo three >> $MARK\"]');"
REC_SHA=$(git_worktree rec-pass)
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80 "${REC_SHA:0:7}")")
assert_not_contains "$out" '"permissionDecision":"deny"' "passing run allows"
assert_eq "1" "$(runs_of 80)" "one run row"
assert_eq "$REC_SHA|gate|0|0|900|1" "$(sqlite3 "$DB" "SELECT commit_sha || '|' || source || '|' || exit_code || '|' || timed_out || '|' || budget_s || '|' || (finished_at IS NOT NULL AND finished_at >= started_at) FROM verification_runs WHERE task_id = 80;")" "row: HEAD sha, gate, exit 0, not timed out, default budget, finished"
assert_eq "3" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 80;")" "three command rows"
assert_eq "1|0;2|0;3|0" "$(sqlite3 "$DB" "SELECT group_concat(ordinal || '|' || exit_code, ';') FROM (SELECT c.ordinal, c.exit_code FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 80 ORDER BY c.ordinal);")" "commands in order, each exit 0"
assert_eq "1" "$(sqlite3 "$DB" "SELECT elapsed_s >= 0.9 FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 80 AND c.ordinal = 2;")" "the sleeping command's elapsed is recorded"
assert_eq "3" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 80 AND c.elapsed_s IS NOT NULL;")" "every command carries elapsed_s"

# ---- Reuse: a passing run for the same (task, HEAD) within the hour ----------
test_case "reuse: a second close on the same HEAD within the hour allows without running verification[]"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80 "$REC_SHA")")
assert_not_contains "$out" '"permissionDecision":"deny"' "reuse allows"
RUN80=$(sqlite3 "$DB" "SELECT id FROM verification_runs WHERE task_id = 80;")
assert_contains "$out" "verification reused run #$RUN80" "additionalContext names the reused run"
assert_eq "3" "$(wc -l < "$MARK" | tr -d ' ')" "no command ran again"
assert_eq "1" "$(runs_of 80)" "no new run row"

test_case "reuse: refused when the worktree HEAD moved to a new commit"
NEW_SHA=$(git_commit rec-pass "second")
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80)")
assert_not_contains "$out" "verification reused" "a new HEAD is verified afresh"
assert_eq "6" "$(wc -l < "$MARK" | tr -d ' ')" "the commands ran again"
assert_eq "$NEW_SHA" "$(sqlite3 "$DB" "SELECT commit_sha FROM verification_runs WHERE task_id = 80 ORDER BY id DESC LIMIT 1;")" "the new run records the new HEAD"

test_case "reuse: refused when tool_input.commit_sha names a commit other than the worktree HEAD"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80 "$REC_SHA")")
assert_not_contains "$out" "verification reused" "commit_sha ≠ HEAD is verified afresh"
assert_eq "9" "$(wc -l < "$MARK" | tr -d ' ')" "the commands ran again"

test_case "reuse: refused for a passing run that finished more than an hour ago"
sqlite3 "$DB" "UPDATE verification_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 minutes') WHERE task_id = 80;"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80)")
assert_not_contains "$out" "verification reused" "an old run is not reused"
assert_eq "12" "$(wc -l < "$MARK" | tr -d ' ')" "the commands ran again"

test_case "reuse: refused after verification[] changes on the same HEAD (GH 1672)"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80)")
assert_contains "$out" "verification reused" "the fresh run of the unchanged verification[] is reused"
assert_eq "12" "$(wc -l < "$MARK" | tr -d ' ')" "nothing ran"
sqlite3 "$DB" "UPDATE tasks SET verification = '[\"echo one >> $MARK\",\"sleep 1; echo two >> $MARK\",\"echo three >> $MARK\",\"echo four >> $MARK\"]' WHERE id = 80;"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80)")
assert_not_contains "$out" "verification reused" "a run of the earlier verification[] is not reused"
assert_not_contains "$out" '"permissionDecision":"deny"' "the amended verification[] passes"
assert_eq "16" "$(wc -l < "$MARK" | tr -d ' ')" "the amended commands ran"
assert_eq "4" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM verification_run_commands WHERE run_id = (SELECT MAX(id) FROM verification_runs WHERE task_id = 80);")" "the new run records four commands"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 80)")
assert_contains "$out" "verification reused" "the run of the amended verification[] is reused"
assert_eq "16" "$(wc -l < "$MARK" | tr -d ' ')" "nothing ran again"

# ---- Failure deny: names the command and its timing --------------------------
test_case "failure deny: names the failing command, its exit, elapsed and cumulative time; the run records it"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (81, 1, 'feat/rec-fail', 'plugin', 'pending', '', '[\"echo fine\",\"echo FAIL step.test.sh; exit 4\",\"echo never\"]');"
git_worktree rec-fail >/dev/null
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 81)")
REASON=$(reason_of "$out")
assert_contains "$REASON" "Failing command (2/3): echo FAIL step.test.sh; exit 4" "deny names the failing command and its position"
assert_contains "$REASON" "Exit 4 after " "deny carries the exit code and elapsed"
assert_contains "$REASON" "s cumulative" "deny carries the cumulative time"
assert_contains "$REASON" "FAIL step.test.sh" "deny forwards the FAIL line"
assert_eq "4|0|2" "$(sqlite3 "$DB" "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) FROM verification_runs r WHERE r.task_id = 81;")" "run exit 4, two command rows (the third never ran)"
assert_contains "$(sqlite3 "$DB" "SELECT output_tail FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 81 AND c.ordinal = 2;")" "FAIL step.test.sh" "the command row keeps the output tail"

# ---- Budget: plugin_config, env override, cap --------------------------------
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (82, 1, 'feat/budget', 'plugin', 'pending', '', '[\"sleep 3\"]');"
git_worktree budget >/dev/null
budget_of_last() { sqlite3 "$DB" "SELECT budget_s || '|' || timed_out FROM verification_runs WHERE task_id = 82 ORDER BY id DESC LIMIT 1;"; }

test_case "budget: plugin_config.verification_timeout_s is honoured"
sqlite3 "$DB" "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('verification_timeout_s', '1');"
out=$(cd "$REPO_DIR" && env -u TMB_VERIFICATION_TIMEOUT_S bash -c 'echo "$1" | bash "$2" 2>&1' _ "$(make_input swe completed 82)" "$HOOK" || true)
assert_contains "$out" '"permissionDecision":"deny"' "a 1 s budget from plugin_config times out a 3 s command"
assert_contains "$(reason_of "$out")" "the 1s budget ran out" "deny names the configured budget"
assert_eq "1|1" "$(budget_of_last)" "run records budget_s 1 and timed_out"

test_case "budget: TMB_VERIFICATION_TIMEOUT_S overrides plugin_config"
git_commit budget "env budget" >/dev/null
out=$(cd "$REPO_DIR" && TMB_VERIFICATION_TIMEOUT_S=30 run_hook "$(make_input swe completed 82)")
assert_not_contains "$out" '"permissionDecision":"deny"' "the env budget lets the command finish"
assert_eq "30|0" "$(budget_of_last)" "run records the env budget"

test_case "budget: a configured budget above the cap is capped at 1800 s"
sqlite3 "$DB" "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('verification_timeout_s', '99999');"
git_commit budget "capped budget" >/dev/null
out=$(cd "$REPO_DIR" && env -u TMB_VERIFICATION_TIMEOUT_S bash -c 'echo "$1" | bash "$2" 2>&1' _ "$(make_input swe completed 82)" "$HOOK" || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "capped budget still runs"
assert_eq "1800|0" "$(budget_of_last)" "run records the capped budget"
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key IN ('verification_timeout_s');"

# ---- Timeout record: timed_out and the running command -----------------------
test_case "timeout: the run is marked timed_out and the deny names the running command and the cumulative time"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (83, 1, 'feat/rec-slow', 'plugin', 'pending', '', '[\"echo quick\",\"sleep 5\",\"echo never\"]');"
git_worktree rec-slow >/dev/null
out=$(cd "$REPO_DIR" && TMB_VERIFICATION_TIMEOUT_S=2 run_hook "$(make_input swe completed 83)")
REASON=$(reason_of "$out")
assert_contains "$REASON" "timed out" "deny says timed out"
assert_contains "$REASON" "while running command 2/3" "deny names the command's position"
assert_contains "$REASON" "sleep 5" "deny names the running command"
assert_contains "$REASON" "s in," "deny carries the cumulative time"
assert_eq "124|1|2" "$(sqlite3 "$DB" "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) FROM verification_runs r WHERE r.task_id = 83;")" "run exit 124, timed_out, the cut-off command recorded"
assert_eq "124" "$(sqlite3 "$DB" "SELECT c.exit_code FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 83 AND c.ordinal = 2;")" "the cut-off command row carries exit 124"

# ---- HEAD unresolvable: verification runs, nothing is recorded or reused ------
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (90, 1, 'feat/no-head', 'plugin', 'pending', '', '[\"echo ran >> $TMPDIR/nohead.log\"]');
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (94, 1, 'feat/no-head-fail', 'plugin', 'pending', '', '[\"echo nope; exit 5\"]');
"
mkdir -p "$WT_ROOT/no-head" "$WT_ROOT/no-head-fail"

test_case "HEAD unresolvable: verification[] runs, no run row, the allow says not recorded"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 90)")
assert_not_contains "$out" '"permissionDecision":"deny"' "passing verification allows"
assert_contains "$out" "not recorded: worktree HEAD unresolvable" "allow context says the run is not recorded"
assert_eq "1" "$(wc -l < "$TMPDIR/nohead.log" | tr -d ' ')" "verification[] ran"
assert_eq "0" "$(runs_of 90)" "no run row"

test_case "HEAD unresolvable: a second close runs verification[] again (nothing to reuse)"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 90)")
assert_not_contains "$out" "verification reused" "nothing is reused"
assert_eq "2" "$(wc -l < "$TMPDIR/nohead.log" | tr -d ' ')" "verification[] ran again"

test_case "HEAD unresolvable: a failing command denies and says not recorded"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 94)")
assert_contains "$(reason_of "$out")" "Exit 5 after" "deny names the failing command's exit"
assert_contains "$(reason_of "$out")" "(not recorded: worktree HEAD unresolvable)" "deny says the run is not recorded"
assert_eq "0" "$(runs_of 94)" "no run row"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM verification_runs WHERE commit_sha = 'nohead';")" "no nohead row anywhere"

# ---- A command's own exit 124 is a failure, not a timeout --------------------
test_case "own exit 124: recorded as exit 124 with timed_out 0, the deny names a failing command"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (91, 1, 'feat/own-124', 'plugin', 'pending', '', '[\"echo own-124; exit 124\"]');"
git_worktree own-124 >/dev/null
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 91)")
REASON=$(reason_of "$out")
assert_contains "$REASON" "verification failed" "deny says verification failed"
assert_contains "$REASON" "Failing command (1/1): echo own-124; exit 124" "deny names the failing command"
assert_not_contains "$REASON" "timed out" "deny does not call it a timeout"
assert_eq "124|0" "$(sqlite3 "$DB" "SELECT exit_code || '|' || timed_out FROM verification_runs WHERE task_id = 91;")" "run exit 124, not timed out"
assert_eq "124" "$(sqlite3 "$DB" "SELECT c.exit_code FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 91;")" "command row exit 124"

# ---- Finish write failure: decision unchanged, row left unfinished -----------
test_case "finish write fails (DB read-only after start): allow stands, stderr says unfinished, row unfinished"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (92, 1, 'feat/ro-finish', 'plugin', 'pending', '', '[\"chmod 444 $DB\"]');"
git_worktree ro-finish >/dev/null
out=$(cd "$REPO_DIR" && echo "$(make_input swe completed 92)" | bash "$HOOK" 2>"$TMPDIR/ro.err" || true)
chmod 644 "$DB"
assert_not_contains "$out" '"permissionDecision":"deny"' "the passing verification still allows"
assert_contains "$(cat "$TMPDIR/ro.err")" "record unfinished" "stderr says the record is unfinished"
assert_contains "$(cat "$TMPDIR/ro.err")" "failed 3 times" "stderr says the finish write was tried 3 times"
assert_eq "1" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM verification_runs WHERE task_id = 92 AND finished_at IS NULL;")" "the run row stays unfinished"

# ---- Record writes do not count against the command budget -------------------
# Command 1 holds the DB write lock for 4 s, so its command-row write waits out
# its 3 s record budget; command 2 then needs 2 s of a 4 s budget. Counting the
# write against the budget would leave 1 s and time command 2 out.
test_case "slow record write: the command budget excludes the time spent writing the record"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (93, 1, 'feat/slow-record', 'plugin', 'pending', '', '[\"( { echo \\\"BEGIN IMMEDIATE;\\\"; sleep 4; echo \\\"COMMIT;\\\"; } | sqlite3 $DB ) >/dev/null 2>&1 & sleep 0.5\",\"sleep 2\"]');"
git_worktree slow-record >/dev/null
out=$(cd "$REPO_DIR" && echo "$(make_input swe completed 93)" | TMB_VERIFICATION_TIMEOUT_S=4 bash "$HOOK" 2>"$TMPDIR/slow.err" || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "command 2 finishes inside the budget"
assert_contains "$(cat "$TMPDIR/slow.err")" "tmb_db_write" "the command-row write did wait on the held lock"
assert_eq "0|0" "$(sqlite3 "$DB" "SELECT exit_code || '|' || timed_out FROM verification_runs WHERE task_id = 93;")" "run finished exit 0, not timed out"

# ---- Review findings (v47, GH 1737): probes run after verification[] ---------
# Every case above ran against a DB without review_findings (no findings).
sqlite3 "$DB" "
  CREATE TABLE review_findings (
    id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_n INTEGER NOT NULL,
    criterion_id TEXT,
    probe_cmd TEXT NOT NULL,
    expected TEXT NOT NULL,
    observed TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (96, 1, 'feat/findings', 'plugin', 'pending', '', '[\"exit 0\"]');
  INSERT INTO review_findings VALUES ('F96-1', 96, 1, 'SC1', 'exit 0', 'exit 0', 'exit 1', 'open', '2026-01-01T00:00:00.000Z', NULL);
  INSERT INTO review_findings VALUES ('F96-2', 96, 1, NULL, 'echo still broken; exit 3', 'exit 0', 'exit 3', 'fixed', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  INSERT INTO review_findings VALUES ('F96-3', 96, 1, NULL, 'exit 9', 'exit 0', 'exit 9', 'wontfix', '2026-01-01T00:00:00.000Z', NULL);
"
git_worktree findings >/dev/null

test_case "findings: a passing open probe sets fixed, a failing fixed probe denies as a regression, wontfix is skipped"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 96)")
REASON=$(reason_of "$out")
assert_contains "$out" '"permissionDecision":"deny"' "a failing probe denies"
assert_contains "$REASON" "review finding probe(s) failed" "deny says a finding probe failed"
assert_contains "$REASON" "Finding F96-2 (probe 3/3) — REGRESSION" "deny names F96-2 as a regression"
assert_contains "$REASON" "still broken" "deny carries the probe output"
assert_not_contains "$REASON" "Finding F96-1" "the passing probe is not named"
assert_not_contains "$REASON" "F96-3" "the wontfix finding is not probed"
assert_eq "fixed|1" "$(sqlite3 "$DB" "SELECT status || '|' || (resolved_at IS NOT NULL AND resolved_at > '2026-06-01') FROM review_findings WHERE id = 'F96-1';")" "F96-1 is fixed with a fresh resolved_at"
assert_eq "fixed|2026-01-02T00:00:00.000Z" "$(sqlite3 "$DB" "SELECT status || '|' || resolved_at FROM review_findings WHERE id = 'F96-2';")" "F96-2 stays fixed, resolved_at untouched"
assert_eq "wontfix|" "$(sqlite3 "$DB" "SELECT status || '|' || COALESCE(resolved_at, '') FROM review_findings WHERE id = 'F96-3';")" "F96-3 untouched"
assert_eq "3|0|1" "$(sqlite3 "$DB" "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_runs WHERE task_id = 96) FROM verification_runs r WHERE r.task_id = 96;")" "run finished with the probe's exit, not timed out"
assert_eq "exit 0|[probe F96-1] exit 0|[probe F96-2] echo still broken; exit 3" "$(sqlite3 "$DB" "SELECT group_concat(command, '|') FROM (SELECT c.command FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 96 ORDER BY c.ordinal);")" "probe rows are recorded after verification[] as [probe <id>]"

test_case "findings: once every probe passes the close is allowed, and that run is reused only for the same findings"
sqlite3 "$DB" "UPDATE review_findings SET probe_cmd = 'exit 0' WHERE id = 'F96-2';"
git_commit findings "fix F96-2" >/dev/null
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 96)")
assert_not_contains "$out" '"permissionDecision":"deny"' "all probes pass"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 96)")
assert_contains "$out" "verification reused" "the same findings reuse the passing run"
sqlite3 "$DB" "INSERT INTO review_findings VALUES ('F96-4', 96, 2, NULL, 'exit 0', 'exit 0', 'exit 1', 'open', '2026-01-03T00:00:00.000Z', NULL);"
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 96)")
assert_not_contains "$out" "verification reused" "a new finding forces a fresh run"
assert_eq "fixed" "$(sqlite3 "$DB" "SELECT status FROM review_findings WHERE id = 'F96-4';")" "the new finding's passing probe fixes it"

test_case "findings: a task with empty verification[] still runs its probes"
sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (97, 1, 'feat/findings-only', 'plugin', 'pending', '', '[]');
  INSERT INTO review_findings VALUES ('F97-1', 97, 1, NULL, 'exit 4', 'exit 0', 'exit 4', 'open', '2026-01-01T00:00:00.000Z', NULL);
"
git_worktree findings-only >/dev/null
out=$(cd "$REPO_DIR" && run_hook "$(make_input swe completed 97)")
assert_contains "$(reason_of "$out")" "Finding F97-1 (probe 1/1): exit 4" "the open finding's failing probe denies"
assert_not_contains "$(reason_of "$out")" "REGRESSION" "an open finding is not a regression"
assert_eq "open|" "$(sqlite3 "$DB" "SELECT status || '|' || COALESCE(resolved_at, '') FROM review_findings WHERE id = 'F97-1';")" "a failing open finding stays open"

# ---- Chain: a call agent-arg-matches-caller denies never runs verification ---
test_case "chain: main-loop task_update_status(agent='swe') is denied and records no verification run"
sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification) VALUES (95, 1, 'feat/chain-close', 'plugin', 'pending', '', '[\"echo ok\"]');"
git_worktree chain-close >/dev/null
CHAIN_IN=$(make_input swe completed 95 | jq -c '. + {hook_event_name: "PreToolUse", session_id: "main-1", tool_use_id: "tu-chain-1"}')
out=$(cd "$REPO_DIR" && printf '%s' "$CHAIN_IN" | CLAUDE_PROJECT_DIR="$WS" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null || true)
assert_contains "$out" '"permissionDecision":"deny"' "denied"
assert_contains "$(reason_of "$out")" "pass agent='bro'" "by agent-arg-matches-caller"
assert_eq "0" "$(runs_of 95)" "no verification run recorded"
out=$(cd "$REPO_DIR" && run_hook "$CHAIN_IN")
assert_eq "1" "$(runs_of 95)" "the gate alone would have recorded one"

summarize
