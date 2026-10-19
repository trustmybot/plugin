#!/usr/bin/env bash
# Library: the acting agent's context, resolved from identity and the
# trajectory DB, never from the shared session cwd (GH 1550).
#
# Claude Code gives bro and every subagent one working directory, so $PWD and
# the payload cwd say nothing about who is calling or where it works. The DB
# is the only source of location and identity picks the row:
#   swe     — task_id=<N> in its spawn transcript (the payload
#             agent_transcript_path, else
#             <transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl,
#             else the agent_runs row bound to agent_id at task_brief)
#             → tasks.repo (empty: the sole repos row) → repos.path
#             → <repos.path>/.claude/worktrees/<tmb_branch_slug branch_id>.
#   others  — the project root (tmb_project_root: CLAUDE_PROJECT_DIR).
#
# Provides:
#   tmb_agent_context <input_json> [<db>]
#       Sets and exports TMB_CTX_ROLE, TMB_CTX_TASK_ID, TMB_CTX_REPO,
#       TMB_CTX_REPO_ROOT, TMB_CTX_WORKTREE and TMB_CTX_MISSING. Returns 0
#       resolved (or not a swe), 1 a swe whose context is missing a piece
#       (TMB_CTX_MISSING names it), 2 a DB read error, 3 no trajectory DB.
#   tmb_agent_transcript <input_json>
#       The caller's own transcript file, or empty.
#   tmb_task_location <db> <task_id>
#       Sets TMB_CTX_REPO, TMB_CTX_REPO_ROOT, TMB_CTX_WORKTREE (and
#       TMB_CTX_MISSING); same return codes.
#   tmb_ctx_in_worktree <path>
#       0 when <path> (canonical) lies in TMB_CTX_WORKTREE (canonical).
#   tmb_repo_for_path <db> <path>
#       `<name>|<path>` of the repos row whose canonical path is the git
#       toplevel of <path>, or the toplevel of its main worktree; empty when
#       none.

declare -F tmb_sqlite_ro >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/query-task.sh"
declare -F tmb_agent_role >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/cmd-analysis.sh"
declare -F tmb_repo_name_for_root >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/resolve-repo.sh"


tmb_agent_transcript() {
  local input="${1:-}" t main id
  t=$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null || true)
  if [ -n "$t" ] && [ -f "$t" ]; then
    printf '%s\n' "$t"
    return 0
  fi
  main=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
  id=$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null || true)
  [ -n "$main" ] && [ -n "$id" ] || return 0
  case "$id" in *[!A-Za-z0-9_-]*) return 0 ;; esac
  t="${main%.jsonl}/subagents/agent-${id}.jsonl"
  [ -f "$t" ] && printf '%s\n' "$t"
  return 0
}

