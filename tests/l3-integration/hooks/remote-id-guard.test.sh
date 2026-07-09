#!/usr/bin/env bash
# Tests for scripts/hooks/remote-id-guard.sh.
# Hook contract: PreToolUse/Bash hook denies remote-WRITE text (gh/glab
# create|edit|comment|close|… with author text) that cites a LOCAL trajectory
# issue id whose remote iid differs — naming the correct remote ref. Fail-open
# on real refs, reads, missing DB; bypass via TMB_DISABLE_REMOTE_ID_GUARD=1.
#
# Each case uses a mktemp-isolated fixture DB pinned via TRAJECTORY_DB_PATH —
# sandbox-isolated per #810, never touching the live trajectory DB.
#
# Cases:
#   (a) gh pr create --body 'Closes #5' where local #5 → gh_iid 42 → deny, shows #42
#   (b) gh pr create --body citing #42 (a real GH ref, not a local id) → allow
#   (c) gh pr list (read) → no-op
#   (d) missing DB → allow (fail-open)
#   (e) bypass env set → allow
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/remote-id-guard.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Fixture DB — issues table with a local→remote iid mismatch.
#   id=5  → gh_iid=42  (mismatch: bare #5 on the remote ≠ local issue 5)
#   id=42 → gh_iid=42  (aligned)
#   id=7  → gl_iid=88, gh_iid NULL (GitLab project)
#   id=9  → gh_iid NULL, gl_iid NULL (unmapped local)
#   id=10 → gh_iid=50, gl_iid=60 (BOTH set, differ — provider decides which iid)
DB="$TMPDIR/trajectory.db"
sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    gh_iid INTEGER,
    gl_iid INTEGER
  );
  INSERT INTO issues (id, gh_iid, gl_iid) VALUES
    (5, 42, NULL),
    (42, 42, NULL),
    (7, NULL, 88),
    (9, NULL, NULL),
    (10, 50, 60);
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
# Case (a) — mismatch → deny, naming the correct remote ref
# ============================================================================
test_case "(a) gh pr create body citing local #5 (gh_iid 42): deny"
out_a=$(run_hook "$(input_bash "gh pr create --title x --body 'Closes #5'")")
assert_contains "$out_a" '"permissionDecision":"deny"' "deny decision"

test_case "(a) deny reason names the correct remote ref #42"
assert_contains "$out_a" "#42" "correct remote ref shown"

test_case "(a) deny output is valid JSON"
if printf '%s' "$out_a" | jq . >/dev/null 2>&1; then _pass; else _fail "not JSON: $out_a"; fi

test_case "(a) -b short flag form also denies"
out_a2=$(run_hook "$(input_bash "gh pr create -t x -b 'fixes #5'")")
assert_contains "$out_a2" '"permissionDecision":"deny"' "deny on -b form"

test_case "(a) gh issue close --comment with local #5: deny"
out_a3=$(run_hook "$(input_bash "gh issue close 1 --comment 'dup of #5'")")
assert_contains "$out_a3" '"permissionDecision":"deny"' "deny on issue close comment"

test_case "(a) glab mr create body with local #7 (gl_iid 88): deny, shows #88"
out_a4=$(run_hook "$(input_bash "glab mr create --title x --description 'see #7'")")
assert_contains "$out_a4" '"permissionDecision":"deny"' "deny on glab gl_iid mismatch"
assert_contains "$out_a4" "#88" "correct gl remote ref shown"

# ---- H7: provider decides which iid to cite (id=10 has gh_iid=50, gl_iid=60) --
test_case "(H7) gh pr create citing local #10: deny, shows the GitHub iid #50"
out_h7_gh=$(run_hook "$(input_bash "gh pr create --title x --body 'see #10'")")
assert_contains "$out_h7_gh" '"permissionDecision":"deny"' "gh provider must deny on #10"
assert_contains "$out_h7_gh" "#50" "gh command must resolve the GitHub iid"
assert_contains "$out_h7_gh" "GitHub" "gh command must name GitHub"

test_case "(H7) glab mr create citing local #10: deny, shows the GitLab iid #60 (not #50)"
out_h7_gl=$(run_hook "$(input_bash "glab mr create --title x --description 'see #10'")")
assert_contains "$out_h7_gl" '"permissionDecision":"deny"' "glab provider must deny on #10"
assert_contains "$out_h7_gl" "#60" "glab command must resolve the GitLab iid, not the GitHub one"
assert_contains "$out_h7_gl" "GitLab" "glab command must name GitLab"

test_case "(H7) glab mr create citing #10 does NOT cite the GitHub iid #50"
assert_not_contains "$out_h7_gl" "#50" "glab command must not surface the GitHub iid"

# ============================================================================
# Case (b) — real remote ref (#42 is not a mis-cited local id) → allow
# ============================================================================
test_case "(b) gh pr create body citing #42 (aligned/real ref): allow (silent)"
out_b=$(run_hook "$(input_bash "gh pr create --title x --body 'Closes #42'")")
assert_eq "" "$out_b" "aligned ref allowed"

test_case "(b) gh pr create citing #9 (local but unmapped): allow"
out_b2=$(run_hook "$(input_bash "gh pr create --title x --body 'about #9'")")
assert_eq "" "$out_b2" "unmapped local id left alone"

test_case "(b) gh pr create citing #999 (not a local id at all): allow"
out_b3=$(run_hook "$(input_bash "gh pr create --title x --body 'see #999'")")
assert_eq "" "$out_b3" "non-local ref left alone"

# ============================================================================
# Case (c) — plain read commands → no-op
# ============================================================================
test_case "(c) gh pr list: no-op (silent)"
out_c=$(run_hook "$(input_bash 'gh pr list')")
assert_eq "" "$out_c" "read command silent"

test_case "(c) gh issue view 5: no-op even though #5 mismatched"
out_c2=$(run_hook "$(input_bash 'gh issue view 5')")
assert_eq "" "$out_c2" "view is a read, no text flag"

test_case "(c) gh pr create WITHOUT author text (no body/title): no-op"
out_c3=$(run_hook "$(input_bash 'gh pr create --fill')")
assert_eq "" "$out_c3" "no author text → no scan"

# ============================================================================
# Case (d) — missing DB → fail-open (allow)
# ============================================================================
test_case "(d) missing DB: fail-open (allow)"
out_d=$(echo "$(input_bash "gh pr create --body 'Closes #5'")" | \
  TRAJECTORY_DB_PATH="$TMPDIR/no-such.db" bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_d" "missing DB → allow"

test_case "(d) DB without issues table: fail-open (allow)"
DB_NO_ISSUES="$TMPDIR/no-issues.db"
sqlite3 "$DB_NO_ISSUES" "CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);"
out_d2=$(run_hook "$(input_bash "gh pr create --body 'Closes #5'")" "$DB_NO_ISSUES")
assert_eq "" "$out_d2" "absent issues table → allow"

# ============================================================================
# Case (e) — bypass env → allow even on a true mismatch
# ============================================================================
test_case "(e) TMB_DISABLE_REMOTE_ID_GUARD=1: bypass (allow)"
out_e=$(echo "$(input_bash "gh pr create --body 'Closes #5'")" | \
  TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_REMOTE_ID_GUARD=1 bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_e" "bypass env honored"

summarize
