#!/usr/bin/env bash
# The one entry point for every TMB hook registration:
#
#   dispatch.sh <gate | chain> [--shim]
#
# hooks/hooks.json registers `dispatch.sh <gate>` for every gate; the headless
# shim (scripts/lib/resolve-hook.sh) execs `dispatch.sh <gate> --shim`. However
# many registrations fire for one event — a project and a user-scope install,
# two channels, the shim beside the plugin — the gate runs once, at one version:
#
# 1. One install per project. lib/resolve-install.sh picks the install this
#    project uses; the gate executed is <that install>/scripts/hooks/<gate>.sh,
#    with CLAUDE_PLUGIN_ROOT pointing at it. When that install lacks the gate,
#    the dispatcher's own copy runs, with a stderr notice. An invalid gate name
#    or a gate found in neither exits 1 with a stderr line: a visible hook
#    error, never a silent allow (a fail-closed gate found in neither denies,
#    see 4).
# 2. --shim keeps the headless shim's yield: exit 0 without running the gate
#    when CLAUDE_PROJECT_DIR is another project than TMB_SHIM_PROJECT, or when
#    the plugin's own hooks marked this session
#    (<project>/.claude/<plugin>/sessions/<session_id>.plugin-hooks).
# 3. One execution per (event, payload, gate). The key is the sha256 of
#      SessionStart:  event | session_id | gate
#      tool events:   event | session_id | tool_name | canonical tool_input |
#                     tool_use_id | gate
#      other events:  canonical payload | gate
#    The first invocation creates <state>/locks/events/<key>/ (mkdir is the
#    lock), runs the gate with the saved payload on stdin, stores stdout in
#    result, stderr in stderr and the exit code in rc, then emits them and
#    exits with the gate's code. Another invocation with the same key waits
#    up to the gate's hooks.json timeout minus 1 s and replays only a denial
#    (rc 2, or permissionDecision "deny"); otherwise it exits 0 silently, so
#    context and banners are emitted once.
#    A finished result answers duplicates for TMB_DISPATCH_WINDOW_S (default
#    5 s) after it was written; a later identical event (a retry) runs the gate
#    afresh. The holder writes deadline (epoch seconds: its start + the
#    gate's timeout + 5 s), the time past which it is dead; an unfinished lock
#    past its deadline (holder killed) is reclaimed, one without a readable
#    deadline once it is older than the gate's timeout. A live holder is
#    never reclaimed or pruned before its deadline.
#    A sweep prunes results older than TMB_DISPATCH_TTL_MIN (default 10 min),
#    unfinished locks past their deadline, and unfinished locks without one
#    older than 3 × TMB_DISPATCH_TTL_MIN, in one pass (two finds, one rm,
#    whatever the number of locks). It runs at most once per
#    TMB_DISPATCH_SWEEP_S (default 60 s): <state>/locks/events.sweep holds
#    the last sweep's epoch seconds.
#    The lock directory and the shim's session marker are derived from the
#    project's physical path (cd -P), so a symlinked project dir and its real
#    path share one lock.
#    A project without TMB state (no trajectory DB) still runs the gate but
#    takes no lock: nothing is written in a non-TMB project.
# 4. Fail closed. A gate whose hooks.json registration carries
#    "onFailure": "block" never ends without a decision: when its script is
#    missing, exits non-zero (other than 2) without a deny, or the dispatcher
#    itself errors, the dispatcher prints a blocking decision shaped for the
#    event (PreToolUse deny, else decision block) and exits 0, with a stderr
#    line naming the cause. Other hooks keep their exit code and output.
#    The registration (timeout, onFailure) is read from hooks.json with awk,
#    so it holds on a host without jq. There, every fail-closed gate denies
#    with "jq not found" before it runs: the gates decide from jq-parsed
#    payloads and cannot decide without it.
# 5. Chains. `dispatch.sh <chain>` (lib/registrations.sh: trajectory-gates)
#    runs the chain's gates one after another with the same payload, each through
#    `dispatch.sh <gate> --chain <chain>` (its own dedupe key and lock, the
#    chain's onFailure, the gate's own timeout from the chain table). The
#    first deny (exit 2 or a deny decision, fail-closed ones included) ends
#    the chain and is returned; the additionalContext of the gates that
#    allowed is joined into one output. Each gate runs in its own process
#    group under a watchdog at its chain-table timeout: past it, the group
#    (the gate and everything it started) is killed and the chain denies. Any other exit ends the chain with a deny.
#    The watchdog kills only while its chain subshell is alive and the gate's
#    pid still leads its group. A TERM sent to the dispatcher's pid alone lets
#    the running gate finish before the dispatcher exits: the trap that stops
#    the gate's group runs in the chain subshell, which only a signal to the
#    dispatcher's process group reaches. TERM, INT or HUP to that group stops
#    both; KILL to it leaves the gate to run to its end in its own group.
#    A duplicate waiter that gives up on its holder exits 75 under --chain,
#    and the chain ends there without a decision (the holder's chain
#    decides), so no later gate runs for it. A chain, a gate run with
#    --chain, and any gate when lib/registrations.sh cannot be loaded are
#    fail-closed whatever hooks.json says.
# 6. Bash deny records. When a gate judges a Bash command's write targets and
#    denies it, the dispatcher writes one record per path the command writes
#    (tmb_cmd_write_paths) to
#    <state>/locks/boundary-denies/<session_id>/<sha256 of the canonical path>
#    (gate name, epoch seconds), for swe-boundary.sh to match against a later
#    Edit/Write (audit hook_block_bypassed). A deny that judged no path, the
#    "cannot be judged" deny of a $(parse) or $(computed) target or of one
#    behind a variable, substitution or cd the guard cannot resolve
#    (containment-guard, swe-boundary), writes none: the literal-path write it
#    prescribes is not a workaround (GH 1750, GH 1772). Records older than
#    TMB_BYPASS_WINDOW_MIN minutes (default 10) are pruned on every write. It
#    observes only: the gate's stdout, exit code and timing are unchanged.
# 7. Deny audit. Every deny the dispatcher returns — a gate's exit 2,
#    permissionDecision "deny" or decision "block", or its own fail-closed
#    decision — writes one hook_denied audit row (from_node hook:dispatch)
#    from a detached child started after the decision is printed, so the
#    hook exits without waiting for the write, on the task's issue else -1,
#    content {hook, rule, tool, agent_type, task_id, cwd}: rule is the first
#    200 characters of the deny reason, task_id the calling swe's run else
#    tool_input.task_id, null when neither. A replayed duplicate writes none
#    (its holder did), a fail-open gate's exit other than 0 or 2 writes none
#    (Claude Code ignores its stdout), and a chain's member deny is written by
#    the member's own dispatch. No DB or a failed write records nothing; the
#    decision and exit code are unchanged.
# 8. TypeScript gates. A gate named on a line of
#    <install>/mcp/trajectory-server/dist/hooks-gates.txt (written by the
#    build from src/hooks/registry.ts) runs as
#    `node <install>/mcp/trajectory-server/dist/hooks.js <gate>` in place of
#    `bash <gate>.sh`, when node is on PATH and dist/hooks.js exists, and
#    everything above applies to it unchanged. A gate born in TypeScript has
#    no .sh: the install ships it when the manifest lists it and dist/hooks.js
#    exists (task-overrun-alert, GH 1738), and without node it is not run
#    (exit 1 with a stderr line). TMB_HOOKS_IMPL=bash is the kill switch:
#    every gate with a .sh runs it, a gate without one is not run.

