#!/usr/bin/env bash
# backfill-agent-runs.sh with no trajectory DB exits non-zero and creates
# nothing: run from an empty temp dir, HOME pointed inside it, once with
# TRAJECTORY_DB_PATH at a missing path and once with it unset.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/maintenance/backfill-agent-runs.sh"

fail=0
run_case() {
  local name="$1" db_env="$2"
  local root rc out leaked
  root="$(mktemp -d)"
  mkdir "$root/home" "$root/cwd"
  rc=0
  if [ -n "$db_env" ]; then
    out="$(cd "$root/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u CLAUDE_CONFIG_DIR \
      HOME="$root/home" TRAJECTORY_DB_PATH="$root/cwd/nope/trajectory.db" bash "$SCRIPT" 2>&1)" || rc=$?
  else
    out="$(cd "$root/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u CLAUDE_CONFIG_DIR -u TRAJECTORY_DB_PATH \
      HOME="$root/home" bash "$SCRIPT" 2>&1)" || rc=$?
  fi
  leaked="$(find "$root" -mindepth 1 ! -path "$root/home" ! -path "$root/cwd" -print)"
  if [ "$rc" -eq 0 ]; then
    printf 'FAIL %s: exit 0 with no DB\n%s\n' "$name" "$out" >&2; fail=1
  elif [ -n "$leaked" ]; then
    printf 'FAIL %s: created files:\n%s\n' "$name" "$leaked" >&2; fail=1
  else
    printf 'ok %s: exit %s, nothing created\n' "$name" "$rc"
  fi
  rm -rf "$root"
}

run_case "TRAJECTORY_DB_PATH at a missing path" set
run_case "no TRAJECTORY_DB_PATH, empty cwd" ""
exit "$fail"
