#!/usr/bin/env bash
# Tests for scripts/hooks/dispatch.sh + scripts/hooks/lib/resolve-install.sh.
#   One execution per (event, payload, gate):
#     - two concurrent invocations, deny gate      → gate ran once, both deny
#     - two concurrent invocations, allow gate     → gate ran once, one output
#     - different tool_input                       → both run
#     - SessionStart keys on session_id | gate     → prescan-style gate once
#     - duplicate right after the holder finished  → deny replayed, gate not rerun
#     - identical event after the window (retry)   → gate runs again
#     - result older than the TTL                  → pruned
#     - stale lock (holder killed)                 → reclaimed by mtime
#     - un-onboarded project                       → gate runs, no locks dir
#   One install per project:
#     - project install B named in installed_plugins.json → B's gate runs from A
#     - project beats user; user-only → user; missing installPath skipped
#     - no entry → local; a dev checkout is never redirected, even by a
#       project or user entry for this project; a cached install in the
#       manifest keeps project > user precedence
#     - two project installs → newest, stderr notice naming both
#   Missing gate: invalid name or gate script in no install → rc 1 + stderr;
#     resolved install lacking the gate → dispatcher's own copy, logged
#   Fail closed: a gate registered "onFailure": "block" that dies or is missing
#     → deny (PreToolUse) or decision block (other events), exit 0; an
#     observe-only hook keeps its exit code and output
#   Shim: marker for the session → yield; foreign project → yield
#   Chain trajectory-gates: fixed order, first deny ends it (a later gate's
#     marker is never written), allows pass through, routing by tool name,
#     context joined into one output, one lock per gate, a dying gate denies,
#     a gate past its chain-table timeout is killed and denies (also without
#     pgrep, leaving no process behind), two trivial gates stay within a
#     latency budget of one, a duplicate
#     chain whose waiter gives up ends without running later gates, and a
#     chain stays fail-closed without hooks.json or lib/registrations.sh;
#     real gates: agent-arg deny keeps swe-brief-gate's sentinel unwritten
#   No jq: a fail-closed gate or chain denies naming jq, an observe-only
#     registration still runs; registration resolution without jq equals the
#     jq reading for every hooks.json entry, whatever the key order
#   Symlinked project dir and its real path → one lock, one shim project
#   Parity: every PreToolUse gate in hooks.json gives the same stdout + exit
#   code through the dispatcher as run directly.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
cd "$TMP"
unset CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR TRAJECTORY_DB_PATH TMB_SHIM_PROJECT
export TMB_INSTALLED_JSON="$TMP/installed_plugins.json"
RUNS="$TMP/runs.log"
CACHE="$TMP/claude/plugins/cache/mp/tmb"

# make_install <root> <label> — a plugin root with the real dispatcher + libs
# and fixture gates that log "<label>" to $RUNS.
make_install() {
  local root="$1" label="$2"
  mkdir -p "$root/scripts/hooks/lib" "$root/.claude-plugin" "$root/hooks"
  cp "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" "$root/scripts/hooks/"
  cp "$PLUGIN_ROOT/scripts/hooks/lib/"*.sh "$root/scripts/hooks/lib/"
  printf '{"name":"tmb"}\n' > "$root/.claude-plugin/plugin.json"
  cat > "$root/hooks/hooks.json" <<'EOF'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-deny","timeout":6},
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-allow","timeout":6},
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-gate-dies","timeout":6,"onFailure":"block"},
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-gate-dies-deny","timeout":6,"onFailure":"block"},
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-gate-gone","timeout":6,"onFailure":"block"},
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-observe-dies","timeout":6}]}],
"SubagentStop":[{"matcher":"","hooks":[
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-gate-dies","timeout":6,"onFailure":"block"}]}]}}
EOF
  cat > "$root/scripts/hooks/fx-deny.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo "$label \${CLAUDE_PLUGIN_ROOT}" >> "$RUNS"
sleep "\${FX_SLEEP:-1}"
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fx"}}'
EOF
  cat > "$root/scripts/hooks/fx-allow.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo "$label \${CLAUDE_PLUGIN_ROOT}" >> "$RUNS"
sleep "\${FX_SLEEP:-1}"
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"fx banner"}}'
EOF
  cat > "$root/scripts/hooks/fx-rc2.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo "$label" >> "$RUNS"
echo "fx blocked" >&2
exit 2
EOF
  cat > "$root/scripts/hooks/fx-gate-dies.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo "$label" >> "$RUNS"
echo "partial output"
exit 1
EOF
  cat > "$root/scripts/hooks/fx-gate-dies-deny.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fx own deny"}}'
exit 1
EOF
  cp "$root/scripts/hooks/fx-gate-dies.sh" "$root/scripts/hooks/fx-observe-dies.sh"
  chmod +x "$root/scripts/hooks/"*.sh
}

A="$CACHE/1.0.0"
B="$CACHE/2.0.0"
DEV="$TMP/checkout/plugin"
make_install "$A" A
make_install "$B" B
make_install "$DEV" DEV

PROJ="$TMP/proj"
mkdir -p "$PROJ/.claude/tmb"
sqlite3 "$PROJ/.claude/tmb/trajectory.db" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);"
export CLAUDE_PROJECT_DIR="$PROJ"
EVENTS="$PROJ/.claude/tmb/locks/events"

payload() {
  jq -nc --arg c "${1:-echo hi}" --arg id "${2:-tu-1}" \
    '{hook_event_name:"PreToolUse",session_id:"s-1",tool_name:"Bash",tool_input:{command:$c},tool_use_id:$id}'
}

