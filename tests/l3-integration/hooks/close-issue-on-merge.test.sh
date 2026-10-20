#!/usr/bin/env bash
# Tests for scripts/hooks/close-issue-on-merge.sh.
# Hook contract: PostToolUse on Bash. After a successful `gh pr merge` /
# `glab mr merge` anywhere in a compound command (never inside heredoc or quoted
# text): live tasks on the merged head branch close (open runs closed
# 'completed'); tasks without a passing review get a review_gate_bypassed row;
# each issue named by an EXPLICIT closing-ref closes locally when no other task
# of it is live (issue_auto_closed_on_merge), else stays open with an
# issue_auto_close_deferred row. The remote twin closes only while the sync gate
# is on; otherwise issue_auto_close_remote_skipped is written and no `gh issue`
# call runs. Fail OPEN on no closing-ref, already-closed, or absent DB; always
# exit 0; bypass via TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1.
#
# Sandbox-isolated per #810: gh is stubbed on PATH (no network), the trajectory
# DB is the real schema under a mktemp dir pinned via TRAJECTORY_DB_PATH, and
# the test runs from the sandbox — never the plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/close-issue-on-merge.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v sqlite3 >/dev/null 2>&1 || { echo "FAIL: sqlite3 unavailable — required dependency for this security-gate test"; exit 1; }

# The remote-sync kill-switch is set per case; a value inherited from the
# caller (tests/run-all.sh exports it) would silence the remote-close cases.
unset TMB_DISABLE_REMOTE_SYNC

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-close-issue-on-merge.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

DB="$TMPDIR/.claude/tmb/trajectory.db"
GH_LOG="$TMPDIR/gh.log"
STUB_DIR="$TMPDIR/bin"
mkdir -p "$(dirname "$DB")" "$STUB_DIR"

# --- gh stub -----------------------------------------------------------------
# Every call is appended to GH_LOG. `gh pr view <ref> --json ...` → JSON whose
# closing refs come from CLOSING_REFS (comma list), body from PR_BODY, head
# branch from HEAD_REF. `gh issue view <n>` → remote state from
# $TMPDIR/remote-<n>.state (default OPEN). `gh issue close <n>` → marks closed.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG_SHARED"
sub="$1 $2"
case "$sub" in
  "pr view")
    refs_json=""
    if [ -n "${CLOSING_REFS:-}" ]; then
      IFS=','; for r in $CLOSING_REFS; do
        refs_json="${refs_json:+$refs_json,}{\"number\":$r}"
      done; unset IFS
    fi
    printf '{"closingIssuesReferences":[%s],"body":%s,"headRefName":%s}' \
      "$refs_json" "$(printf '%s' "${PR_BODY:-}" | jq -Rs .)" "$(printf '%s' "${HEAD_REF:-}" | jq -Rs .)"
    ;;
  "issue view")
    sf="$TMPDIR_SHARED/remote-$3.state"
    if [ -f "$sf" ]; then cat "$sf"; else echo "OPEN"; fi
    ;;
  "issue close")
    echo "CLOSED" > "$TMPDIR_SHARED/remote-$3.state"
    ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/gh"

NOW_MINUS_2H="2026-01-01T10:00:00.000Z"
NOW_MINUS_1H="2026-01-01T11:00:00.000Z"

# seed_db [sync] — fresh real-schema DB; issue_sync defaults to 'auto' here.
seed_db() {
  rm -f "$DB"
  sqlite3 "$DB" < "$SCHEMA" >/dev/null
  sqlite3 "$DB" "UPDATE plugin_config SET value_json = '\"${1:-auto}\"' WHERE key = 'issue_sync';"
}

add_issue() { # add_issue <id> <gh_iid|NULL> [status]
  sqlite3 "$DB" "INSERT INTO issues (id, objective, status, created_at, updated_at, gh_iid)
    VALUES ($1, 'o', '${3:-open}', '$NOW_MINUS_2H', '$NOW_MINUS_2H', $2);"
}