set -uo pipefail

GATE="${1:-}"
[ $# -gt 0 ] && shift
SHIM=0
CHAIN=""
PASS=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--shim" ] && [ "$SHIM" = "0" ]; then
    SHIM=1
  elif [ "$1" = "--chain" ] && [ -z "$CHAIN" ] && [ $# -gt 1 ]; then
    CHAIN="$2"
    shift
  else
    PASS+=("$1")
  fi
  shift
done

case "$GATE" in
  ''|*[!a-z0-9-]*|dispatch)
    printf 'TMB dispatch: invalid gate name %s — not run\n' "'${GATE}'" >&2
    exit 1
    ;;
esac

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SELF_ROOT}"

PAYLOAD=""
PAYLOAD_READ=0
DENY_PATTERN='"permissionDecision"[[:space:]]*:[[:space:]]*"deny"|"decision"[[:space:]]*:[[:space:]]*"block"'
# Exit code of a chain gate whose duplicate waiter gave up on the holder: the
# chain ends without a decision of its own (the holder's chain decides).
CHAIN_YIELD=75
# The phrase of containment-guard's and swe-boundary's deny of a target they cannot judge
# (UNJUDGED_PHRASE in mcp/trajectory-server/src/hooks/containment-guard.ts):
#   BLOCKED: write target "<target>" cannot be judged: <why>
UNJUDGED_PHRASE='cannot be judged:'
FAIL_CLOSED=1
DENIED=0
DENIED_GATE=""
DENIED_RULE=""