# dispatch <root> <gate> <payload> [args...]
dispatch() {
  local root="$1" gate="$2" p="$3"
  shift 3
  printf '%s' "$p" | CLAUDE_PLUGIN_ROOT="$root" bash "$root/scripts/hooks/dispatch.sh" "$gate" "$@"
}

runs() { [ -f "$RUNS" ] && wc -l < "$RUNS" | tr -d ' ' || echo 0; }
reset_runs() { rm -f "$RUNS"; rm -rf "$EVENTS"; }

# ===========================================================================
test_case "concurrent duplicates of a deny gate: gate runs once, both deny"
reset_runs
P=$(payload "git push" tu-deny)
dispatch "$A" fx-deny "$P" > "$TMP/o1" &
dispatch "$A" fx-deny "$P" > "$TMP/o2" &
wait
assert_eq "1" "$(runs)" "gate executed once"
assert_contains "$(cat "$TMP/o1")" '"permissionDecision":"deny"' "first invocation denies"
assert_contains "$(cat "$TMP/o2")" '"permissionDecision":"deny"' "second invocation replays the deny"

# ===========================================================================
test_case "concurrent duplicates of an allow gate: gate runs once, output once"
reset_runs
P=$(payload "ls" tu-allow)
dispatch "$A" fx-allow "$P" > "$TMP/o1" &
dispatch "$A" fx-allow "$P" > "$TMP/o2" &
wait
assert_eq "1" "$(runs)" "gate executed once"
assert_eq "1" "$(cat "$TMP/o1" "$TMP/o2" | grep -c 'fx banner')" "banner emitted exactly once"

# ===========================================================================
test_case "different tool_input: both run"
reset_runs
dispatch "$A" fx-allow "$(payload "ls a" tu-x)" > /dev/null &
dispatch "$A" fx-allow "$(payload "ls b" tu-x)" > /dev/null &
wait
assert_eq "2" "$(runs)" "both executed"

# ===========================================================================
test_case "SessionStart: keyed on session_id | gate"
reset_runs
dispatch "$A" fx-allow '{"hook_event_name":"SessionStart","session_id":"s-9","source":"startup"}' > "$TMP/o1" &
dispatch "$B" fx-allow '{"hook_event_name":"SessionStart","session_id":"s-9","source":"startup","extra":1}' > "$TMP/o2" &
wait
assert_eq "1" "$(runs)" "SessionStart gate executed once across two installs"

# ===========================================================================
test_case "duplicate right after the holder finished: deny replayed, gate not rerun"
reset_runs
P=$(payload "rm x" tu-seq)
FX_SLEEP=0 dispatch "$A" fx-deny "$P" > /dev/null
out=$(FX_SLEEP=0 dispatch "$A" fx-deny "$P")
assert_eq "1" "$(runs)" "gate executed once"
assert_contains "$out" '"permissionDecision":"deny"' "deny replayed"
rc=0
FX_SLEEP=0 dispatch "$A" fx-rc2 "$P" > /dev/null 2>&1 || true
err=$(dispatch "$A" fx-rc2 "$P" 2>&1 >/dev/null) || rc=$?
assert_eq "2" "$rc" "exit-2 deny replayed"
assert_contains "$err" "fx blocked" "exit-2 reason replayed on stderr"
assert_eq "2" "$(runs)" "rc-2 gate executed once"

# ===========================================================================
test_case "identical event after the duplicate window: gate runs again"
reset_runs
P=$(payload "git status" tu-retry)
FX_SLEEP=0 TMB_DISPATCH_WINDOW_S=0 dispatch "$A" fx-allow "$P" > /dev/null
sleep 1.2
out=$(FX_SLEEP=0 TMB_DISPATCH_WINDOW_S=0 dispatch "$A" fx-allow "$P")
assert_eq "2" "$(runs)" "retry executed the gate"
assert_contains "$out" "fx banner" "retry output emitted"

# ===========================================================================
test_case "result older than the TTL is pruned"
reset_runs
mkdir -p "$EVENTS/oldkey"
echo 0 > "$EVENTS/oldkey/rc"
touch -t 202001010000 "$EVENTS/oldkey"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls ttl" tu-ttl)" > /dev/null
[ ! -d "$EVENTS/oldkey" ] && _pass || _fail "stale result dir not pruned"

# ===========================================================================
test_case "stale lock (holder killed) is reclaimed by mtime"
reset_runs
P=$(payload "git commit" tu-stale)
FX_SLEEP=0 dispatch "$A" fx-deny "$P" > /dev/null
key=$(find "$EVENTS" -mindepth 1 -maxdepth 1 -type d | head -1)
rm -f "$key/rc" "$key/result" "$key/stderr"
touch -t 202001010000 "$key"
out=$(FX_SLEEP=0 dispatch "$A" fx-deny "$P")
assert_eq "2" "$(runs)" "gate re-executed after reclaim"
assert_contains "$out" '"permissionDecision":"deny"' "reclaimer emits the gate's deny"

# ===========================================================================
test_case "un-onboarded project: gate runs, no locks dir created"
reset_runs
BARE="$TMP/bare"
mkdir -p "$BARE"
out=$(FX_SLEEP=0 CLAUDE_PROJECT_DIR="$BARE" dispatch "$A" fx-deny "$(payload)")
assert_contains "$out" '"permissionDecision":"deny"' "gate decision forwarded"
assert_eq "1" "$(runs)" "gate executed"
[ ! -e "$BARE/.claude" ] && _pass || _fail "dispatcher wrote into a non-TMB project"

