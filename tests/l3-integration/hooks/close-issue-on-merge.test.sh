#!/usr/bin/env bash
# Tests for scripts/hooks/close-issue-on-merge.sh.
# Hook contract: PostToolUse on Bash. After a successful `gh pr merge` /
# `glab mr merge`, resolve the PR's RESOLVED issue from an EXPLICIT closing-ref
# only (gh pr view closingIssuesReferences + body parse), map it to the local
# trajectory issue, and close BOTH idempotently (local UPDATE + remote
# `gh issue close`) with an issue_auto_closed_on_merge audit row. Fail OPEN on
# no closing-ref, ambiguous link, already-closed, or absent DB; always exit 0;
# bypass via TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1.
#
# Sandbox-isolated per #810: gh is stubbed on PATH (no network), the trajectory
# DB lives under a mktemp dir pinned via TRAJECTORY_DB_PATH, and the test runs
# from the sandbox — never the plugin repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/close-issue-on-merge.sh"

command -v sqlite3 >/dev/null 2>&1 || { echo "FAIL: sqlite3 unavailable — required dependency for this security-gate test"; exit 1; }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

DB="$TMPDIR/.claude/tmb/trajectory.db"
GH_LOG="$TMPDIR/gh.log"
STUB_DIR="$TMPDIR/bin"
mkdir -p "$(dirname "$DB")" "$STUB_DIR"

# --- gh stub -----------------------------------------------------------------
# `gh pr view <ref> --json closingIssuesReferences,body` → JSON whose closing
# refs come from the env CLOSING_REFS (comma list) + a body line. `gh issue view
# <n> --json state -q .state` → reads remote state from $TMPDIR/remote-<n>.state
# (default OPEN). `gh issue close <n>` → appends to GH_LOG and marks closed.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
sub="$1 $2"
case "$sub" in
  "pr view")
    refs_json=""
    if [ -n "${CLOSING_REFS:-}" ]; then
      IFS=','; for r in $CLOSING_REFS; do
        refs_json="${refs_json:+$refs_json,}{\"number\":$r}"
      done; unset IFS
    fi
    body="${PR_BODY:-}"
    printf '{"closingIssuesReferences":[%s],"body":%s}' \
      "$refs_json" "$(printf '%s' "$body" | jq -Rs .)"
    ;;
  "issue view")
    n="$3"
    sf="$TMPDIR_SHARED/remote-${n}.state"
    if [ -f "$sf" ]; then cat "$sf"; else echo "OPEN"; fi
    ;;
  "issue close")
    n="$3"
    echo "close $n" >> "$GH_LOG_SHARED"
    echo "CLOSED" > "$TMPDIR_SHARED/remote-${n}.state"
    ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/gh"

# Bake the shared paths into the stub's environment so it can log + read state.
seed_db() {
  rm -f "$DB"
  sqlite3 "$DB" "
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      closed_at TEXT,
      remote_iid INTEGER, remote_kind TEXT,
      gh_iid INTEGER, gl_iid INTEGER, milestone TEXT
    );
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      branch_id TEXT,
      from_node TEXT NOT NULL DEFAULT 'executor',
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  "
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

# run_hook <payload> — invoke the hook with the gh stub on PATH, DB pinned, and
# the stub's shared-state env vars exported. Extra env via prefix VAR=... args
# are honored by the caller using `env`.
run_hook() {
  printf '%s' "$1" | env \
    PATH="$STUB_DIR:$PATH" \
    TRAJECTORY_DB_PATH="$DB" \
    TMPDIR_SHARED="$TMPDIR" \
    GH_LOG_SHARED="$GH_LOG" \
    "${EXTRA_ENV[@]}" \
    bash "$HOOK" 2>&1 || true
}

issue_status() { sqlite3 "$DB" "SELECT status FROM issues WHERE id=$1;"; }
audit_count()  { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE issue_id=$1 AND event_type='issue_auto_closed_on_merge';"; }

# ---------------------------------------------------------------------------
test_case "(a) explicit closing-ref → local closed + remote gh close attempted"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (5, 122, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122")
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "local issue 5 closed"
assert_eq "1" "$(audit_count 5)" "audit row emitted"
assert_contains "$(cat "$GH_LOG")" "close 122" "remote gh issue close attempted"
_pass

# ---------------------------------------------------------------------------
test_case "(a') closing-ref via body parse only (no closingIssuesReferences)"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (7, 200, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS= PR_BODY="Fixes #200")
run_hook "$(input 'glab mr merge feat/y')" >/dev/null
assert_eq "closed" "$(issue_status 7)" "body-parsed ref closes local issue 7"
assert_contains "$(cat "$GH_LOG")" "close 200" "remote close attempted for body ref"
_pass

# ---------------------------------------------------------------------------
test_case "(a'') local-id closing-ref (no gh_iid match) maps directly to issues.id"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (9, 999, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=9 PR_BODY="Closes #9")
run_hook "$(input 'gh pr merge feat/z --squash')" >/dev/null
assert_eq "closed" "$(issue_status 9)" "direct local-id 9 closed"
_pass

# ---------------------------------------------------------------------------
test_case "(b) no closing-ref → no-op"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (5, 122, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS= PR_BODY="merge with no closing keyword")
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "open" "$(issue_status 5)" "issue stays open with no closing-ref"
assert_eq "" "$(cat "$GH_LOG")" "no remote close attempted"
_pass

# ---------------------------------------------------------------------------
test_case "(c) already-closed → idempotent no-op (no second audit row)"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status, closed_at) VALUES (5, 122, 'closed', '2026-01-02T00:00:00Z');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122")
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "closed" "$(issue_status 5)" "stays closed"
assert_eq "0" "$(audit_count 5)" "no audit row for already-closed issue"
assert_eq "" "$(cat "$GH_LOG")" "no remote close for already-closed issue"
_pass

# ---------------------------------------------------------------------------
test_case "(d) non-merge command → no-op (silent)"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (5, 122, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122")
out=$(run_hook "$(input 'git status')")
assert_eq "open" "$(issue_status 5)" "non-merge command closes nothing"
assert_eq "" "$out" "non-merge command is silent"
_pass

# ---------------------------------------------------------------------------
test_case "(e) no DB present → fail-open, exit 0"
rm -f "$DB"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122")
printf '%s' "$(input 'gh pr merge feat/x --squash')" | env \
  PATH="$STUB_DIR:$PATH" TRAJECTORY_DB_PATH="$DB" \
  TMPDIR_SHARED="$TMPDIR" GH_LOG_SHARED="$GH_LOG" \
  "${EXTRA_ENV[@]}" bash "$HOOK" >/dev/null 2>&1
assert_exit_code 0 $? "fail-open exits 0 with no DB"
_pass

# ---------------------------------------------------------------------------
test_case "(f) failed-merge response → no-op"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (5, 122, 'open');"
: > "$GH_LOG"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122")
run_hook "$(input 'gh pr merge feat/x --squash' 'GraphQL: Pull request is not mergeable')" >/dev/null
assert_eq "open" "$(issue_status 5)" "failed merge closes nothing"
_pass

# ---------------------------------------------------------------------------
test_case "(g) TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1 bypass → no-op"
seed_db
sqlite3 "$DB" "INSERT INTO issues (id, gh_iid, status) VALUES (5, 122, 'open');"
EXTRA_ENV=(CLOSING_REFS=122 PR_BODY="Closes GH #122" TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1)
run_hook "$(input 'gh pr merge feat/x --squash')" >/dev/null
assert_eq "open" "$(issue_status 5)" "bypass closes nothing"
_pass

summarize
