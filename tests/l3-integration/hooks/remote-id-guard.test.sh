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
#   (f) gh pr create --body 'Fixes GH-5' → allow (explicit remote marker)
#   (g) --body 'see remote:5 and trustmybot/plugin#5' → allow
#   (h) gh issue comment 9 --body 'GH-5 and #5' → deny; reason carries the local objective and the marker hint
#   GH 1864: the fixture is the real schema (migrated_db), so the lookup reads issues.objective
#   GH 1821: the heredoc + compound gh api repro is allowed well under the 6 s
#            budget; an analysis past TMB_REMOTE_ID_GUARD_DEADLINE_S allows,
#            notes it on stderr and writes one remote_id_guard_overrun row
#   corpus: tests/fixtures/hook-corpus/remote-id-guard/, each payload's
#           corpus_expect (the side's own under corpus_divergent) with its corpus_env
#   TMB_HOOK_TEST_IMPL=ts runs the TypeScript gate (GH 1692); its overrun cases
#   set TMB_REMOTE_ID_GUARD_TEST_OVERRUN=1, since the TS analysis is too fast to overrun
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/l3-integration/hooks/fixtures/migrated-db.sh
. "$HERE/fixtures/migrated-db.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/remote-id-guard.sh"
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/remote-id-guard.sh"
OVERRUN_KNOB=""
[ "$HOOK_IMPL" != ts ] || OVERRUN_KNOB=1
CORPUS="$PLUGIN_ROOT/tests/fixtures/hook-corpus/remote-id-guard"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-remote-id-guard.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