# ===========================================================================
manifest() { printf '{"version":2,"plugins":{%s}}\n' "$1" > "$TMB_INSTALLED_JSON"; }
entry() { printf '{"scope":"%s","projectPath":"%s","installPath":"%s","installedAt":"%s","version":"%s"}' "$1" "$2" "$3" "$4" "$5"; }
ran_from() { tail -1 "$RUNS" | cut -d' ' -f1; }

test_case "invocation from install A runs project install B's gate"
reset_runs
manifest "\"tmb@mp\":[$(entry local "$PROJ" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r1" tu-r1)" > /dev/null
assert_eq "B" "$(ran_from)" "B's gate executed"
assert_eq "B $B" "$(tail -1 "$RUNS")" "CLAUDE_PLUGIN_ROOT points at B"

test_case "project install beats user install"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$A" 2026-06-01T00:00:00.000Z 1.0.0)],\"tmb@mp2\":[$(entry project "$PROJ" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r2" tu-r2)" > /dev/null
assert_eq "B" "$(ran_from)" "project install executed"

test_case "user-only: the user install runs; another project's entry is ignored"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$A" 2026-06-01T00:00:00.000Z 1.0.0),$(entry local "$TMP/elsewhere" "$B" 2026-07-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$B" fx-allow "$(payload "ls r3" tu-r3)" > /dev/null
assert_eq "A" "$(ran_from)" "user install executed"

test_case "missing installPath is skipped"
reset_runs
manifest "\"tmb@mp\":[$(entry local "$PROJ" "$CACHE/9.9.9" 2026-09-01T00:00:00.000Z 9.9.9),$(entry user "" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r4" tu-r4)" > /dev/null
assert_eq "B" "$(ran_from)" "existing user install executed"

test_case "no entry: the invoking install runs its own gate"
reset_runs
rm -f "$TMB_INSTALLED_JSON"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r5" tu-r5)" > /dev/null
assert_eq "A" "$(ran_from)" "local gate executed"

test_case "dev checkout is never redirected to a user install"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$A" 2026-06-01T00:00:00.000Z 1.0.0)]"
FX_SLEEP=0 dispatch "$DEV" fx-allow "$(payload "ls r6" tu-r6)" > /dev/null
assert_eq "DEV" "$(ran_from)" "dev checkout ran its own gate"

test_case "two project installs: newest wins, notice names both"
reset_runs
manifest "\"tmb@mp\":[$(entry local "$PROJ" "$A" 2026-01-01T00:00:00.000Z 1.0.0)],\"tmb@mp2\":[$(entry project "$PROJ" "$B" 2026-05-01T00:00:00.000Z 2.0.0)]"
err=$(FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r7" tu-r7)" 2>&1 >/dev/null)
assert_eq "B" "$(ran_from)" "newest project install executed"
assert_contains "$err" "$B" "notice names the winner"
assert_contains "$err" "$A" "notice names the ignored install"
rm -f "$TMB_INSTALLED_JSON"

test_case "dev checkout runs its own gate despite a project entry for this project"
reset_runs
manifest "\"tmb@mp\":[$(entry local "$PROJ" "$B" 2026-06-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$DEV" fx-allow "$(payload "ls r8" tu-r8)" > /dev/null
assert_eq "DEV $DEV" "$(tail -1 "$RUNS")" "dev checkout ran its own gate with its own CLAUDE_PLUGIN_ROOT"

test_case "dev checkout runs its own gate despite project and user entries"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$A" 2026-06-01T00:00:00.000Z 1.0.0)],\"tmb@mp2\":[$(entry project "$PROJ" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$DEV" fx-allow "$(payload "ls r9" tu-r9)" > /dev/null
assert_eq "DEV" "$(ran_from)" "dev checkout ran its own gate"

test_case "cached install named in the manifest keeps project > user precedence"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$A" 2026-06-01T00:00:00.000Z 1.0.0)],\"tmb@mp2\":[$(entry project "$PROJ" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$A" fx-allow "$(payload "ls r10" tu-r10)" > /dev/null
assert_eq "B" "$(ran_from)" "project install executed from the cached user install"

test_case "checkout named in the manifest is not a dev checkout: project entry wins"
reset_runs
manifest "\"tmb@mp\":[$(entry user "" "$DEV" 2026-06-01T00:00:00.000Z 0.0.0)],\"tmb@mp2\":[$(entry project "$PROJ" "$B" 2026-01-01T00:00:00.000Z 2.0.0)]"
FX_SLEEP=0 dispatch "$DEV" fx-allow "$(payload "ls r11" tu-r11)" > /dev/null
assert_eq "B" "$(ran_from)" "project install executed"
rm -f "$TMB_INSTALLED_JSON"

# ===========================================================================
test_case "invalid gate name: rc 1 with a stderr line"
reset_runs
rc=0
err=$(dispatch "$A" "Bad_Gate" "$(payload "ls g1" tu-g1)" 2>&1 >/dev/null) || rc=$?
assert_eq "1" "$rc" "exit 1"
assert_contains "$err" "invalid gate name 'Bad_Gate'" "stderr names the gate"
rc=0
err=$(printf '%s' "$(payload)" | CLAUDE_PLUGIN_ROOT="$A" bash "$A/scripts/hooks/dispatch.sh" 2>&1 >/dev/null) || rc=$?
assert_eq "1" "$rc" "no gate argument: exit 1"
assert_contains "$err" "invalid gate name" "stderr line for a missing argument"

test_case "gate script in no install: rc 1 with a stderr line"
reset_runs
rc=0
err=$(dispatch "$A" fx-absent "$(payload "ls g2" tu-g2)" 2>&1 >/dev/null) || rc=$?
assert_eq "1" "$rc" "exit 1"
assert_contains "$err" "no gate fx-absent.sh in $A" "stderr names the gate and install"
assert_eq "0" "$(runs)" "nothing ran"

