#!/usr/bin/env bash
# The maintenance scripts that import trajectory-server modules
# (backfill-agent-runs.sh, trajectory-doctor.sh, run-scan.mjs) check the DB
# before importing any tool module: with no trajectory DB each exits 2 and
# creates nothing. Each runs from an empty temp dir, HOME pointed inside it,
# once with TRAJECTORY_DB_PATH at a missing path and once with it unset.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
MAINT="$PLUGIN_ROOT/scripts/maintenance"

fail=0
run_case() {
  local script="$1" name="$2" db_env="$3"
  local root rc out leaked cmd
  root="$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-maintenance-scripts-no-db.XXXXXX")"
  mkdir "$root/home" "$root/cwd"
  case "$script" in
    *.mjs) cmd=(node --experimental-sqlite --no-warnings "$MAINT/$script") ;;
    *) cmd=(bash "$MAINT/$script") ;;
  esac
  rc=0
  if [ -n "$db_env" ]; then
    out="$(cd "$root/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u CLAUDE_CONFIG_DIR \
      HOME="$root/home" TRAJECTORY_DB_PATH="$root/cwd/nope/trajectory.db" "${cmd[@]}" 2>&1)" || rc=$?
  else
    out="$(cd "$root/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u CLAUDE_CONFIG_DIR -u TRAJECTORY_DB_PATH \
      HOME="$root/home" "${cmd[@]}" 2>&1)" || rc=$?
  fi
  leaked="$(find "$root" -mindepth 1 ! -path "$root/home" ! -path "$root/cwd" -print)"
  if [ "$rc" -ne 2 ]; then
    printf 'FAIL %s, %s: exit %s with no DB (want 2)\n%s\n' "$script" "$name" "$rc" "$out" >&2; fail=1
  elif [ -n "$leaked" ]; then
    printf 'FAIL %s, %s: created files:\n%s\n' "$script" "$name" "$leaked" >&2; fail=1
  else
    printf 'ok %s, %s: exit 2, nothing created\n' "$script" "$name"
  fi
  rm -rf "$root"
}

for script in backfill-agent-runs.sh trajectory-doctor.sh run-scan.mjs; do
  run_case "$script" "TRAJECTORY_DB_PATH at a missing path" set
  run_case "$script" "no TRAJECTORY_DB_PATH, empty cwd" ""
done
exit "$fail"
