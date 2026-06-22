#!/usr/bin/env bash
# Tests for scripts/hooks/no-remote-auth-guard.sh.
# Hook contract: PreToolUse/Bash hook denies `gh auth login` and
# `glab auth login` when no remote has a non-empty URL; allows otherwise.
# Fail-open when DB is absent or config unavailable.
#
# Cases:
#   (a) gh auth login, no remote url → deny
#   (b) glab auth login, no remote url → deny
#   (c) gh auth login WITH a remote url → allow
#   (d) gh auth status (not login) → allow
#   (e) glab auth status → allow
#   (f) ls → allow (no output)
#   (g) gh pr list → allow
#   (h) missing DB → allow (fail-open)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/no-remote-auth-guard.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

DB="$TMPDIR/trajectory.db"

# repos schema (post-#987): repos.remotes is the sole source of truth. A single
# registered repo lets tmb_repo_remotes resolve via the single-repo fallback
# regardless of cwd/git-root.
_repos_schema="CREATE TABLE repos (
  name TEXT PRIMARY KEY, path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  target_branch TEXT, branching_model TEXT, protected_branches TEXT,
  remotes TEXT
);"

# Fixture: a single repos row whose remotes have no usable url.
sqlite3 "$DB" "
  $_repos_schema
  INSERT INTO repos (name, path, remotes) VALUES
    ('repo', '/tmp/repo', '[{\"name\":\"origin\",\"provider\":\"github\",\"url\":\"\"}]');
"

# Fixture DB: a single repos row with a usable url.
DB_WITH_REMOTE="$TMPDIR/trajectory-with-remote.db"
sqlite3 "$DB_WITH_REMOTE" "
  $_repos_schema
  INSERT INTO repos (name, path, remotes) VALUES
    ('repo', '/tmp/repo', '[{\"name\":\"origin\",\"provider\":\"github\",\"url\":\"https://github.com/org/repo.git\"}]');
"

input_bash() {
  local cmd="$1"
  jq -n --arg cmd "$cmd" '{
    tool_name: "Bash",
    tool_input: { command: $cmd }
  }'
}

run_hook() {
  local input="$1"
  local db="${2:-$DB}"
  echo "$input" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>/dev/null || true
}

# ============================================================================
# Case (a) — gh auth login, no remote url → deny
# ============================================================================
test_case "(a) gh auth login with no remote url: deny"
out=$(run_hook "$(input_bash 'gh auth login')")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision"

test_case "(a) gh auth login: deny reason mentions BLOCKED"
assert_contains "$out" "BLOCKED" "BLOCKED in reason"

test_case "(a) gh auth login: deny reason names tool 'gh'"
assert_contains "$out" "gh auth login" "tool name in reason"

test_case "(a) gh auth login: output is valid JSON"
if printf '%s' "$out" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "output failed jq parse — got: $out"
fi

# ============================================================================
# Case (b) — glab auth login, no remote url → deny
# ============================================================================
test_case "(b) glab auth login with no remote url: deny"
out_b=$(run_hook "$(input_bash 'glab auth login')")
assert_contains "$out_b" '"permissionDecision":"deny"' "deny decision"

test_case "(b) glab auth login: deny reason mentions BLOCKED"
assert_contains "$out_b" "BLOCKED" "BLOCKED in reason"

test_case "(b) glab auth login: deny reason names tool 'glab'"
assert_contains "$out_b" "glab auth login" "tool name in reason"

# ============================================================================
# Case (c) — gh auth login WITH a remote url → allow (silent)
# ============================================================================
test_case "(c) gh auth login with remote url present: allow (silent)"
out_c=$(run_hook "$(input_bash 'gh auth login')" "$DB_WITH_REMOTE")
assert_eq "" "$out_c" "no output when remote configured"

# ============================================================================
# Case (d) — gh auth status (not login) → allow
# ============================================================================
test_case "(d) gh auth status: allow (silent)"
out_d=$(run_hook "$(input_bash 'gh auth status')")
assert_eq "" "$out_d" "auth status not blocked"

# ============================================================================
# Case (e) — glab auth status → allow
# ============================================================================
test_case "(e) glab auth status: allow (silent)"
out_e=$(run_hook "$(input_bash 'glab auth status')")
assert_eq "" "$out_e" "glab auth status not blocked"

# ============================================================================
# Case (f) — ls → allow (no output at all)
# ============================================================================
test_case "(f) ls: allow with no output"
out_f=$(run_hook "$(input_bash 'ls')")
assert_eq "" "$out_f" "unrelated command silent"

# ============================================================================
# Case (g) — gh pr list → allow
# ============================================================================
test_case "(g) gh pr list: allow (silent)"
out_g=$(run_hook "$(input_bash 'gh pr list')")
assert_eq "" "$out_g" "non-auth gh command silent"

# ============================================================================
# Case (h) — missing DB → allow (fail-open)
# ============================================================================
test_case "(h) missing DB: fail-open (allow)"
out_h=$(echo "$(input_bash 'gh auth login')" | TRAJECTORY_DB_PATH="$TMPDIR/no-such.db" bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_h" "missing DB → allow"

# ============================================================================
# Extra: gh auth token → allow (only login is blocked)
# ============================================================================
test_case "gh auth token: allow (not login)"
out_tok=$(run_hook "$(input_bash 'gh auth token')")
assert_eq "" "$out_tok" "auth token not blocked"

# ============================================================================
# Extra: glab auth login with remote url → allow
# ============================================================================
test_case "glab auth login with remote url present: allow (silent)"
out_gl_r=$(run_hook "$(input_bash 'glab auth login')" "$DB_WITH_REMOTE")
assert_eq "" "$out_gl_r" "glab allow when remote configured"

# ============================================================================
# Extra: no registered repo (empty repos table) → fail-open
# ============================================================================
test_case "no registered repo: fail-open (allow)"
DB_NO_REMOTES="$TMPDIR/trajectory-no-remotes.db"
sqlite3 "$DB_NO_REMOTES" "$_repos_schema"
out_nr=$(echo "$(input_bash 'gh auth login')" | TRAJECTORY_DB_PATH="$DB_NO_REMOTES" bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_nr" "no repos row → allow"

# ============================================================================
# Subshell-wrapped forms: (gh auth login) / (glab auth login) → deny
# ============================================================================
test_case "subshell (gh auth login): deny"
out_sub_gh=$(run_hook "$(input_bash '(gh auth login)')")
assert_contains "$out_sub_gh" '"permissionDecision":"deny"' "subshell gh auth login must deny"

test_case "subshell (gh auth login): deny reason mentions BLOCKED"
assert_contains "$out_sub_gh" "BLOCKED" "BLOCKED in reason for subshell gh"

test_case "subshell (glab auth login): deny"
out_sub_glab=$(run_hook "$(input_bash '(glab auth login)')")
assert_contains "$out_sub_glab" '"permissionDecision":"deny"' "subshell glab auth login must deny"

test_case "subshell (glab auth login): deny reason mentions BLOCKED"
assert_contains "$out_sub_glab" "BLOCKED" "BLOCKED in reason for subshell glab"

summarize