test_case "resolved install lacks the gate: dispatcher's own copy runs, logged"
reset_runs
cat > "$A/scripts/hooks/fx-only-a.sh" <<EOF2
#!/usr/bin/env bash
cat >/dev/null
echo "A \${CLAUDE_PLUGIN_ROOT}" >> "$RUNS"
EOF2
chmod +x "$A/scripts/hooks/fx-only-a.sh"
manifest "\"tmb@mp\":[$(entry local "$PROJ" "$B" 2026-06-01T00:00:00.000Z 2.0.0)]"
rc=0
err=$(dispatch "$A" fx-only-a "$(payload "ls g3" tu-g3)" 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "fallback gate exit code"
assert_eq "A $A" "$(tail -1 "$RUNS")" "dispatcher's own gate ran with its own CLAUDE_PLUGIN_ROOT"
assert_contains "$err" "no gate fx-only-a.sh in $B — using $A" "fallback logged on stderr"
rm -f "$TMB_INSTALLED_JSON" "$A/scripts/hooks/fx-only-a.sh"

# ===========================================================================
test_case "--shim yields when the plugin hooks marked this session"
reset_runs
mkdir -p "$PROJ/.claude/tmb/sessions"
: > "$PROJ/.claude/tmb/sessions/s-1.plugin-hooks"
out=$(TMB_SHIM_PROJECT="$PROJ" dispatch "$A" fx-deny "$(payload "ls s1" tu-s1)" --shim)
assert_eq "" "$out" "no decision"
assert_eq "0" "$(runs)" "gate not run"
rm -f "$PROJ/.claude/tmb/sessions/s-1.plugin-hooks"

test_case "--shim yields for a foreign project"
out=$(TMB_SHIM_PROJECT="$TMP/other" dispatch "$A" fx-deny "$(payload "ls s2" tu-s2)" --shim)
assert_eq "" "$out" "no decision"
assert_eq "0" "$(runs)" "gate not run"

test_case "--shim without a marker runs the gate"
out=$(FX_SLEEP=0 TMB_SHIM_PROJECT="$PROJ" dispatch "$A" fx-deny "$(payload "ls s3" tu-s3)" --shim)
assert_contains "$out" '"permissionDecision":"deny"' "gate decision forwarded"
assert_eq "1" "$(runs)" "gate ran"

# ===========================================================================
test_case "symlinked and real project path share one lock: gate runs once"
reset_runs
LINK="$TMP/proj-link"
ln -s "$PROJ" "$LINK"
P=$(payload "git push link" tu-link)
CLAUDE_PROJECT_DIR="$LINK" dispatch "$A" fx-deny "$P" > "$TMP/o1" &
CLAUDE_PROJECT_DIR="$PROJ" dispatch "$A" fx-deny "$P" > "$TMP/o2" &
wait
assert_eq "1" "$(runs)" "gate executed once across the two spellings"
assert_contains "$(cat "$TMP/o2")" '"permissionDecision":"deny"' "the real-path invocation replays the deny"
assert_eq "1" "$(find "$EVENTS" -mindepth 1 -maxdepth 1 -type d | grep -c .)" "one lock directory"

test_case "--shim: a symlinked TMB_SHIM_PROJECT is the same project as the real CLAUDE_PROJECT_DIR"
reset_runs
out=$(FX_SLEEP=0 TMB_SHIM_PROJECT="$LINK" dispatch "$A" fx-deny "$(payload "ls s4" tu-s4)" --shim)
assert_contains "$out" '"permissionDecision":"deny"' "gate ran, not yielded as foreign"
mkdir -p "$PROJ/.claude/tmb/sessions"
: > "$PROJ/.claude/tmb/sessions/s-1.plugin-hooks"
out=$(CLAUDE_PROJECT_DIR="$LINK" TMB_SHIM_PROJECT="$PROJ" dispatch "$A" fx-deny "$(payload "ls s5" tu-s5)" --shim)
assert_eq "" "$out" "marker found through the symlinked project dir"
rm -f "$PROJ/.claude/tmb/sessions/s-1.plugin-hooks" "$LINK"

# ===========================================================================
# fail_closed_cases <project dir> <label> — a gate registered with
# "onFailure": "block" never ends without a decision; other hooks keep theirs.
is_deny() { printf '%s' "$1" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; }
fail_closed_cases() {
  local proj="$1" label="$2" rc out err
  test_case "fail-closed ($label): gate exits 1 without JSON → dispatcher denies, exit 0"
  reset_runs
  rc=0
  out=$(CLAUDE_PROJECT_DIR="$proj" dispatch "$A" fx-gate-dies "$(payload "ls fc1-$label" tu-fc1)" 2>"$TMP/err") || rc=$?
  assert_eq "0" "$rc" "exit 0 so the decision is read"
  is_deny "$out" && _pass || _fail "no deny JSON: $out"
  assert_contains "$out" "fx-gate-dies exited 1" "reason names the gate and exit code"
  assert_contains "$(cat "$TMP/err")" "failing closed" "stderr line"
  assert_eq "1" "$(runs)" "gate ran"

  test_case "fail-closed ($label): gate prints its own deny then exits 1 → its deny, exit 0"
  rc=0
  out=$(CLAUDE_PROJECT_DIR="$proj" dispatch "$A" fx-gate-dies-deny "$(payload "ls fc2-$label" tu-fc2)" 2>/dev/null) || rc=$?
  assert_eq "0" "$rc" "exit 0"
  assert_contains "$out" "fx own deny" "the gate's own deny kept"

  test_case "fail-closed ($label): gate script missing → dispatcher denies"
  rc=0
  out=$(CLAUDE_PROJECT_DIR="$proj" dispatch "$A" fx-gate-gone "$(payload "ls fc3-$label" tu-fc3)" 2>"$TMP/err") || rc=$?
  assert_eq "0" "$rc" "exit 0"
  is_deny "$out" && _pass || _fail "no deny JSON: $out"
  assert_contains "$(cat "$TMP/err")" "no gate fx-gate-gone.sh" "stderr names the missing script"

  test_case "fail-closed ($label): SubagentStop gate dies → decision block"
  out=$(CLAUDE_PROJECT_DIR="$proj" dispatch "$A" fx-gate-dies '{"hook_event_name":"SubagentStop","session_id":"s-1","agent_id":"ag-'"$label"'"}' 2>/dev/null) || true
  assert_eq "block" "$(printf '%s' "$out" | jq -r '.decision' 2>/dev/null)" "decision block for a non-tool event"

  test_case "fail-closed ($label): observe-only hook exits 1 → exit 1 and its output, no deny"
  reset_runs
  rc=0
  out=$(CLAUDE_PROJECT_DIR="$proj" dispatch "$A" fx-observe-dies "$(payload "ls fc4-$label" tu-fc4)" 2>/dev/null) || rc=$?
  assert_eq "1" "$rc" "exit code kept (Claude Code continues)"
  assert_eq "partial output" "$out" "output passed through"
  assert_eq "1" "$(runs)" "hook ran"
}
fail_closed_cases "$PROJ" locked
fail_closed_cases "$TMP/bare" unlocked
[ ! -e "$TMP/bare/.claude" ] && _pass || _fail "fail-closed path wrote into a non-TMB project"

test_case "fail-closed: a duplicate of a dead gate replays the dispatcher's deny"
reset_runs
P=$(payload "ls fc5" tu-fc5)
dispatch "$A" fx-gate-dies "$P" >/dev/null 2>&1
out=$(dispatch "$A" fx-gate-dies "$P" 2>/dev/null)
is_deny "$out" && _pass || _fail "duplicate did not replay the deny: $out"
assert_eq "1" "$(runs)" "gate ran once"

# ===========================================================================
# Chain: an install whose trajectory-gates members are fixture gates that log
# their name, deny when named in FX_DENY, add context when named in FX_CTX and
# exit 1 when named in FX_DIE.
C="$TMP/chain-install"
make_install "$C" C
cat > "$C/hooks/hooks.json" <<'EOF'
{"hooks":{"PreToolUse":[{"matcher":"mcp__.*trajectory-server__.*","hooks":[
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" trajectory-gates","timeout":1842,"onFailure":"block"}]},
  {"matcher":"Bash","hooks":[
  {"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-allow","timeout":6}]}]}}
