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
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-deny","timeout":6},
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-allow","timeout":6},
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-gate-dies","timeout":6,"onFailure":"block"},
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-gate-dies-deny","timeout":6,"onFailure":"block"},
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-gate-gone","timeout":6,"onFailure":"block"},
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-observe-dies","timeout":6}]}],
"SubagentStop":[{"matcher":"","hooks":[
  {"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh fx-gate-dies","timeout":6,"onFailure":"block"}]}]}}
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
test_case "parity: every PreToolUse gate gives the same result through the dispatcher"
PARITY="$TMP/parity"
mkdir -p "$PARITY"
PP=$(jq -nc --arg cwd "$PARITY" '{hook_event_name:"PreToolUse",session_id:"par",tool_name:"Bash",tool_input:{command:"echo hi"},tool_use_id:"tu-par",cwd:$cwd}')
mismatch=""
checked=0
while IFS= read -r gate; do
  checked=$((checked + 1))
  d_rc=0; x_rc=0
  d_out=$(cd "$PARITY" && printf '%s' "$PP" | CLAUDE_PROJECT_DIR="$PARITY" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/$gate.sh" 2>/dev/null) || d_rc=$?
  x_rc=0
  x_out=$(cd "$PARITY" && printf '%s' "$PP" | CLAUDE_PROJECT_DIR="$PARITY" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" "$gate" 2>/dev/null) || x_rc=$?
  if [ "$d_out" != "$x_out" ] || [ "$d_rc" != "$x_rc" ]; then
    mismatch="$mismatch $gate"
  fi
done < <(jq -r '.hooks.PreToolUse[].hooks[].command | capture("/dispatch\\.sh (?<g>[a-z0-9-]+)$").g' "$PLUGIN_ROOT/hooks/hooks.json" | sort -u)
assert_eq "" "$mismatch" "no gate differs through the dispatcher"
[ "$checked" -gt 10 ] && _pass || _fail "parity checked only $checked gates"
[ ! -e "$PARITY/.claude" ] && _pass || _fail "parity project gained state"

summarize