add_task() { # add_task <id> <issue> <branch> <status> [commit]
  sqlite3 "$DB" "INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, created_at, updated_at, completed_at)
    VALUES ($1, $2, '$3', 'd', '$4', '${5:-abc1234}', '$NOW_MINUS_2H', '$NOW_MINUS_2H', '$NOW_MINUS_2H');"
}

add_run() { # add_run <task>
  sqlite3 "$DB" "INSERT INTO agent_runs (task_id, agent_type, started_at) VALUES ($1, 'swe', '$NOW_MINUS_2H');"
}

add_verification() { # add_verification <task> <commit> <at>
  sqlite3 "$DB" "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
    VALUES (0, 'bro', 'bro_verification_pass', 'ok', '{\"task_id\":$1,\"commit_sha\":\"$2\"}', '$3');"
}

add_verdict() { # add_verdict <task> <at>
  sqlite3 "$DB" "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at)
    VALUES ($1, (SELECT COUNT(*) + 1 FROM validation_attempts WHERE task_id = $1), 'pr-reviewer', 'pass', 1, '$2');"
}

add_pass() { # add_pass <task> [commit] — bro verifies the commit, then pr-reviewer passes it
  add_verification "$1" "${2:-abc1234}" "$NOW_MINUS_2H"
  add_verdict "$1" "$NOW_MINUS_1H"
}

# input <command> [response] — synthesize a PostToolUse(Bash) payload.
input() {
  local cmd="$1" resp="${2:-✓ Merged pull request}"
  jq -n --arg cmd "$cmd" --arg resp "$resp" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: $resp,
    cwd: "/tmp"
  }'
}

run_hook() {
  printf '%s' "$1" | env \
    PATH="$STUB_DIR:$PATH" \
    TRAJECTORY_DB_PATH="$DB" \
    TMPDIR_SHARED="$TMPDIR" \
    GH_LOG_SHARED="$GH_LOG" \
    "${EXTRA_ENV[@]}" \
    bash "$HOOK" 2>&1 || true
}

q()            { sqlite3 "$DB" "$1"; }
issue_status() { q "SELECT status FROM issues WHERE id=$1;"; }
task_status()  { q "SELECT status FROM tasks WHERE id=$1;"; }
audit_count()  { q "SELECT COUNT(*) FROM audit WHERE event_type='$1'${2:+ AND issue_id=$2};"; }
gh_issue_calls() { grep -c '^issue ' "$GH_LOG" || true; }

# ---------------------------------------------------------------------------
test_case "(a) explicit closing-ref → local closed + remote gh close attempted"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "local issue 5 closed"
assert_eq "1" "$(audit_count issue_auto_closed_on_merge 5)" "audit row emitted"
assert_contains "$(cat "$GH_LOG")" "issue close 122" "remote gh issue close attempted"
_pass

# ---------------------------------------------------------------------------
test_case "(a') closing-ref via body parse only (no closingIssuesReferences)"
seed_db
add_issue 7 200
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS= PR_BODY="Fixes #200" HEAD_REF=feat/y)
run_hook "$(input 'glab mr merge feat/y')" >/dev/null
assert_eq "closed" "$(issue_status 7)" "body-parsed ref closes local issue 7"
assert_contains "$(cat "$GH_LOG")" "issue close 200" "remote close attempted for body ref"
_pass

# ---------------------------------------------------------------------------
test_case "(a'') local-id closing-ref (no gh_iid match) maps directly to issues.id"
seed_db
add_issue 9 999
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=9 PR_BODY="Closes #9" HEAD_REF=feat/z)
run_hook "$(input 'gh pr merge feat/z --squash')" >/dev/null
assert_eq "closed" "$(issue_status 9)" "direct local-id 9 closed"
_pass

# ---------------------------------------------------------------------------
test_case "(b) no closing-ref → issue untouched, no remote close"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS= PR_BODY="merge with no closing keyword" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "open" "$(issue_status 5)" "issue stays open with no closing-ref"
assert_eq "0" "$(gh_issue_calls)" "no remote issue call"
_pass