EOF
for g in agent-arg-matches-caller swe-brief-gate swe-verification-gate reviewer-identity-observe cheatcode-install-approval; do
  cat > "$C/scripts/hooks/$g.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo "$g" >> "$RUNS"
case " \${FX_SLOW:-} " in *" $g "*) sleep "\${FX_SLOW_S:-8}"; echo "$g" >> "$TMP/slow-done" ;; esac
case " \${FX_DIE:-} " in *" $g "*) exit 1 ;; esac
case " \${FX_DENY:-} " in *" $g "*)
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by $g"}}'; exit 0 ;;
esac
case " \${FX_CTX:-} " in *" $g "*)
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"ctx $g"}}' ;;
esac
exit 0
EOF
  chmod +x "$C/scripts/hooks/$g.sh"
done

tpayload() {
  jq -nc --arg t "$1" --arg id "${2:-tu-c}" \
    '{hook_event_name:"PreToolUse",session_id:"s-c",tool_name:("mcp__plugin_tmb_trajectory-server__" + $t),tool_input:{agent:"bro"},tool_use_id:$id}'
}
chain() { dispatch "$C" trajectory-gates "$(tpayload "$1" "${2:-tu-$1}")"; }
ran() { [ -f "$RUNS" ] && paste -sd, - < "$RUNS" || true; }

test_case "chain: an early deny ends the chain; later gates never run"
reset_runs
rc=0
out=$(FX_DENY=agent-arg-matches-caller chain task_update_status tu-c1) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_contains "$out" "denied by agent-arg-matches-caller" "the first gate's deny returned"
assert_eq "agent-arg-matches-caller" "$(ran)" "swe-brief-gate and swe-verification-gate never ran"

test_case "chain: the first deny wins"
reset_runs
out=$(FX_DENY="swe-brief-gate swe-verification-gate" chain task_update_status tu-c2)
assert_contains "$out" "denied by swe-brief-gate" "swe-brief-gate's deny"
assert_not_contains "$out" "denied by swe-verification-gate" "no later deny"
assert_eq "agent-arg-matches-caller,swe-brief-gate" "$(ran)" "stopped at swe-brief-gate"

test_case "chain: allows pass through every gate in order"
reset_runs
rc=0
out=$(chain task_update_status tu-c3) || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_eq "" "$out" "no output"
assert_eq "agent-arg-matches-caller,swe-brief-gate,swe-verification-gate" "$(ran)" "fixed order"

