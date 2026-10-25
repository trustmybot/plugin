#!/usr/bin/env bash
# shellcheck disable=SC2034 # TMB_FENCE_STATE / TMB_FENCE_DIRS are read by the sourcing hook
# Library: the SWE scope classifier — a task's typed files[] as a path list.
# Sourced (not exec'd) after query-task.sh. No set -e here — libs must not
# mutate caller shell options. Used by swe-scope-fence.sh (Edit/Write) and
# swe-boundary.sh (every path a Bash command writes, as tmb_cmd_write_paths
# reports it: a program fed to an interpreter through a heredoc included, a
# data heredoc never) to note, never deny, a write outside files[]; scope is
# judged at close by bro_atomic_close on the task's own diff.
#
# tmb_scope_fence_load <db> <task_id>
#   Reads the task's typed `files` column (JSON array) into TMB_FENCE_DIRS and
#   sets TMB_FENCE_STATE:
#     ok    — at least one listed path
#     empty — files[] empty or unparseable: no notes
#     none  — no task row (or no usable task id): no notes
#     error — the DB read failed: no notes
#   Each entry, trailing slashes stripped, covers itself and everything
#   beneath it (the CODEOWNERS / git-pathspec rule), never its siblings:
#   `src/a/b.ts` covers only that file. Any tests/ entry also covers all of
#   tests/. Same rule as pathInFiles in bro_atomic_close's scope gate.
#
# tmb_scope_fence_allows <repo-relative-path>
#   Exit 0 when the path is a listed entry or beneath one (path boundary).
#
# tmb_scope_fence_note <task_id> <repo-relative-path>
#   Prints the note for a path outside files[] the first time this task writes
#   it; prints nothing on later writes. The marker lives under
#   <state>/locks/scope-notes/<task_id>/ (tmb_state_dir), never under $HOME.

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
    dir="$path_token"
    while [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
    [ -n "$dir" ] || continue
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

tmb_scope_fence_note() {
  local task_id rel="${2:-}" state marker dirs
  task_id=$(tmb_sql_int "${1:-}")
  [ -n "$task_id" ] && [ -n "$rel" ] || return 0
  state=$(tmb_state_dir 2>/dev/null) || return 0
  marker="$state/locks/scope-notes/$task_id/$(printf '%s' "$rel" | cksum | cut -d' ' -f1)"
  mkdir -p "$(dirname "$marker")" 2>/dev/null || return 0
  mkdir "$marker" 2>/dev/null || return 0
  dirs=$(printf '%s\n' "${TMB_FENCE_DIRS[@]}" | sort -u | paste -sd, - | sed 's/,/, /g')
  printf "%s is outside this task's files[] (%s); list it and why in your report" "$rel" "$dirs"
}
