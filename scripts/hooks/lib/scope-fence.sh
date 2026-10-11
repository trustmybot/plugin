#!/usr/bin/env bash
# shellcheck disable=SC2034 # TMB_FENCE_STATE / TMB_FENCE_DIRS are read by the sourcing hook
# Library: the SWE scope fence — a task's typed files[] as a dir allowlist.
# Sourced (not exec'd) after query-task.sh. No set -e here — libs must not
# mutate caller shell options. Used by swe-scope-fence.sh (Edit/Write) and
# swe-boundary.sh (every path a Bash command writes), so both reach the same
# decision with the same reason text.
#
# tmb_scope_fence_load <db> <task_id>
#   Reads the task's typed `files` column (JSON array) into TMB_FENCE_DIRS and
#   sets TMB_FENCE_STATE:
#     ok    — at least one allowed dir
#     empty — files[] empty or unparseable: enforcement is skipped
#     none  — no task row (or no usable task id): enforcement is skipped
#     error — the DB read failed: deny-capable callers deny
#   Dir granularity: each listed path contributes its containing directory; a
#   root-level path (no slash) contributes itself; a trailing slash marks the
#   directory itself. Any tests/ entry also opens all of tests/.
#
# tmb_scope_fence_allows <repo-relative-path>
#   Exit 0 when the path is inside an allowed dir (path boundary).
#
# tmb_scope_fence_reason <repo-relative-path>
#   Prints the deny reason for an out-of-scope path.

TMB_FENCE_DIRS=()
TMB_FENCE_STATE="none"
_TMB_FENCE_TESTS=""

tmb_scope_fence_load() {
  local db="${1:-}" task_id files_json file_paths path_token dir
  TMB_FENCE_DIRS=()
  TMB_FENCE_STATE="none"
  _TMB_FENCE_TESTS=""
  task_id=$(tmb_sql_int "${2:-}")
  [ -n "$task_id" ] || return 0
  files_json=$(tmb_gate_read "$db" "SELECT COALESCE(files, '[]') FROM tasks WHERE id = ${task_id} LIMIT 1;")
  if [ "$files_json" = "__ERR__" ]; then TMB_FENCE_STATE="error"; return 0; fi
  [ -n "$files_json" ] || return 0
  file_paths=$(printf '%s' "$files_json" | jq -r '.[]?' 2>/dev/null || true)
  while IFS= read -r path_token; do
    path_token="${path_token%/}"
    [ -n "$path_token" ] || continue
    case "$path_token" in
      */*) dir=$(dirname "$path_token") ;;
      *)   dir="$path_token" ;;
    esac
    TMB_FENCE_DIRS+=("$dir")
    case "$dir" in tests/*|tests) _TMB_FENCE_TESTS="yes" ;; esac
  done <<< "$file_paths"
  if [ "${#TMB_FENCE_DIRS[@]}" -eq 0 ]; then TMB_FENCE_STATE="empty"; else TMB_FENCE_STATE="ok"; fi
  return 0
}

tmb_scope_fence_allows() {
  local rel="${1:-}" allowed
  for allowed in "${TMB_FENCE_DIRS[@]}"; do
    case "$rel" in "${allowed}/"*|"${allowed}") return 0 ;; esac
  done
  if [ "$_TMB_FENCE_TESTS" = "yes" ]; then
    case "$rel" in tests/*|tests) return 0 ;; esac
  fi
  return 1
}

tmb_scope_fence_reason() {
  local dirs
  dirs=$(printf '%s\n' "${TMB_FENCE_DIRS[@]}" | sort -u | tr '\n' ' ')
  printf "BLOCKED (scope fence): '%s' is outside this task's files[] dirs. Allowed: %s. To edit files outside scope, ask bro to extend the task's typed files[] field (or file a follow-up task) — do not edit out of scope." "${1:-}" "${dirs%. }"
}
