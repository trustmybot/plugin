#!/usr/bin/env bash
# Tests for scripts/hooks/orphan-scan.sh — self-PID exclusion and owner-liveness
# classification of trajectory-server procs holding THIS project's live DB.
#
# Cases:
#   (a) the current session's own server is never flagged
#   (b) a live other-session server is reported as a lock-conflict and survives
#       clean mode (TMB_ORPHAN_SCAN_CLEAN=1)
#   (c) a dead-owner server is flagged stale and IS killed in clean mode
#
# Process trees are fabricated with sleep subprocesses re-parented as needed:
#   - a "CC" proc is a bash renamed to `claude` (argv[0]) via `exec -a`
#   - a "server" child is a sleep renamed so its argv contains
#     trajectory-server/dist/index.js
#   - DB holders are injected via TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE (no lsof)
#   - the own-CC ancestry-walk start pid is pinned via TMB_ORPHAN_SCAN_SELF_PID
# All state lives under a mktemp sandbox; project + HOME are pinned so the real
# artifacts are never touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/orphan-scan.sh"

TMPDIR_BASE=$(mktemp -d)
PIDS_TO_KILL=()
cleanup() {
  for p in "${PIDS_TO_KILL[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

cd "$TMPDIR_BASE"
assert_not_in_plugin_repo "$PLUGIN_ROOT"

PROJECT_DIR="$TMPDIR_BASE/project"
SCAN_HOME="$TMPDIR_BASE/home"
mkdir -p "$PROJECT_DIR/.claude/tmb" "$SCAN_HOME/.claude"
LIVE_DB="$PROJECT_DIR/.claude/tmb/trajectory.db"
printf 'live' > "$LIVE_DB"   # non-empty so the [ -s "$LIVE_DB" ] gate is true

SRV_ARGV="node /x/mcp/trajectory-server/dist/index.js"

# Spawn a live "CC" (argv[0]=claude) with a trajectory-server child and a hook
# surrogate child. Writes "CC/SRV/HOOK <pid>" lines to $1. All three survive
# until killed in cleanup.
spawn_live_tree() {
  local pf="$1"
  ( exec -a claude bash -c '
      ( exec -a "'"$SRV_ARGV"'" sleep 300 ) &
      echo "SRV $!" >> "'"$pf"'"
      ( exec -a "cc-hook-runner" sleep 300 ) &
      echo "HOOK $!" >> "'"$pf"'"
      wait
    ' ) &
  echo "CC $!" >> "$pf"
  disown "$!" 2>/dev/null || true   # keep job-control termination noise quiet
}

# Spawn a trajectory-server child whose "CC" parent exits immediately, leaving
# the server re-parented to init (dead owner). Writes "SRV <pid>" to $1.
spawn_dead_owner_tree() {
  local pf="$1"
  ( exec -a claude bash -c '
      ( exec -a "'"$SRV_ARGV"'" sleep 300 ) &
      echo "SRV $!" >> "'"$pf"'"
    ' ) &
  echo "CC $!" >> "$pf"
  disown "$!" 2>/dev/null || true
}

run_hook() {
  echo '{}' | bash "$HOOK" 2>&1 || true
}

# --- shared "current session" context (a live CC + hook surrogate) ----------
PF_SELF="$TMPDIR_BASE/self.pids"; : > "$PF_SELF"
spawn_live_tree "$PF_SELF"
sleep 0.6
SELF_CC=$(awk '/^CC/{print $2}' "$PF_SELF")
SELF_SRV=$(awk '/^SRV/{print $2}' "$PF_SELF")
SELF_HOOK=$(awk '/^HOOK/{print $2}' "$PF_SELF")
PIDS_TO_KILL+=("$SELF_CC" "$SELF_SRV" "$SELF_HOOK")

# --- (a) own-session server is never flagged --------------------------------
test_case "own-session server is never flagged (self-PID exclusion)"
out=$(TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJECT_DIR" TMB_ORPHAN_SCAN_HOME="$SCAN_HOME" \
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE="$SELF_SRV" \
      TMB_ORPHAN_SCAN_SELF_PID="$SELF_HOOK" run_hook)
assert_not_contains "$out" "trajectory-server" "own server produces no proc report"
assert_not_contains "$out" "lock-conflict" "own server is not a lock-conflict"
assert_eq "" "$out" "own server → silent"

# --- (b) live other-session server → lock-conflict, survives clean mode ------
PF_OTHER="$TMPDIR_BASE/other.pids"; : > "$PF_OTHER"
spawn_live_tree "$PF_OTHER"
sleep 0.6
OTHER_CC=$(awk '/^CC/{print $2}' "$PF_OTHER")
OTHER_SRV=$(awk '/^SRV/{print $2}' "$PF_OTHER")
OTHER_HOOK=$(awk '/^HOOK/{print $2}' "$PF_OTHER")
PIDS_TO_KILL+=("$OTHER_CC" "$OTHER_SRV" "$OTHER_HOOK")

test_case "live other-session server is reported as a lock-conflict"
out=$(TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJECT_DIR" TMB_ORPHAN_SCAN_HOME="$SCAN_HOME" \
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE="$OTHER_SRV" \
      TMB_ORPHAN_SCAN_SELF_PID="$SELF_HOOK" run_hook)
assert_contains "$out" "lock-conflict" "live other server → lock-conflict"
assert_contains "$out" "pid $OTHER_SRV" "lock-conflict names the holder pid"
assert_not_contains "$out" "stale duplicate" "live owner is never called stale"

test_case "live other-session server is NOT killed in clean mode"
out=$(TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJECT_DIR" TMB_ORPHAN_SCAN_HOME="$SCAN_HOME" \
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE="$OTHER_SRV" \
      TMB_ORPHAN_SCAN_SELF_PID="$SELF_HOOK" TMB_ORPHAN_SCAN_CLEAN=1 run_hook)
sleep 0.2
if kill -0 "$OTHER_SRV" 2>/dev/null; then _pass; else _fail "live other server was killed in clean mode"; fi

# --- (c) dead-owner server → stale, killed in clean mode --------------------
PF_DEAD="$TMPDIR_BASE/dead.pids"; : > "$PF_DEAD"
spawn_dead_owner_tree "$PF_DEAD"
sleep 0.8
DEAD_SRV=$(awk '/^SRV/{print $2}' "$PF_DEAD")
PIDS_TO_KILL+=("$DEAD_SRV")

test_case "dead-owner server is flagged stale"
out=$(TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJECT_DIR" TMB_ORPHAN_SCAN_HOME="$SCAN_HOME" \
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE="$DEAD_SRV" \
      TMB_ORPHAN_SCAN_SELF_PID="$SELF_HOOK" run_hook)
assert_contains "$out" "stale duplicate trajectory-server" "dead-owner server → stale"
assert_contains "$out" "pid $DEAD_SRV" "stale report names the holder pid"

test_case "dead-owner server IS killed in clean mode"
out=$(TMB_ORPHAN_SCAN_PROJECT_DIR="$PROJECT_DIR" TMB_ORPHAN_SCAN_HOME="$SCAN_HOME" \
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE="$DEAD_SRV" \
      TMB_ORPHAN_SCAN_SELF_PID="$SELF_HOOK" TMB_ORPHAN_SCAN_CLEAN=1 run_hook)
sleep 0.3
if kill -0 "$DEAD_SRV" 2>/dev/null; then _fail "dead-owner server survived clean mode"; else _pass; fi

summarize
