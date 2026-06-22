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
#   tmb_repo_remotes <db> <git_root>
#                               — print repos.remotes (JSON array) for the row
#                                 matching <git_root>, falling back to the sole
#                                 registered repo. Empty when unresolved.
#   tmb_repo_is_registered <db> <git_root>
#                               — exits 0 when a repos row with path=<git_root> exists, 1 otherwise.
#   tmb_repo_path_by_name <db> <name>
#                               — print repos.path for the row with name=<name>, or empty.
#   tmb_repo_single_path <db>   — print repos.path when EXACTLY one repo is
#                                 registered (single-repo fallback), else empty.
#   tmb_repo_resolve_path <db> <name>
#                               — print the absolute repo path for <name> via
#                                 repos.path; when <name> is empty, fall back to
#                                 the sole registered repo (single-repo). Empty
#                                 when neither resolves.
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

# tmb_repo_remotes <db> <git_root>
# Prints repos.remotes (JSON array of {name,provider,url}) for the row whose
# path matches <git_root>. When <git_root> is empty or no row matches, falls
# back to the sole registered repo (single-repo). Empty when unresolved.
tmb_repo_remotes() {
  local db="$1"
  local git_root="$2"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local out=""
  if [ -n "$git_root" ]; then
    out=$(sqlite3 -readonly -cmd '.timeout 500' "$db" \
      "SELECT COALESCE(remotes,'')
         FROM repos WHERE path = '$(printf '%s' "$git_root" | sed "s/'/''/g")' LIMIT 1;" \
      2>/dev/null | head -1 || true)
  fi
  if [ -z "$out" ]; then
    local count
    count=$(sqlite3 -readonly -cmd '.timeout 500' "$db" \
      "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
    if [ "${count:-0}" = "1" ]; then
      out=$(sqlite3 -readonly -cmd '.timeout 500' "$db" \
        "SELECT COALESCE(remotes,'') FROM repos LIMIT 1;" 2>/dev/null | head -1 || true)
    fi
  fi
  printf '%s' "$out"
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

# tmb_repo_path_by_name <db> <name>
# Prints repos.path for the row whose name matches <name>; empty when absent.
tmb_repo_path_by_name() {
  local db="$1"
  local name="$2"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ -n "$name" ] || return 0
  sqlite3 -readonly -cmd '.timeout 500' "$db" \
    "SELECT path FROM repos WHERE name = '$(printf '%s' "$name" | sed "s/'/''/g")' LIMIT 1;" \
    2>/dev/null | head -1 || true
}

# tmb_repo_single_path <db>
# Prints repos.path when EXACTLY one repo is registered, else empty.
# This is the single-repo fallback (matches the MCP resolveDefaultRepoPath).
tmb_repo_single_path() {
  local db="$1"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local count
  count=$(sqlite3 -readonly -cmd '.timeout 500' "$db" \
    "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
  [ "${count:-0}" = "1" ] || return 0
  sqlite3 -readonly -cmd '.timeout 500' "$db" \
    "SELECT path FROM repos LIMIT 1;" 2>/dev/null | head -1 || true
}

# tmb_repo_resolve_path <db> <name>
# Resolve the absolute repo path: by <name> via repos.path; when <name> is
# empty, fall back to the sole registered repo (single-repo). Empty when neither.
tmb_repo_resolve_path() {
  local db="$1"
  local name="$2"
  local path=""
  if [ -n "$name" ]; then
    path=$(tmb_repo_path_by_name "$db" "$name")
  fi
  if [ -z "$path" ]; then
    path=$(tmb_repo_single_path "$db")
  fi
  printf '%s' "$path"
}