read_payload() {
  [ "$PAYLOAD_READ" = "1" ] && return 0
  PAYLOAD_READ=1
  PAYLOAD=$(cat)
}

# note_denied <reason> [<gate>] — this process returns a deny; on_exit audits it.
note_denied() {
  DENIED=1
  DENIED_RULE="${1:0:200}"
  DENIED_GATE="${2:-$GATE}"
}

# deny_reason <stdout> <stderr> — the reason a gate gave for its deny: its
# JSON permissionDecisionReason or reason, else its stderr.
deny_reason() {
  local r=""
  command -v jq >/dev/null 2>&1 && r=$(printf '%s' "$1" | jq -rs '
    map(select(type == "object") | (.hookSpecificOutput.permissionDecisionReason? // .reason? // empty))
    | first // empty' 2>/dev/null)
  printf '%s' "${r:-$2}"
}

# _json_str <text> — <text> as a JSON string, for the no-jq audit content.
_json_str() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000-\037')
  s="${s//\\/\\\\}"
  printf '"%s"' "${s//\"/\\\"}"
}

# audit_denied — the one hook_denied row for the deny noted in this process,
# written by a detached child this process never waits for. Observes only:
# everything it prints is discarded and a failure is ignored.
audit_denied() {
  [ "$DENIED" = "1" ] || return 0
  (
    export TMB_DB_WRITE_TIMEOUT_MS=300 TMB_DB_WRITE_RUN_BUDGET_MS=600
    declare -F tmb_db_path >/dev/null || exit 0
    tmb_have_sqlite || exit 0
    db=$(tmb_db_path) || exit 0
    . "$SELF_DIR/lib/db-write.sh" || exit 0
    task_id="" issue=-1 tool=""
    if command -v jq >/dev/null 2>&1; then
      . "$SELF_DIR/lib/cmd-analysis.sh" || exit 0
      run=$(tmb_caller_run "$PAYLOAD" "$db")
      task_id=$(tmb_sql_int "${run%%|*}")
      [ -n "$task_id" ] || task_id=$(tmb_sql_int "$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.task_id? // empty' 2>/dev/null)")
      tool=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name? // empty' 2>/dev/null)
      content=$(printf '%s' "$PAYLOAD" | jq -c --arg hook "$DENIED_GATE" --arg rule "$DENIED_RULE" --arg tid "$task_id" '
        {hook: $hook, rule: $rule, tool: (.tool_name? // null), agent_type: (.agent_type? // null),
         task_id: (if $tid == "" then null else ($tid | tonumber) end), cwd: (.cwd? // null)}' 2>/dev/null) \
        || content=""
    fi
    [ -n "${content:-}" ] || content=$(printf '{"hook":%s,"rule":%s,"tool":null,"agent_type":null,"task_id":null,"cwd":null}' \
      "$(_json_str "$DENIED_GATE")" "$(_json_str "$DENIED_RULE")")
    if [ -n "$task_id" ]; then
      issue=$(tmb_sql_int "$(tmb_sqlite_ro "$db" "SELECT issue_id FROM tasks WHERE id = ${task_id};")")
      [ -n "$issue" ] || issue=-1
    fi
    tmb_audit_append "$db" "$issue" '' "hook:dispatch" "hook_denied" \
      "${DENIED_GATE} denied${tool:+ $tool}" "$content"
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

# fail_closed_decision <cause> [<reason>] [<gate>] — the blocking decision for
# this gate's event.
fail_closed_decision() {
  local gate="${3:-$GATE}"
  local reason="BLOCKED: TMB gate $gate $1 without a decision, so the action is denied (fail-closed). The hook's stderr names the cause; fix the gate, then retry."
  [ -n "${2:-}" ] && reason="$2"
  printf 'TMB dispatch: gate %s %s — failing closed\n' "$gate" "$1" >&2
  if printf '%s' "$PAYLOAD" | grep -E '"hook_event_name"[[:space:]]*:[[:space:]]*"PreToolUse"' >/dev/null; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  else
    printf '{"decision":"block","reason":"%s"}\n' "$reason"
  fi
  note_denied "$reason" "$gate"
}

on_exit() {
  local rc=$?
  if [ "$FAIL_CLOSED" = "1" ] && [ "$rc" != "0" ] && [ "$rc" != "2" ] \
     && ! { [ -n "$CHAIN" ] && [ "$rc" = "$CHAIN_YIELD" ]; }; then
    read_payload
    fail_closed_decision "dispatch failed (exit $rc)"
    rc=0
  fi
  audit_denied
  exit "$rc"
}
trap on_exit EXIT

# Without the registration library nothing says whether this gate may fail
# open, so it fails closed.
# shellcheck source=scripts/hooks/lib/registrations.sh
if ! . "$SELF_DIR/lib/registrations.sh" 2>/dev/null || ! declare -F tmb_registration >/dev/null; then
  read_payload
  fail_closed_decision "could not load lib/registrations.sh"
  exit 0
fi

REGISTRATION=$(tmb_registration "$SELF_ROOT/hooks/hooks.json" "${CHAIN:-$GATE}")
GATE_TIMEOUT="${REGISTRATION% *}"
FAIL_CLOSED="${REGISTRATION##* }"
[ "$FAIL_CLOSED" = "1" ] || FAIL_CLOSED=0
CHAIN_GATES=""
if [ -n "$CHAIN" ]; then
  FAIL_CLOSED=1
  GATE_TIMEOUT=$(tmb_chain_table "$CHAIN" | awk -v g="$GATE" '$1 == g { print $2; exit }')
else
  CHAIN_GATES=$(tmb_chain_table "$GATE")
  [ -n "$CHAIN_GATES" ] && FAIL_CLOSED=1
fi

# settle <rc> <stdout> — a fail-closed gate's non-zero exit other than 2 keeps
# its own deny, or becomes one; every other result passes through unchanged.
settle() {
  local rc="$1" out="$2"
  if [ "$FAIL_CLOSED" = "0" ] || [ "$rc" = "0" ] || [ "$rc" = "2" ]; then
    [ -n "$out" ] && printf '%s\n' "$out"
    if [ "$rc" = "2" ] || { [ "$rc" = "0" ] && printf '%s' "$out" | grep -E "$DENY_PATTERN" >/dev/null; }; then
      note_denied "$(deny_reason "$out" "exit $rc")"
    fi
    return "$rc"
  fi
  if printf '%s' "$out" | grep -E "$DENY_PATTERN" >/dev/null; then
    printf '%s\n' "$out"
    note_denied "$(deny_reason "$out" "exit $rc")"
  else
    fail_closed_decision "exited $rc"
  fi
  return 0
}

# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SELF_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-install.sh
. "$SELF_DIR/lib/resolve-install.sh"

PROJECT_REAL=""
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && PROJECT_REAL=$(_tmb_canonical_dir "$CLAUDE_PROJECT_DIR")

if [ "$SHIM" = "1" ]; then
  read_payload
  SHIM_PROJECT="${TMB_SHIM_PROJECT:-}"
  [ -n "$SHIM_PROJECT" ] && SHIM_PROJECT=$(_tmb_canonical_dir "$SHIM_PROJECT")
  if [ -n "$PROJECT_REAL" ] && [ -n "$SHIM_PROJECT" ] && [ "$PROJECT_REAL" != "$SHIM_PROJECT" ]; then
    exit 0
  fi
  SESSION_ROOT="${PROJECT_REAL:-$SHIM_PROJECT}"
  SESSION_ID=""
  command -v jq >/dev/null 2>&1 \
    && SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)
  case "$SESSION_ID" in
    ''|*/*|.*) ;;
    *)
      if [ -n "$SESSION_ROOT" ] \
         && [ -e "$SESSION_ROOT/$TMB_STATE_HOST_DIR/$(tmb_plugin_name)/sessions/$SESSION_ID.plugin-hooks" ]; then
        exit 0
      fi
      ;;
  esac
fi

# chain_watchdog <pid> <budget s> — after <budget>, kills the process group
# <pid> leads, but only while the run_member that started it is still this
# watchdog's parent and <pid> still leads its own group. Otherwise that run is
# over and <pid> may name an unrelated process, so it exits without a kill.
# Without ps it kills unchecked.
chain_watchdog() {
  local self parent now pgid
  self=$(exec sh -c 'echo "$PPID"')
  parent=$(ps -o ppid= -p "$self" 2>/dev/null)
  sleep "$2"
  if [ -n "$parent" ]; then
    now=$(ps -o ppid= -p "$self" 2>/dev/null)
    pgid=$(ps -o pgid= -p "$1" 2>/dev/null)
    [ "${now//[[:space:]]/}" = "${parent//[[:space:]]/}" ] && [ "${pgid//[[:space:]]/}" = "$1" ] || return 0
  fi
  kill -KILL -- -"$1" 2>/dev/null
}

# run_member <gate> <budget s> — the gate through `dispatch.sh <gate> --chain`,
# killed with everything it started once it runs past <budget>. Prints its
# stdout, then a last line with its exit code. Job control puts the gate and
# the watchdog in process groups of their own, so either is stopped with one
# kill of its group: no process-tree walk, and nothing is left running.
run_member() {
  local pid watch rc
  set -m
  ( printf '%s' "$PAYLOAD" | bash "$SELF_DIR/dispatch.sh" "$1" --chain "$GATE" ${PASS[@]+"${PASS[@]}"} ) &
  pid=$!
  chain_watchdog "$pid" "$2" </dev/null >/dev/null 2>&1 &
  watch=$!
  trap 'kill -KILL -- -"$pid" -"$watch" 2>/dev/null; exit 143' TERM INT HUP
  wait "$pid"
  rc=$?
  kill -KILL -- -"$watch" 2>/dev/null
  wait "$watch" 2>/dev/null
  printf '\n%s' "$rc"
}

# run_chain — the chain's gates in order. The first deny ends it, as does a
# gate that runs past its chain-table timeout or exits other than 0 or 2
# (a deny), or a duplicate waiter that gave up (no decision: the holder's
# chain decides).
run_chain() {
  local tool="" gate budget res out rc started
  local -a context=()
  command -v jq >/dev/null 2>&1 \
    && tool=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null || true)
  while IFS= read -r gate; do
    [ -n "$gate" ] || continue
    budget=$(tmb_chain_table "$GATE" | awk -v g="$gate" '$1 == g { print $2; exit }')
    case "$budget" in ''|*[!0-9]*) budget=6 ;; esac
    started=$SECONDS
    res=$(run_member "$gate" "$budget")
    rc="${res##*$'\n'}"
    out="${res%$'\n'*}"
    [ "$res" = "$rc" ] && out=""
    if [ "$rc" = "2" ] || printf '%s' "$out" | grep -E "$DENY_PATTERN" >/dev/null; then
      [ -n "$out" ] && printf '%s\n' "$out"
      [ "$rc" = "2" ] || rc=0
      return "$rc"
    fi
    case "$rc" in
      0) ;;
      "$CHAIN_YIELD")
        printf 'TMB dispatch: chain %s yields at %s to the duplicate event already running it\n' "$GATE" "$gate" >&2
        return 0
        ;;
      *)
        if [ $((SECONDS - started)) -ge "$budget" ]; then
          fail_closed_decision "ran past its ${budget} s budget" "" "$gate"
        else
          fail_closed_decision "exited $rc" "" "$gate"
        fi
        return 0
        ;;
    esac
    [ -n "$out" ] && context+=("$out")
  done < <(tmb_chain_gates "$GATE" "$tool")
  if [ "${#context[@]}" -eq 1 ]; then
    printf '%s\n' "${context[0]}"
  elif [ "${#context[@]}" -gt 1 ]; then
    printf '%s\n' "${context[@]}" | jq -sc '
      {hookSpecificOutput: {
        hookEventName: (map(.hookSpecificOutput.hookEventName? // empty) | first // "PreToolUse"),
        additionalContext: (map(.hookSpecificOutput.additionalContext? // empty) | join("\n\n"))}}' 2>/dev/null \
      || printf '%s\n' "${context[@]}"
  fi
  return 0
}

if [ -n "$CHAIN_GATES" ]; then
  read_payload
  run_chain
  exit $?
fi

if [ "$FAIL_CLOSED" = "1" ] && ! command -v jq >/dev/null 2>&1; then
  read_payload
  fail_closed_decision "could not run: jq not found" \
    "BLOCKED: jq not found — TMB gate $GATE cannot decide without it, so the action is denied (fail-closed). Install jq (brew install jq, apt-get install jq), then retry."
  exit 0
fi

# ts_gate <root> — <root> ships dist/hooks.js and this gate is a line of its
# TypeScript gate manifest.
ts_gate() {
  local line dist="$1/mcp/trajectory-server/dist"
  { [ -f "$dist/hooks.js" ] && [ -f "$dist/hooks-gates.txt" ]; } || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "$GATE" ] && return 0
  done < "$dist/hooks-gates.txt"
  return 1
}

# has_gate <root> — <root> ships this gate: its .sh, or a TypeScript-only gate.
has_gate() {
  [ -f "$1/scripts/hooks/$GATE.sh" ] || ts_gate "$1"
}

ROOT=$(tmb_active_install)
if [ -z "$ROOT" ] || ! has_gate "$ROOT"; then
  if [ -n "$ROOT" ] && [ "$ROOT" != "$SELF_ROOT" ]; then
    printf 'TMB dispatch: no gate %s.sh in %s — using %s\n' "$GATE" "$ROOT" "$SELF_ROOT" >&2
  fi
  ROOT="$SELF_ROOT"
fi
if ! has_gate "$ROOT"; then
  printf 'TMB dispatch: no gate %s.sh in %s — not run\n' "$GATE" "$ROOT" >&2
  exit 1
fi
TARGET="$ROOT/scripts/hooks/$GATE.sh"
export CLAUDE_PLUGIN_ROOT="$ROOT"

if [ "${TMB_HOOKS_IMPL:-}" != "bash" ] && ts_gate "$ROOT" && command -v node >/dev/null 2>&1; then
  GATE_CMD=(node "$ROOT/mcp/trajectory-server/dist/hooks.js" "$GATE")
elif [ -f "$TARGET" ]; then
  GATE_CMD=(bash "$TARGET")
else
  printf 'TMB dispatch: gate %s has no .sh and needs node to run %s/mcp/trajectory-server/dist/hooks.js (TMB_HOOKS_IMPL=bash runs only .sh gates) — not run\n' "$GATE" "$ROOT" >&2
  exit 1
fi

LOCK_BASE=""
if tmb_have_sqlite && STATE_DIR=$(tmb_state_dir 2>/dev/null); then
  LOCK_BASE="$(_tmb_canonical_dir "$STATE_DIR")/locks/events"
fi

if [ "$SHIM" = "0" ] && [ -z "$LOCK_BASE" ] && [ "$FAIL_CLOSED" = "0" ]; then
  exec "${GATE_CMD[@]}" ${PASS[@]+"${PASS[@]}"}
fi

read_payload

run_gate() {
  local out rc
  out=$(printf '%s' "$PAYLOAD" | "${GATE_CMD[@]}" ${PASS[@]+"${PASS[@]}"}; exit "${PIPESTATUS[1]}")
  rc=$?
  settle "$rc" "$out"
}

[ -n "$LOCK_BASE" ] || { run_gate; exit $?; }

_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

KEY_MATERIAL=$(printf '%s' "$PAYLOAD" | jq -cS --arg g "$GATE" '
  if type != "object" then error("not an object")
  elif (.hook_event_name // "") == "SessionStart" then ["SessionStart", (.session_id // ""), $g]
  elif has("tool_name") then
    [(.hook_event_name // ""), (.session_id // ""), .tool_name, (.tool_input // null), (.tool_use_id // ""), $g]
  else [., $g] end' 2>/dev/null) || KEY_MATERIAL=""
KEY=""
[ -n "$KEY_MATERIAL" ] && KEY=$(printf '%s' "$KEY_MATERIAL" | _sha256 2>/dev/null)
if [ -z "$KEY" ] || ! mkdir -p "$LOCK_BASE" 2>/dev/null; then
  run_gate
  exit $?
fi

TTL_MIN="${TMB_DISPATCH_TTL_MIN:-10}"
case "$TTL_MIN" in ''|*[!0-9]*) TTL_MIN=10 ;; esac
WINDOW_S="${TMB_DISPATCH_WINDOW_S:-5}"
case "$WINDOW_S" in ''|*[!0-9]*) WINDOW_S=5 ;; esac
SWEEP_S="${TMB_DISPATCH_SWEEP_S:-60}"
case "$SWEEP_S" in ''|*[!0-9]*) SWEEP_S=60 ;; esac
case "$GATE_TIMEOUT" in ''|*[!0-9]*) GATE_TIMEOUT=6 ;; esac
WAIT_S=$((GATE_TIMEOUT - 1))
[ "$WAIT_S" -ge 1 ] || WAIT_S=1

LOCK="$LOCK_BASE/$KEY"
MUTEX="$LOCK.reclaim"
SWEEP_STAMP="$LOCK_BASE.sweep"

_now() { date +%s; }
NOW=$(_now)

# _stamp <file> — sets STAMP to the epoch seconds <file> holds, read without a
# fork; fails when <file> is missing or does not hold only digits.
_stamp() {
  STAMP=""
  { IFS= read -r STAMP < "$1"; } 2>/dev/null
  case "$STAMP" in ''|*[!0-9]*) STAMP=""; return 1 ;; esac
}

# sweep — removes finished results older than TTL_MIN, unfinished locks past
# their holder's deadline, and unfinished locks without a readable deadline
# older than 3 × TTL_MIN: two finds and one rm, whatever the number of dirs.
# A live holder is never removed before its deadline.
sweep() {
  local d f
  local -a gone=()
  while IFS= read -r d; do
    [ -f "$d/rc" ] && gone+=("$d")
  done < <(find "$LOCK_BASE" -mindepth 1 -maxdepth 1 -type d -mmin "+$TTL_MIN" 2>/dev/null)
  while IFS= read -r d; do
    [ -f "$d/rc" ] || _stamp "$d/deadline" || gone+=("$d")
  done < <(find "$LOCK_BASE" -mindepth 1 -maxdepth 1 -type d -mmin "+$((TTL_MIN * 3))" 2>/dev/null)
  for f in "$LOCK_BASE"/*/deadline; do
    d="${f%/deadline}"
    [ -f "$d/rc" ] && continue
    _stamp "$f" && [ "$NOW" -gt "$STAMP" ] && gone+=("$d")
  done
  [ "${#gone[@]}" -eq 0 ] || rm -rf "${gone[@]}" 2>/dev/null
  return 0
}

if ! _stamp "$SWEEP_STAMP" || [ "$STAMP" -gt "$NOW" ] || [ $((NOW - STAMP)) -ge "$SWEEP_S" ]; then
  printf '%s\n' "$NOW" > "$SWEEP_STAMP" 2>/dev/null
  sweep
fi

_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# _age <dir> — seconds since <dir> last changed; empty when it is gone.
_age() {
  local m
  m=$(_mtime "$1") || return 1
  [ -n "$m" ] || return 1
  printf '%s\n' "$(( $(_now) - m ))"
}

# unjudged_deny <reason> — <reason> is a deny that judged no path. <why> holds
# no double quote, so a target that spells the phrase does not pass for one.
unjudged_deny() {
  case "$1" in "BLOCKED: write target \""*"\" $UNJUDGED_PHRASE "*) ;; *) return 1 ;; esac
  case "${1##*"\" $UNJUDGED_PHRASE "}" in *\"*) return 1 ;; esac
}

# _expired <dir> — a finished result past the duplicate window, or an
# unfinished lock past its holder's deadline (without a readable deadline:
# older than the gate's timeout).
_expired() {
  local age
  if [ ! -f "$1/rc" ] && _stamp "$1/deadline"; then
    [ "$(_now)" -gt "$STAMP" ]
    return
  fi
  age=$(_age "$1") || return 1
  if [ -f "$1/rc" ]; then
    [ "$age" -gt "$WINDOW_S" ]
  else
    [ "$age" -gt "$GATE_TIMEOUT" ]
  fi
}

# record_bash_deny <rc> — when this gate denied a Bash command, one record per
# path the command writes, <state>/locks/boundary-denies/<session_id>/<digest>
# (line 1 the gate, line 2 epoch seconds), for swe-boundary.sh to match against
# a later Edit/Write. Observes only: a missing session_id or jq, or an
# unjudged deny, records nothing, and nothing here changes the gate's output
# or exit code.
record_bash_deny() {
  local session cmd base dir window
  [ "$1" = "2" ] || grep -qE "$DENY_PATTERN" "$LOCK/result" 2>/dev/null || return 0
  command -v jq >/dev/null 2>&1 || return 0
  [ "$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || return 0
  unjudged_deny "$(deny_reason "$(cat "$LOCK/result" 2>/dev/null)" "$(cat "$LOCK/stderr" 2>/dev/null)")" && return 0
  session=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
  case "$session" in ''|*/*|.*) return 0 ;; esac
  cmd=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)
  [ -n "$cmd" ] || return 0
  window="${TMB_BYPASS_WINDOW_MIN:-10}"
  case "$window" in ''|*[!0-9]*|0) window=10 ;; esac
  base="$(dirname "$(dirname "$LOCK_BASE")")/locks/boundary-denies"
  dir="$base/$session"
  (
    . "$SELF_DIR/lib/cmd-analysis.sh" || exit 0
    find "$base" -type f -mmin "+$window" -delete 2>/dev/null
    find "$base" -mindepth 1 -type d -empty -delete 2>/dev/null
    mkdir -p "$dir" || exit 0
    while IFS= read -r path; do
      case "$path" in /*) ;; *) continue ;; esac
      printf '%s\n%s\n' "$GATE" "$(_now)" > "$dir/$(tmb_path_digest "$path")"
    done < <(tmb_cmd_write_paths "$cmd" "$(tmb_payload_cwd "$PAYLOAD")" "" "$(tmb_project_root)")
  ) 2>/dev/null || true
}

hold() {
  printf '%s\n' "$((NOW + GATE_TIMEOUT + 5))" > "$LOCK/deadline" 2>/dev/null
  printf '%s' "$PAYLOAD" | "${GATE_CMD[@]}" ${PASS[@]+"${PASS[@]}"} >"$LOCK/result" 2>"$LOCK/stderr"
  local rc=${PIPESTATUS[1]}
  if [ "$rc" = "2" ] || { { [ "$rc" = "0" ] || [ "$FAIL_CLOSED" = "1" ]; } && grep -qE "$DENY_PATTERN" "$LOCK/result" 2>/dev/null; }; then
    note_denied "$(deny_reason "$(cat "$LOCK/result" 2>/dev/null)" "$(cat "$LOCK/stderr" 2>/dev/null)")"
  elif [ "$FAIL_CLOSED" = "1" ] && [ "$rc" != "0" ]; then
    fail_closed_decision "exited $rc" >"$LOCK/result" 2>>"$LOCK/stderr"
  fi
  if [ "$FAIL_CLOSED" = "1" ] && [ "$rc" != "0" ] && [ "$rc" != "2" ]; then
    rc=0
  fi
  printf '%s\n' "$rc" > "$LOCK/rc.tmp" 2>/dev/null && mv -f "$LOCK/rc.tmp" "$LOCK/rc" 2>/dev/null
  cat "$LOCK/stderr" >&2 2>/dev/null
  cat "$LOCK/result" 2>/dev/null
  record_bash_deny "$rc"
  exit "$rc"
}

replay() {
  local rc
  rc=$(cat "$LOCK/rc" 2>/dev/null)
  case "$rc" in ''|*[!0-9]*) exit 0 ;; esac
  if [ "$rc" = "2" ]; then
    cat "$LOCK/stderr" >&2 2>/dev/null
    cat "$LOCK/result" 2>/dev/null
    exit 2
  fi
  if jq -s -e 'any(.[]; (.hookSpecificOutput.permissionDecision? // "") == "deny")' "$LOCK/result" >/dev/null 2>&1; then
    cat "$LOCK/result"
    exit "$rc"
  fi
  exit 0
}

# Take over an expired lock. The mutex serializes reclaimers; whoever holds it
# re-checks expiry, so a lock recreated meanwhile is never removed.
reclaim() {
  if mkdir "$MUTEX" 2>/dev/null; then
    if [ ! -d "$LOCK" ] || _expired "$LOCK"; then
      rm -rf "$LOCK" 2>/dev/null
      if mkdir "$LOCK" 2>/dev/null; then
        rmdir "$MUTEX" 2>/dev/null
        hold
      fi
    fi
    rmdir "$MUTEX" 2>/dev/null
  else
    local age
    age=$(_age "$MUTEX") && [ "$age" -gt 30 ] && rm -rf "$MUTEX" 2>/dev/null
  fi
  return 0
}

DEADLINE=$((NOW + WAIT_S))
while :; do
  mkdir "$LOCK" 2>/dev/null && hold
  if [ -f "$LOCK/rc" ] && ! _expired "$LOCK"; then
    replay
  fi
  if _expired "$LOCK"; then
    reclaim
    [ -d "$LOCK" ] || continue
  fi
  if [ "$(_now)" -ge "$DEADLINE" ]; then
    [ -n "$CHAIN" ] && exit "$CHAIN_YIELD"
    exit 0
  fi
  sleep 0.1
done