test_case "chain: routing by tool name"
reset_runs
chain validation_record tu-c4 >/dev/null
assert_eq "agent-arg-matches-caller,swe-brief-gate,reviewer-identity-observe" "$(ran)" "validation_record → reviewer-identity-observe"
reset_runs
chain cheatcode_install tu-c5 >/dev/null
assert_eq "agent-arg-matches-caller,swe-brief-gate,cheatcode-install-approval" "$(ran)" "cheatcode_install → cheatcode-install-approval"
reset_runs
chain issue_get tu-c6 >/dev/null
assert_eq "agent-arg-matches-caller,swe-brief-gate" "$(ran)" "issue_get → neither tool-specific gate"

test_case "chain: context outputs are joined into one output"
reset_runs
out=$(FX_CTX="agent-arg-matches-caller swe-verification-gate" chain task_update_status tu-c7)
assert_eq "1" "$(printf '%s\n' "$out" | grep -c .)" "one line"
assert_eq "$(printf 'ctx agent-arg-matches-caller\n\nctx swe-verification-gate')" "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')" "both contexts, in order"
out=$(FX_CTX="swe-brief-gate" chain task_update_status tu-c8)
assert_eq "ctx swe-brief-gate" "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')" "a single context passes through"

test_case "chain: one dedupe key per gate"
reset_runs
chain task_update_status tu-c9 >/dev/null
assert_eq "3" "$(find "$EVENTS" -mindepth 1 -maxdepth 1 -type d | grep -c .)" "three lock directories for three gates"
reset_runs
P=$(tpayload task_update_status tu-c10)
FX_SLEEP=0 dispatch "$C" trajectory-gates "$P" > "$TMP/o1" &
FX_SLEEP=0 dispatch "$C" trajectory-gates "$P" > "$TMP/o2" &
wait
assert_eq "3" "$(runs)" "two concurrent chains run each gate once"

test_case "chain: a dying gate denies and ends the chain"
reset_runs
out=$(FX_DIE=swe-brief-gate chain task_update_status tu-c11 2>/dev/null)
is_deny "$out" && _pass || _fail "no deny: $out"
assert_contains "$out" "swe-brief-gate exited 1" "reason names the gate"
assert_eq "agent-arg-matches-caller,swe-brief-gate" "$(ran)" "swe-verification-gate never ran"

test_case "chain: a gate past its chain-table timeout is killed and denies; later gates never run"
reset_runs
rm -f "$TMP/slow-done"
started=$SECONDS
out=$(FX_SLOW=swe-brief-gate FX_SLOW_S=9 chain task_update_status tu-c13 2>/dev/null)
elapsed=$((SECONDS - started))
is_deny "$out" && _pass || _fail "no deny: $out"
assert_contains "$out" "swe-brief-gate ran past its 6 s budget" "reason names the gate and its budget"
[ "$elapsed" -lt 9 ] && _pass || _fail "the chain waited ${elapsed}s for the slow gate"
assert_eq "agent-arg-matches-caller,swe-brief-gate" "$(ran)" "swe-verification-gate never ran"
sleep 4
[ ! -e "$TMP/slow-done" ] && _pass || _fail "the slow gate kept running after the deny"