# Fixture DB — the trajectory-server's own schema, with a local→remote iid mismatch.
#   id=5  → gh_iid=42  (mismatch: bare #5 on the remote ≠ local issue 5)
#   id=42 → gh_iid=42  (aligned)
#   id=7  → gl_iid=88, gh_iid NULL (GitLab project)
#   id=9  → gh_iid NULL, gl_iid NULL (unmapped local)
#   id=10 → gh_iid=50, gl_iid=60 (BOTH set, differ — provider decides which iid)
#   id=11 → gh_iid=77, an objective of printf %b escapes
#   id=12 → gh_iid=78, a two-line objective with a bar
DB="$TMPDIR/trajectory.db"
migrated_db "$DB"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, gh_iid, gl_iid, created_at, updated_at) VALUES
    (5, 'Local five | pipe title', 42, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (42, 'Local forty-two', 42, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (7, 'Local seven', NULL, 88, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (9, 'Local nine', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (10, 'Local ten', 50, 60, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (11, 'back\slash \t tab \x41 \101 \c cut', 77, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (12, 'multi' || char(10) || 'line|x', 78, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
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

now_ms() { perl -MTime::HiRes=time -e 'printf("%d", time() * 1000)'; }

corpus_payload() { sed "s|@SANDBOX@|$TMPDIR|g" "$CORPUS/$1"; }

overrun_rows() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type = 'remote_id_guard_overrun';"
}

# ============================================================================
# Case (a) — mismatch → deny, naming the correct remote ref
# ============================================================================
test_case "(a) gh pr create body citing local #5 (gh_iid 42): deny"
out_a=$(run_hook "$(input_bash "gh pr create --title x --body 'Closes #5'")")
assert_contains "$out_a" '"permissionDecision":"deny"' "deny decision"

test_case "(a) deny reason names the correct remote ref #42"
assert_contains "$out_a" "#42" "correct remote ref shown"

test_case "GH 1864: deny reason quotes the local issue's objective"
assert_contains "$out_a" 'local #5: \"Local five | pipe title\"' "objective quoted"

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

# ============================================================================
# Cases (f)-(h) — explicit remote markers (GH 1304)
# ============================================================================
test_case "(f) GH-5 marker: allow (silent)"
out_f=$(run_hook "$(input_bash "gh pr create --body 'Fixes GH-5'")")
assert_eq "" "$out_f" "GH-<n> is an explicit remote id"

test_case "(g) remote:5 and owner/repo#5 markers: allow (silent)"
out_g=$(run_hook "$(input_bash "gh pr create --body 'see remote:5 and trustmybot/plugin#5'")")
assert_eq "" "$out_g" "remote:<n> and owner/repo#<n> are explicit remote ids"

test_case "(g) GL-5 marker: allow (silent)"
out_g2=$(run_hook "$(input_bash "glab mr create --title x --description 'see gl-5'")")
assert_eq "" "$out_g2" "GL-<n> is an explicit remote id"

test_case "(h) GH-5 plus bare #5: deny, reason shows local objective and marker hint"
out_h8=$(run_hook "$(input_bash "gh issue comment 9 --body 'GH-5 and #5'")")
assert_contains "$out_h8" '"permissionDecision":"deny"' "bare #5 still caught"
assert_contains "$out_h8" "#5 → #42 (GitHub)" "mapping shown"
assert_contains "$out_h8" "Local five | pipe title" "local objective shown, pipe intact"
assert_contains "$out_h8" "GH-<n>" "marker hint shown"

# ============================================================================
# GH 1196 — a remote-write named in a heredoc or quoted text is data
# ============================================================================
test_case "GH 1196: markdown heredoc quoting a gh pr create citing #5: allow"
out_h=$(run_hook "$(input_bash "$(printf '%s\n' "cat > notes.md <<'EOF'" "gh pr create --body 'Closes #5'" 'EOF')")")
assert_eq "" "$out_h" "heredoc content is not a remote write"

test_case "GH 1196: echo quoting a gh issue comment citing #5: allow"
out_q=$(run_hook "$(input_bash "echo \"gh issue comment 1 --body 'see #5'\"")")
assert_eq "" "$out_q" "quoted text is not a remote write"

# ============================================================================
# GH 1821 — the guard bounds its own work below dispatch's 6 s budget
# ============================================================================
test_case "GH 1821: heredoc + compound gh api && python3 - <<'EOF' repro: allowed well under 6 s"
t0=$(now_ms)
rc_r=0
out_r=$(corpus_payload bash-gh-api-heredoc-compound.json | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null) || rc_r=$?
elapsed_r=$(( $(now_ms) - t0 ))
assert_exit_code 0 "$rc_r" "repro exit code"
assert_eq "" "$out_r" "repro stdout"
if [ "$elapsed_r" -lt 4000 ]; then _pass; else _fail "repro took ${elapsed_r}ms, want < 4000ms (default 3 s deadline + 1 s)"; fi

PATHOLOGICAL=$(for _ in $(seq 1000); do printf 'echo a && '; done; printf "gh pr create --title x --body 'Closes #5'")

test_case "GH 1821: analysis past TMB_REMOTE_ID_GUARD_DEADLINE_S=1 allows within deadline + 1 s"
before=$(overrun_rows)
t0=$(now_ms)
rc_o=0
out_o=$(input_bash "$PATHOLOGICAL" | TRAJECTORY_DB_PATH="$DB" TMB_REMOTE_ID_GUARD_DEADLINE_S=1 \
  TMB_REMOTE_ID_GUARD_TEST_OVERRUN="$OVERRUN_KNOB" bash "$HOOK" 2>"$TMPDIR/overrun.err") || rc_o=$?
elapsed_o=$(( $(now_ms) - t0 ))
assert_exit_code 0 "$rc_o" "overrun exit code"
assert_eq "" "$out_o" "overrun stdout (no deny JSON)"
if [ "$elapsed_o" -lt 2000 ]; then _pass; else _fail "overrun took ${elapsed_o}ms, want < 2000ms"; fi

test_case "GH 1821: overrun prints one stderr line naming the deadline"
err_o=$(cat "$TMPDIR/overrun.err")
assert_eq "1" "$(printf '%s\n' "$err_o" | grep -c .)" "stderr line count"
assert_contains "$err_o" "1s deadline (TMB_REMOTE_ID_GUARD_DEADLINE_S)" "stderr names the deadline"

test_case "GH 1821: overrun writes one remote_id_guard_overrun audit row"
after=$(overrun_rows)
assert_eq "$((before + 1))" "$after" "overrun row count"
if [ "$after" -gt 0 ]; then _pass; else _fail "no remote_id_guard_overrun rows"; fi
row_o=$(sqlite3 "$DB" "SELECT issue_id || '|' || from_node || '|' || content_json FROM audit WHERE event_type = 'remote_id_guard_overrun' ORDER BY id DESC LIMIT 1;")
assert_eq "-1|hook:remote-id-guard" "$(printf '%s' "$row_o" | cut -d'|' -f1-2)" "issue and from_node"
content_o=$(printf '%s' "$row_o" | cut -d'|' -f3-)
assert_eq "1" "$(printf '%s' "$content_o" | jq -r '.deadline_s')" "content_json.deadline_s"
if printf '%s' "$content_o" | jq -e '(.elapsed_s | type) == "number" and .elapsed_s >= 1' >/dev/null; then _pass; else _fail "content_json.elapsed_s: $content_o"; fi

test_case "GH 1821: overrun leaves no process of the guard behind"
sleep 0.3
pg_rc=0
pgrep -f "$HOOK" >/dev/null 2>&1 || pg_rc=$?
case "$pg_rc" in
  1) _pass ;;
  0) _fail "a $HOOK process survived the overrun: $(pgrep -fl "$HOOK" || true)" ;;
  *) printf 'SKIP %s — pgrep cannot list processes here (exit %s)\n' "$CURRENT_TEST" "$pg_rc" ;;
esac

test_case "GH 1821: overrun with no trajectory DB still allows"
rc_o2=0
out_o2=$(input_bash "$PATHOLOGICAL" | TRAJECTORY_DB_PATH="$TMPDIR/no-such.db" TMB_REMOTE_ID_GUARD_DEADLINE_S=1 \
  TMB_REMOTE_ID_GUARD_TEST_OVERRUN="$OVERRUN_KNOB" bash "$HOOK" 2>/dev/null) || rc_o2=$?
assert_exit_code 0 "$rc_o2" "overrun without DB exit code"
assert_eq "" "$out_o2" "overrun without DB stdout"

test_case "GH 1821: an invalid TMB_REMOTE_ID_GUARD_DEADLINE_S falls back to the default"
out_inv=$(input_bash "gh pr create --title x --body 'Closes #5'" | TRAJECTORY_DB_PATH="$DB" TMB_REMOTE_ID_GUARD_DEADLINE_S=abc \
  bash "$HOOK" 2>/dev/null || true)
assert_contains "$out_inv" '"permissionDecision":"deny"' "deny under the default deadline"

# ============================================================================
# Hook corpus — the payloads a TS port (GH 1692) inherits
# ============================================================================
printf 'this is not a sqlite database\n' > "$TMPDIR/bad.db"
for f in "$CORPUS"/*.json; do
  name=$(basename "$f")
  test_case "corpus $name"
  if grep -q '@NO[A-Z]*_PATH@' "$f"; then
    printf 'SKIP %s — its PATH without jq or sqlite3 runs in hooks-remote-id-guard-parity\n' "$CURRENT_TEST"
    continue
  fi
  expect_c=$(jq -r --arg impl "$HOOK_IMPL" '.corpus_expect | if type == "object" then .[$impl] else . end' "$f")
  env_c=()
  while IFS= read -r kv; do env_c+=("$kv"); done < <(corpus_payload "$name" | jq -r '(.corpus_env // {}) | to_entries[] | "\(.key)=\(.value)"')
  rc_c=0
  out_c=$(corpus_payload "$name" | jq -c 'del(.corpus_env, .corpus_expect, .corpus_divergent)' \
    | env TRAJECTORY_DB_PATH="$DB" ${env_c[@]+"${env_c[@]}"} bash "$HOOK" 2>/dev/null) || rc_c=$?
  assert_exit_code 0 "$rc_c" "$name exit code"
  if [ "$expect_c" = allow ]; then
    assert_eq "" "$out_c" "$name allows"
  else
    assert_contains "$out_c" '"permissionDecision":"deny"' "$name denies"
    reason_c=$(printf '%s' "$out_c" | jq -r '.hookSpecificOutput.permissionDecisionReason')
    assert_contains "$reason_c" "$expect_c" "$name deny reason"
  fi
done

summarize
