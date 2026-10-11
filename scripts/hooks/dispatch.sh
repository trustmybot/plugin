#!/usr/bin/env bash
# The one entry point for every TMB hook registration:
#
#   dispatch.sh <gate> [--shim]
#
# hooks/hooks.json registers `dispatch.sh <gate>` for every gate; the headless
# shim (scripts/lib/resolve-hook.sh) execs `dispatch.sh <gate> --shim`. However
# many registrations fire for one event — a project and a user-scope install,
# two channels, the shim beside the plugin — the gate runs once, at one version:
#
# 1. One install per project. lib/resolve-install.sh picks the install this
#    project uses; the gate executed is <that install>/scripts/hooks/<gate>.sh,
#    with CLAUDE_PLUGIN_ROOT pointing at it.
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
#    A project without TMB state (no trajectory DB) still runs the gate but
#    takes no lock: nothing is written in a non-TMB project.

set -uo pipefail

GATE="${1:-}"
[ $# -gt 0 ] && shift
SHIM=0
PASS=()
for arg in "$@"; do
  if [ "$arg" = "--shim" ] && [ "$SHIM" = "0" ]; then
    SHIM=1
  else
    PASS+=("$arg")
  fi
done

case "$GATE" in
  ''|*[!a-z0-9-]*|dispatch)
    printf 'TMB dispatch: invalid gate name %s — skipped\n' "'${GATE}'" >&2
    exit 0
    ;;
esac

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SELF_ROOT}"

# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SELF_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-install.sh
. "$SELF_DIR/lib/resolve-install.sh"

ROOT=$(tmb_active_install)
TARGET="$ROOT/scripts/hooks/$GATE.sh"
if [ -z "$ROOT" ] || [ ! -f "$TARGET" ]; then
  ROOT="$SELF_ROOT"
  TARGET="$SELF_ROOT/scripts/hooks/$GATE.sh"
fi
if [ ! -f "$TARGET" ]; then
  printf 'TMB dispatch: no gate %s.sh in %s — skipped\n' "$GATE" "$ROOT" >&2
  exit 0
fi
export CLAUDE_PLUGIN_ROOT="$ROOT"

LOCK_BASE=""
if tmb_have_sqlite && STATE_DIR=$(tmb_state_dir 2>/dev/null); then
  LOCK_BASE="$STATE_DIR/locks/events"
fi

if [ "$SHIM" = "0" ] && [ -z "$LOCK_BASE" ]; then
  exec bash "$TARGET" ${PASS[@]+"${PASS[@]}"}
fi

PAYLOAD=$(cat)

run_gate() {
  printf '%s' "$PAYLOAD" | bash "$TARGET" ${PASS[@]+"${PASS[@]}"}
}

if [ "$SHIM" = "1" ] && command -v jq >/dev/null 2>&1; then
  SHIM_PROJECT="${TMB_SHIM_PROJECT:-}"
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -n "$SHIM_PROJECT" ] \
     && [ "$(_tmb_canonical_dir "$CLAUDE_PROJECT_DIR")" != "$(_tmb_canonical_dir "$SHIM_PROJECT")" ]; then
    exit 0
  fi
  SESSION_ROOT="${CLAUDE_PROJECT_DIR:-$SHIM_PROJECT}"
  SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)
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

GATE_TIMEOUT=$(jq -r --arg g "$GATE" '
  [.hooks[][]?.hooks[]? | select((.command // "") | test("/dispatch\\.sh " + $g + "( |$)")) | .timeout // empty]
  | max // empty' "$SELF_ROOT/hooks/hooks.json" 2>/dev/null || true)
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

hold() {
  printf '%s' "$PAYLOAD" | bash "$TARGET" ${PASS[@]+"${PASS[@]}"} >"$LOCK/result" 2>"$LOCK/stderr"
  local rc=${PIPESTATUS[1]}
  printf '%s\n' "$rc" > "$LOCK/rc.tmp" 2>/dev/null && mv -f "$LOCK/rc.tmp" "$LOCK/rc" 2>/dev/null
  cat "$LOCK/stderr" >&2 2>/dev/null
  cat "$LOCK/result" 2>/dev/null
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
  [ "$(_now)" -ge "$DEADLINE" ] && exit 0
  sleep 0.1
done