test_case "chain without pgrep: an overrunning gate leaves no survivor, an allow leaves no watchdog"
. "$HERE/fixtures/no-jq-path.sh"
NOPG=$(no_cmd_path "$TMP/nopgrep" pgrep)
survivors() { ps -A -o args= 2>/dev/null | grep -cE "^sleep $1\$" || true; }
reset_runs
out=$(tpayload task_update_status tu-c17 | PATH="$NOPG" FX_SLOW=agent-arg-matches-caller FX_SLOW_S=12.37 CLAUDE_PLUGIN_ROOT="$C" bash "$C/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null)
assert_contains "$out" "agent-arg-matches-caller ran past its 6 s budget" "overrun denies"
assert_eq "0" "$(survivors 12.37)" "the gate's sleep was killed with it"
reset_runs
out=$(tpayload task_update_status tu-c18 | PATH="$NOPG" CLAUDE_PLUGIN_ROOT="$C" bash "$C/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null)
assert_eq "agent-arg-matches-caller,swe-brief-gate,swe-verification-gate" "$(ran)" "the allow ran every gate"
assert_eq "0" "$(survivors 1830)" "no watchdog sleep left behind"

test_case "chain latency: two trivial gates stay within twice one gate + 100 ms"
ms() { perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'; }
median() { sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'; }
single=$(for i in 1 2 3 4 5 6 7; do
  a=$(ms); tpayload issue_get "tu-lat-s$i" | CLAUDE_PLUGIN_ROOT="$C" bash "$C/scripts/hooks/dispatch.sh" agent-arg-matches-caller --chain trajectory-gates >/dev/null 2>&1; b=$(ms)
  echo $((b - a)); done | median)
chained=$(for i in 1 2 3 4 5 6 7; do
  a=$(ms); tpayload issue_get "tu-lat-c$i" | CLAUDE_PLUGIN_ROOT="$C" bash "$C/scripts/hooks/dispatch.sh" trajectory-gates >/dev/null 2>&1; b=$(ms)
  echo $((b - a)); done | median)
[ "$chained" -le $((single * 2 + 100)) ] && _pass || _fail "chain ${chained} ms > 2 x ${single} ms + 100 ms"

test_case "chain: a duplicate chain whose waiter gives up ends without running later gates"
reset_runs
P=$(tpayload task_update_status tu-c14)
FX_DENY=agent-arg-matches-caller FX_SLOW=agent-arg-matches-caller FX_SLOW_S=5.5 dispatch "$C" trajectory-gates "$P" > "$TMP/o1" 2>/dev/null &
FX_DENY=agent-arg-matches-caller FX_SLOW=agent-arg-matches-caller FX_SLOW_S=5.5 dispatch "$C" trajectory-gates "$P" > "$TMP/o2" 2>/dev/null &
wait
assert_contains "$(cat "$TMP/o1" "$TMP/o2")" "denied by agent-arg-matches-caller" "the holder's chain denies"
assert_eq "agent-arg-matches-caller" "$(ran)" "agent-arg ran once; swe-brief-gate never ran"

test_case "chain: fail-closed without hooks.json or lib/registrations.sh"
reset_runs
mv "$C/hooks/hooks.json" "$C/hooks/hooks.json.off"
out=$(FX_DIE=agent-arg-matches-caller chain task_update_status tu-c15 2>/dev/null)
is_deny "$out" && _pass || _fail "no hooks.json: no deny: $out"
assert_eq "agent-arg-matches-caller" "$(ran)" "no hooks.json: a failed gate ends the chain"
mv "$C/hooks/hooks.json.off" "$C/hooks/hooks.json"
reset_runs
mv "$C/scripts/hooks/lib/registrations.sh" "$C/scripts/hooks/lib/registrations.sh.off"
rc=0
out=$(chain task_update_status tu-c16 2>"$TMP/err") || rc=$?
assert_eq "0" "$rc" "no registrations.sh: exit 0"
is_deny "$out" && _pass || _fail "no registrations.sh: no deny: $out"
assert_contains "$(cat "$TMP/err")" "could not load lib/registrations.sh" "stderr names the library"
assert_eq "" "$(ran)" "no gate ran"
mv "$C/scripts/hooks/lib/registrations.sh.off" "$C/scripts/hooks/lib/registrations.sh"

test_case "chain: --shim yields when the plugin hooks marked this session"
reset_runs
mkdir -p "$PROJ/.claude/tmb/sessions"
: > "$PROJ/.claude/tmb/sessions/s-c.plugin-hooks"
out=$(TMB_SHIM_PROJECT="$PROJ" dispatch "$C" trajectory-gates "$(tpayload issue_get tu-c12)" --shim)
assert_eq "" "$out" "no decision"
assert_eq "" "$(ran)" "no gate ran"
rm -f "$PROJ/.claude/tmb/sessions/s-c.plugin-hooks"

# ===========================================================================
test_case "chain (real gates): agent-arg denial keeps swe-brief-gate from writing its sentinel"
RP="$TMP/real-proj"
mkdir -p "$RP/.claude/tmb"
RDB="$RP/.claude/tmb/trajectory.db"
sqlite3 "$RDB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$RDB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'o', 'open', 'x', 'x');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at)
    VALUES (42, 7, 'fix/x', 'dev', 'd', 'running', 'x', 'x');"
brief() {
  jq -nc --arg a "$1" --arg id "$2" '{hook_event_name:"PreToolUse",session_id:"s-r",agent_type:"swe",agent_id:"ag1",
    tool_name:"mcp__plugin_tmb_trajectory-server__task_brief",tool_input:{agent:$a,task_id:42},tool_use_id:$id}'
}
sentinels() { sqlite3 "$RDB" "SELECT COUNT(*) FROM audit WHERE event_type = 'swe_brief_fetched';"; }
out=$(cd "$RP" && brief bro tu-r1 | CLAUDE_PROJECT_DIR="$RP" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null)
assert_contains "$out" "pass agent='swe'" "agent-arg-matches-caller denied"
assert_eq "0" "$(sentinels)" "no swe_brief_fetched sentinel"
out=$(cd "$RP" && brief swe tu-r2 | CLAUDE_PROJECT_DIR="$RP" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null)
is_deny "$out" && _fail "matching agent denied: $out" || _pass
assert_eq "1" "$(sentinels)" "the matching call reaches swe-brief-gate, which writes the sentinel"

# ===========================================================================
. "$HERE/fixtures/no-jq-path.sh"
NOJQ=$(no_jq_path "$TMP/nojq")

test_case "no jq: a fail-closed chain denies naming jq, no gate runs"
reset_runs
rc=0
out=$(tpayload task_update_status tu-n1 | PATH="$NOJQ" CLAUDE_PLUGIN_ROOT="$C" bash "$C/scripts/hooks/dispatch.sh" trajectory-gates 2>"$TMP/err") || rc=$?
assert_eq "0" "$rc" "exit 0"
is_deny "$out" && _pass || _fail "no deny: $out"
assert_contains "$out" "jq not found" "reason names jq"
assert_contains "$(cat "$TMP/err")" "jq not found — failing closed" "stderr line"
assert_eq "" "$(ran)" "no gate ran"

test_case "no jq: a fail-closed gate denies; an observe-only registration still runs"
reset_runs
out=$(payload "ls n2" tu-n2 | PATH="$NOJQ" CLAUDE_PLUGIN_ROOT="$A" bash "$A/scripts/hooks/dispatch.sh" fx-gate-dies 2>/dev/null)
assert_contains "$out" "jq not found" "fail-closed gate denies naming jq"
assert_eq "" "$(ran)" "the gate never ran"
rc=0
out=$(payload "ls n3" tu-n3 | FX_SLEEP=0 PATH="$NOJQ" CLAUDE_PLUGIN_ROOT="$A" bash "$A/scripts/hooks/dispatch.sh" fx-allow 2>/dev/null) || rc=$?
assert_eq "0" "$rc" "observe-only: exit 0"
assert_contains "$out" "fx banner" "observe-only: ran and allowed"

test_case "no jq (real gates): the chain denies; deny-capable gates exit non-zero, the observe-only gate allows"
NP=$(jq -nc '{hook_event_name:"PreToolUse",session_id:"s-n",agent_type:"pr-reviewer",agent_id:"ag1",
  tool_name:"mcp__plugin_tmb_trajectory-server__validation_record",tool_input:{agent:"pr-reviewer",task_id:42,attempt_n:1},tool_use_id:"tu-n4"}')
out=$(cd "$RP" && printf '%s' "$NP" | PATH="$NOJQ" CLAUDE_PROJECT_DIR="$RP" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" trajectory-gates 2>/dev/null)
assert_contains "$out" '"permissionDecision":"deny"' "chain denies"
assert_contains "$out" "jq not found" "reason names jq"
for g in agent-arg-matches-caller containment-guard; do
  rc=0
  err=$(cd "$RP" && printf '%s' "$NP" | PATH="$NOJQ" CLAUDE_PROJECT_DIR="$RP" bash "$PLUGIN_ROOT/scripts/hooks/$g.sh" 2>&1 >/dev/null) || rc=$?
  assert_eq "1" "$rc" "$g exits 1"
  assert_contains "$err" "jq not found" "$g names jq on stderr"
done
rc=0
err=$(cd "$RP" && printf '%s' "$NP" | PATH="$NOJQ" CLAUDE_PROJECT_DIR="$RP" bash "$PLUGIN_ROOT/scripts/hooks/reviewer-identity-observe.sh" 2>&1 >/dev/null) || rc=$?
assert_eq "0" "$rc" "reviewer-identity-observe exits 0"
assert_contains "$err" "jq not found" "reviewer-identity-observe notes it on stderr"

test_case "registration without jq equals the jq reading for every hooks.json entry"
# shellcheck disable=SC1091
. "$PLUGIN_ROOT/scripts/hooks/lib/registrations.sh"
jq_registration() {
  jq -r --arg g "$2" '
    [.hooks[][]?.hooks[]? | select((.command // "") | test("/dispatch\\.sh\"? " + $g + "( |$)"))]
    | "\([.[].timeout // empty] | max // "") \(if any(.[]; .onFailure == "block") then 1 else 0 end)"' "$1"
}
diffs=""
n=0
while IFS= read -r name; do
  n=$((n + 1))
  want=$(jq_registration "$PLUGIN_ROOT/hooks/hooks.json" "$name")
  got=$(PATH="$NOJQ" tmb_registration "$PLUGIN_ROOT/hooks/hooks.json" "$name")
  [ "$want" = "$got" ] || diffs="$diffs $name(jq=<$want> awk=<$got>)"
done < <(jq -r '.hooks[][]?.hooks[]?.command | capture("/dispatch\\.sh\"? (?<g>[a-z0-9-]+)").g' "$PLUGIN_ROOT/hooks/hooks.json" | sort -u)
assert_eq "" "$diffs" "every registration reads the same"
[ "$n" -gt 30 ] && _pass || _fail "only $n registrations compared"
assert_eq "1842 1" "$(tmb_registration "$PLUGIN_ROOT/hooks/hooks.json" trajectory-gates)" "the chain: timeout and fail-closed"
assert_eq " 0" "$(tmb_registration "$PLUGIN_ROOT/hooks/hooks.json" not-registered)" "an unregistered name"
printf '%s' '{"hooks":{"PreToolUse":[{"matcher":"x{2}","hooks":[{"onFailure":"block","timeout":9,"command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh\" fx-a"},{"timeout":3,"command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-ab"}]}]}}' > "$TMP/order.json"
assert_eq "$(jq_registration "$TMP/order.json" fx-a)" "$(tmb_registration "$TMP/order.json" fx-a)" "keys before the command, one line"
assert_eq "$(jq_registration "$TMP/order.json" fx-ab)" "$(tmb_registration "$TMP/order.json" fx-ab)" "a name that extends another"

# ===========================================================================
test_case "parity: every PreToolUse gate gives the same result through the dispatcher"
PARITY="$TMP/parity"
mkdir -p "$PARITY"
PP=$(jq -nc --arg cwd "$PARITY" '{hook_event_name:"PreToolUse",session_id:"par",tool_name:"Bash",tool_input:{command:"echo hi"},tool_use_id:"tu-par",cwd:$cwd}')
mismatch=""
checked=0
# shellcheck disable=SC1091
. "$PLUGIN_ROOT/scripts/hooks/lib/registrations.sh"
while IFS= read -r reg; do
  members=$(tmb_chain_table "$reg" | cut -d' ' -f1)
  for gate in ${members:-$reg}; do
    via=()
    [ -n "$members" ] && via=(--chain "$reg")
    checked=$((checked + 1))
    d_rc=0; x_rc=0
    d_out=$(cd "$PARITY" && printf '%s' "$PP" | CLAUDE_PROJECT_DIR="$PARITY" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/$gate.sh" 2>/dev/null) || d_rc=$?
    x_out=$(cd "$PARITY" && printf '%s' "$PP" | CLAUDE_PROJECT_DIR="$PARITY" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" "$gate" ${via[@]+"${via[@]}"} 2>/dev/null) || x_rc=$?
    if [ "$d_out" != "$x_out" ] || [ "$d_rc" != "$x_rc" ]; then
      mismatch="$mismatch $gate"
    fi
  done
done < <(jq -r '.hooks.PreToolUse[].hooks[].command | capture("/dispatch\\.sh\"? (?<g>[a-z0-9-]+)$").g' "$PLUGIN_ROOT/hooks/hooks.json" | sort -u)
assert_eq "" "$mismatch" "no gate differs through the dispatcher"
[ "$checked" -gt 10 ] && _pass || _fail "parity checked only $checked gates"
[ ! -e "$PARITY/.claude" ] && _pass || _fail "parity project gained state"

summarize