# ---------------------------------------------------------------------------
test_case "(c) already-closed → idempotent no-op (no second audit row)"
seed_db
add_issue 5 122 closed
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "stays closed"
assert_eq "0" "$(audit_count issue_auto_closed_on_merge 5)" "no audit row for already-closed issue"
assert_eq "0" "$(gh_issue_calls)" "no remote call for already-closed issue"
_pass

# ---------------------------------------------------------------------------
test_case "(d) non-merge command → no-op (silent)"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
out=$(run_hook "$(input 'git status')")
assert_eq "open" "$(issue_status 5)" "non-merge command closes nothing"
assert_eq "" "$out" "non-merge command is silent"
assert_eq "" "$(cat "$GH_LOG")" "non-merge command spawns no gh"
_pass

# ---------------------------------------------------------------------------
test_case "(e) no DB present → fail-open, exit 0"
rm -f "$DB"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
printf '%s' "$(input 'gh pr merge feat/x --squash')" | env \
  PATH="$STUB_DIR:$PATH" TRAJECTORY_DB_PATH="$DB" \
  TMPDIR_SHARED="$TMPDIR" GH_LOG_SHARED="$GH_LOG" \
  "${EXTRA_ENV[@]}" bash "$HOOK" >/dev/null 2>&1
assert_exit_code 0 $? "fail-open exits 0 with no DB"
_pass

# ---------------------------------------------------------------------------
test_case "(f) failed-merge response → no-op"
seed_db
add_issue 5 122
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash' 'GraphQL: Pull request is not mergeable')" >/dev/null
assert_eq "open" "$(issue_status 5)" "failed merge closes nothing"
_pass

# ---------------------------------------------------------------------------
test_case "(g) TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1 bypass → no-op"
seed_db
add_issue 5 122
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "open" "$(issue_status 5)" "bypass closes nothing"
_pass

# ---------------------------------------------------------------------------
test_case "(h) issue_sync off → local close, no gh issue call, remote-skipped audit"
seed_db off
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "local close still happens"
assert_eq "0" "$(gh_issue_calls)" "no gh issue view/close with sync off"
assert_eq "1" "$(audit_count issue_auto_close_remote_skipped 5)" "remote-skipped audit row"
_pass

# ---------------------------------------------------------------------------
test_case "(h') TMB_DISABLE_REMOTE_SYNC=1 → no gh issue call, remote-skipped audit"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x TMB_DISABLE_REMOTE_SYNC=1)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "local close still happens"
assert_eq "0" "$(gh_issue_calls)" "no gh issue call with the kill-switch set"
assert_eq "1" "$(audit_count issue_auto_close_remote_skipped 5)" "remote-skipped audit row"
_pass

# ---------------------------------------------------------------------------
test_case "(i) compound command 'cd x && gh pr merge 12' fires"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'cd x && gh pr merge 12 --squash; git pull')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "compound merge closes the issue"
assert_contains "$(cat "$GH_LOG")" "pr view 12 " "the merge statement's own ref is used"
_pass

# ---------------------------------------------------------------------------
test_case "(j) heredoc or quoted text containing 'gh pr merge' does not fire"
seed_db
add_issue 5 122
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input "$(printf 'cat > notes.md <<EOF\ngh pr merge 12 --squash\nEOF')")" >/dev/null
run_hook "$(input 'echo "next: gh pr merge 12"')" >/dev/null
assert_eq "open" "$(issue_status 5)" "heredoc / quoted text closes nothing"
assert_eq "" "$(cat "$GH_LOG")" "no gh spawned"
_pass

# ---------------------------------------------------------------------------
test_case "(k) another live task on the issue → deferred, issue stays open"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed
add_task 2 5 feat/other running
add_pass 1
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "open" "$(issue_status 5)" "issue stays open over a live task"
assert_eq "closed" "$(task_status 1)" "merged task closed"
assert_eq "running" "$(task_status 2)" "other task untouched"
assert_eq "1" "$(audit_count issue_auto_close_deferred 5)" "deferred audit row"
assert_eq "[2]" "$(q "SELECT json_extract(content_json, '\$.blocking_task_ids') FROM audit WHERE event_type='issue_auto_close_deferred';")" "blocking task ids named"
assert_eq "0" "$(audit_count issue_auto_closed_on_merge 5)" "no close audit"
assert_eq "0" "$(gh_issue_calls)" "no remote close for a deferred issue"
_pass

