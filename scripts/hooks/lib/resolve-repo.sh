#!/usr/bin/env bash
# Library: per-repo config resolver for TMB hooks.
# Sourced (not exec'd) by git-guards.sh, git-push-guard.sh, and
# branch-up-to-date-with-remote.sh.
#
# Provides:
#   tmb_repo_git_root <dir>     — print the MAIN worktree root for <dir>, or empty
#   tmb_repo_resolve <db> <git_root>
#                               — print pipe-separated "target_branch|branching_model|protected_branches"
#                                 from the repos row matching <git_root>.
#                                 Prints empty when no row matches (unregistered repo).
#   tmb_repo_is_registered <db> <git_root>
#                               — exits 0 when a repos row with path=<git_root> exists, 1 otherwise.
#
# All functions never fail the caller (use || true / return 0 patterns).

# tmb_repo_git_root <dir>
# Prints the MAIN worktree root for <dir>; empty string if not inside a git repo.
# Works correctly for linked worktrees and subdirs — always returns the single
# registered repo root, not the linked-worktree path.
tmb_repo_git_root() {
  local dir="${1:-$PWD}"
  local target
  target=$([ -d "$dir" ] && echo "$dir" || echo "$PWD")
  local common
  common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || true
  if [ -n "$common" ]; then
    (cd "$(dirname "$common")" && pwd) 2>/dev/null || true
  else
    git -C "$target" rev-parse --show-toplevel 2>/dev/null || true
  fi
}

# tmb_repo_resolve <db> <git_root>
# Prints three lines: target_branch, branching_model, protected_branches_json.
# Each line may be empty when the column is NULL or the row is absent.
tmb_repo_resolve() {
  local db="$1"
  local git_root="$2"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ -n "$git_root" ] || return 0
  sqlite3 -readonly -cmd '.timeout 500' "$db" \
    "SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'')
       FROM repos WHERE path = '$(printf '%s' "$git_root" | sed "s/'/''/g")' LIMIT 1;" \
    2>/dev/null | head -1 || true
}

# tmb_repo_is_registered <db> <git_root>
# Exits 0 when repos has a row with path=<git_root>; exits 1 otherwise.
tmb_repo_is_registered() {
  local db="$1"
  local git_root="$2"
  [ -f "$db" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1
  [ -n "$git_root" ] || return 1
  local count
  count=$(sqlite3 -readonly -cmd '.timeout 500' "$db" \
    "SELECT COUNT(*) FROM repos WHERE path = '$(printf '%s' "$git_root" | sed "s/'/''/g")';" \
    2>/dev/null || echo 0)
  [ "${count:-0}" -gt 0 ]
}
