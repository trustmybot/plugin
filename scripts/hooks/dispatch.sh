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
#    afresh. An unfinished lock older than the gate's timeout (holder killed)
#    is reclaimed. Results older than TMB_DISPATCH_TTL_MIN (default 10 min)
#    are pruned on every call.
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
# 6. Bash deny records. When a gate denies a Bash command, the dispatcher
#    writes one record per path the command writes (tmb_cmd_write_paths) to
#    <state>/locks/boundary-denies/<session_id>/<sha256 of the canonical path>
#    (gate name, epoch seconds), for swe-boundary.sh to match against a later
#    Edit/Write (audit hook_block_bypassed). Records older than
#    TMB_BYPASS_WINDOW_MIN minutes (default 10) are pruned on every write. It
#    observes only: the gate's stdout, exit code and timing are unchanged.

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
FAIL_CLOSED=1

read_payload() {
  [ "$PAYLOAD_READ" = "1" ] && return 0
  PAYLOAD_READ=1
  PAYLOAD=$(cat)
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
}

on_exit() {
  local rc=$?
  [ "$FAIL_CLOSED" = "1" ] || return 0
  case "$rc" in 0|2) return 0 ;; esac
  [ -n "$CHAIN" ] && [ "$rc" = "$CHAIN_YIELD" ] && return 0
  read_payload
  fail_closed_decision "dispatch failed (exit $rc)"
  exit 0
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
    return "$rc"
  fi
  if printf '%s' "$out" | grep -E "$DENY_PATTERN" >/dev/null; then
    printf '%s\n' "$out"
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

ROOT=$(tmb_active_install)
TARGET="$ROOT/scripts/hooks/$GATE.sh"
if [ -z "$ROOT" ] || [ ! -f "$TARGET" ]; then
  if [ -n "$ROOT" ] && [ "$ROOT" != "$SELF_ROOT" ]; then
    printf 'TMB dispatch: no gate %s.sh in %s — using %s\n' "$GATE" "$ROOT" "$SELF_ROOT" >&2
  fi
  ROOT="$SELF_ROOT"
  TARGET="$SELF_ROOT/scripts/hooks/$GATE.sh"
fi
if [ ! -f "$TARGET" ]; then
  printf 'TMB dispatch: no gate %s.sh in %s — not run\n' "$GATE" "$ROOT" >&2
  exit 1
fi
export CLAUDE_PLUGIN_ROOT="$ROOT"

LOCK_BASE=""
if tmb_have_sqlite && STATE_DIR=$(tmb_state_dir 2>/dev/null); then
  LOCK_BASE="$(_tmb_canonical_dir "$STATE_DIR")/locks/events"
fi

if [ "$SHIM" = "0" ] && [ -z "$LOCK_BASE" ] && [ "$FAIL_CLOSED" = "0" ]; then
  exec bash "$TARGET" ${PASS[@]+"${PASS[@]}"}
fi

read_payload

run_gate() {
  local out rc
  if [ "$FAIL_CLOSED" = "0" ]; then
    printf '%s' "$PAYLOAD" | bash "$TARGET" ${PASS[@]+"${PASS[@]}"}
    return "${PIPESTATUS[1]}"
  fi
  out=$(printf '%s' "$PAYLOAD" | bash "$TARGET" ${PASS[@]+"${PASS[@]}"}; exit "${PIPESTATUS[1]}")
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

while IFS= read -r old; do
  if [ -f "$old/rc" ] || [ -n "$(find "$old" -maxdepth 0 -mmin +$((TTL_MIN * 3)) 2>/dev/null)" ]; then
    rm -rf "$old" 2>/dev/null || true
  fi
done < <(find "$LOCK_BASE" -mindepth 1 -maxdepth 1 -type d -mmin "+$TTL_MIN" 2>/dev/null)

case "$GATE_TIMEOUT" in ''|*[!0-9]*) GATE_TIMEOUT=6 ;; esac
WAIT_S=$((GATE_TIMEOUT - 1))
[ "$WAIT_S" -ge 1 ] || WAIT_S=1

LOCK="$LOCK_BASE/$KEY"
MUTEX="$LOCK.reclaim"

_now() { date +%s; }

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

# _expired <dir> — a finished result past the duplicate window, or an
# unfinished lock past the gate's timeout.
_expired() {
  local age
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
# a later Edit/Write. Observes only: a missing session_id or jq records
# nothing, and nothing here changes the gate's output or exit code.
record_bash_deny() {
  local session cmd base dir window
  [ "$1" = "2" ] || grep -qE "$DENY_PATTERN" "$LOCK/result" 2>/dev/null || return 0
  command -v jq >/dev/null 2>&1 || return 0
  [ "$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || return 0
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
  printf '%s' "$PAYLOAD" | bash "$TARGET" ${PASS[@]+"${PASS[@]}"} >"$LOCK/result" 2>"$LOCK/stderr"
  local rc=${PIPESTATUS[1]}
  if [ "$FAIL_CLOSED" = "1" ] && [ "$rc" != "0" ] && [ "$rc" != "2" ]; then
    grep -qE "$DENY_PATTERN" "$LOCK/result" 2>/dev/null \
      || fail_closed_decision "exited $rc" >"$LOCK/result" 2>>"$LOCK/stderr"
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

DEADLINE=$(( $(_now) + WAIT_S ))
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