# ---------------------------------------------------------------------------
test_case "(l) merged task closes, its open runs close 'completed', issue closes"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed
add_run 1
add_pass 1
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(task_status 1)" "merged task closed"
assert_eq "completed" "$(q "SELECT exit_reason FROM agent_runs WHERE task_id=1;")" "run closed completed"
assert_eq "0" "$(q "SELECT COUNT(*) FROM agent_runs WHERE completed_at IS NULL;")" "no open run left"
assert_eq "closed" "$(issue_status 5)" "issue closed once its last task merged"
assert_eq "0" "$(audit_count review_gate_bypassed)" "a passing review writes no bypass row"
_pass

# ---------------------------------------------------------------------------
test_case "(m) merged task without a pass → closed + one review_gate_bypassed row"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(task_status 1)" "merged task closed anyway"
assert_eq "1" "$(audit_count review_gate_bypassed 5)" "bypass row written"
assert_eq '{"task_id":1,"commit_sha":"abc1234","closed_by":"close-issue-on-merge"}' \
  "$(q "SELECT content_json FROM audit WHERE event_type='review_gate_bypassed';")" "bypass content"
assert_eq "hook:close-issue-on-merge" "$(q "SELECT from_node FROM audit WHERE event_type='review_gate_bypassed';")" "written by the hook"
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "1" "$(audit_count review_gate_bypassed 5)" "a re-run records no second bypass"
_pass

# ---------------------------------------------------------------------------
test_case "(n) a pass with no bro_verification_pass for the commit is no pass"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed
add_verdict 1 "$NOW_MINUS_1H"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "1" "$(audit_count review_gate_bypassed 5)" "completed_at anchors nothing"
_pass

# ---------------------------------------------------------------------------
test_case "(o) a pass of an older commit never covers the merged commit"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed def5678
add_verification 1 abc1234 "2026-01-01T09:00:00.000Z"
add_verdict 1 "2026-01-01T09:30:00.000Z"
add_verification 1 def5678 "$NOW_MINUS_2H"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq '{"task_id":1,"commit_sha":"def5678","closed_by":"close-issue-on-merge"}' \
  "$(q "SELECT content_json FROM audit WHERE event_type='review_gate_bypassed';")" "bypass names the merged commit"
_pass

# ---------------------------------------------------------------------------
add_skip() { # add_skip <event_type> <from_node> <task> [commit]
  sqlite3 "$DB" "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
    VALUES (5, '$2', '$1', 'skip', '{\"task_id\":$3,\"commit_sha\":\"${4:-abc1234}\"}', '$NOW_MINUS_1H');"
}

test_case "(p) a waiver or bypass row not authored by bro does not count as a recorded skip"
for row in "review_gate_waived pr-reviewer" "review_gate_bypassed pr-reviewer" "review_gate_waived architect" "review_gate_waived hook:close-issue-on-merge"; do
  seed_db
  add_issue 5 122
  add_task 1 5 feat/x completed
  # shellcheck disable=SC2086
  add_skip $row 1
  EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
  run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
  assert_eq "1" "$(q "SELECT COUNT(*) FROM audit WHERE event_type='review_gate_bypassed' AND from_node='hook:close-issue-on-merge';")" "($row) the hook still records its bypass"
done
_pass

# ---------------------------------------------------------------------------
test_case "(q) a bro-authored waiver for the merged commit is the recorded skip"
seed_db
add_issue 5 122
add_task 1 5 feat/x completed
add_skip review_gate_waived bro 1
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" HEAD_REF=feat/x)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "0" "$(audit_count review_gate_bypassed)" "no bypass over a bro waiver"
_pass

summarize