tmb_task_location() {
  local db="${1:-}" task="${2:-}" row branch repo name path
  TMB_CTX_REPO=""
  TMB_CTX_REPO_ROOT=""
  TMB_CTX_WORKTREE=""
  task=$(tmb_sql_int "$task")
  if [ -z "$task" ]; then
    TMB_CTX_MISSING="no task_id"
    return 1
  fi
  row=$(tmb_gate_read "$db" "
    SELECT COALESCE(t.branch_id, '') || '|' || COALESCE(t.repo, '') || '|'
           || COALESCE(r.name, '') || '|' || COALESCE(r.path, '')
      FROM tasks t
      LEFT JOIN repos r ON r.name = CASE
          WHEN COALESCE(t.repo, '') <> '' THEN t.repo
          WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT name FROM repos)
        END
     WHERE t.id = ${task} LIMIT 1;")
  if [ "$row" = "__ERR__" ]; then
    TMB_CTX_MISSING="task ${task}: the trajectory DB read failed (tasks/repos)"
    return 2
  fi
  if [ -z "$row" ]; then
    TMB_CTX_MISSING="task ${task} has no tasks row"
    return 1
  fi
  IFS="|" read -r branch repo name path <<< "$row"
  if [ -z "$branch" ]; then
    TMB_CTX_MISSING="task ${task} has no branch_id"
    return 1
  fi
  if [ -z "$name" ] || [ -z "$path" ]; then
    if [ -n "$repo" ]; then
      TMB_CTX_MISSING="task ${task}'s repo '${repo}' has no repos row with a path"
    else
      TMB_CTX_MISSING="task ${task} has no repo: tasks.repo is empty and the repos table does not hold exactly one row"
    fi
    return 1
  fi
  case "$path" in /*) ;; *) path=$(tmb_realdir "$(dirname "$db")/$path") ;; esac
  TMB_CTX_REPO="$name"
  TMB_CTX_REPO_ROOT="${path%/}"
  TMB_CTX_WORKTREE="${TMB_CTX_REPO_ROOT}/.claude/worktrees/$(tmb_branch_slug "$branch")"
  TMB_CTX_MISSING=""
  return 0
}

tmb_agent_context() {
  local input="${1:-}" db="${2:-}" transcript task run rc
  TMB_CTX_ROLE=$(tmb_agent_role "$input")
  TMB_CTX_TASK_ID=""
  TMB_CTX_REPO=""
  TMB_CTX_REPO_ROOT=""
  TMB_CTX_WORKTREE=""
  TMB_CTX_MISSING=""
  export TMB_CTX_ROLE TMB_CTX_TASK_ID TMB_CTX_REPO TMB_CTX_REPO_ROOT TMB_CTX_WORKTREE TMB_CTX_MISSING
  if [ "$TMB_CTX_ROLE" != "swe" ]; then
    TMB_CTX_REPO_ROOT=$(tmb_project_root)
    return 0
  fi
  [ -n "$db" ] || db=$(tmb_db_path 2>/dev/null) || db=""
  if [ -z "$db" ]; then
    TMB_CTX_MISSING="no trajectory DB resolves (TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)"
    return 3
  fi
  transcript=$(tmb_agent_transcript "$input")
  task=$(tmb_task_id_from_transcript "$transcript")
  if [ -z "$task" ]; then
    run=$(tmb_caller_run "$input" "$db")
    if [ "$run" = "__ERR__" ]; then
      TMB_CTX_MISSING="the trajectory DB read failed (agent_runs)"
      return 2
    fi
    task=$(tmb_sql_int "${run%%|*}")
  fi
  if [ -z "$task" ]; then
    if [ -n "$transcript" ]; then
      TMB_CTX_MISSING="no task_id: the spawn transcript ${transcript} carries no task_id=<N>"
    else
      TMB_CTX_MISSING="no task_id: the payload names no spawn transcript (agent_transcript_path, or transcript_path plus agent_id) and no agent_runs row is bound to this agent_id"
    fi
    return 1
  fi
  TMB_CTX_TASK_ID="$task"
  rc=0
  tmb_task_location "$db" "$task" || rc=$?
  return "$rc"
}

tmb_ctx_in_worktree() {
  local c w
  [ -n "${TMB_CTX_WORKTREE:-}" ] && [ -n "${1:-}" ] || return 1
  c=$(tmb_path_canonical "$1")
  w=$(tmb_path_canonical "$TMB_CTX_WORKTREE")
  [ "$c" = "$w" ] && return 0
  case "$c" in "${w%/}"/*) return 0 ;; esac
  return 1
}

tmb_repo_for_path() {
  local db="${1:-}" dir="${2:-}" top common main name
  [ -n "$db" ] && [ -n "$dir" ] || return 0
  while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do dir=$(dirname "$dir"); done
  [ -d "$dir" ] || return 0
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  main=""
  case "$common" in */.git) main="${common%/.git}" ;; esac
  for root in "$top" "$main"; do
    [ -n "$root" ] || continue
    name=$(tmb_repo_name_for_root "$db" "$root")
    if [ -n "$name" ]; then
      printf '%s|%s\n' "$name" "$(tmb_repo_path_by_name "$db" "$name")"
      return 0
    fi
  done
  return 0
}
