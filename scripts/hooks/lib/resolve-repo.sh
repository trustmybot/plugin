#!/usr/bin/env bash
# Library: per-repo config resolver for TMB hooks.
# Sourced (not exec'd) by git-guards.sh, git-push-guard.sh, and
# branch-up-to-date-with-remote.sh.
#
# Provides:
#   tmb_cmd_cwd <command> [<input_json>]
#                               — print the directory a Bash command will run in,
#                                 parsing a leading `cd <path> &&` / `git -C <path>`
#                                 target (a relative one joined to the payload
#                                 cwd), else the payload cwd (tmb_payload_cwd).
#                                 This is the repo-scoping primitive: in a
#                                 multi-repo workspace the session cwd is the
#                                 non-repo root, so guards must resolve the repo
#                                 from the command itself.
#   tmb_repo_default_branch <git_root>
#                               — print the repo's real default branch: origin/HEAD's
#                                 target, else the main checkout's HEAD branch, else
#                                 "main". Empty only when <git_root> is empty.
#   tmb_repo_git_root <dir>     — print the MAIN worktree root for <dir> (or its
#                                 nearest existing ancestor), or empty
#   tmb_repo_name_for_root <db> <git_root>
#                               — print the name of the repos row whose path is
#                                 <git_root>, compared as canonical realpaths (a
#                                 relative repos.path joins the DB dir), or empty.
#   tmb_repo_resolve <db> <git_root>
#                               — print pipe-separated "target_branch|branching_model|protected_branches"
#                                 from the repos row matching <git_root>
#                                 (tmb_repo_name_for_root).
#                                 Prints empty when no row matches (unregistered repo).
#   tmb_repo_remotes <db> <git_root>
#                               — print the repo's repo_remotes rows as a JSON
#                                 array of {name,provider,url} for the row
#                                 matching <git_root>, falling back to the sole
#                                 registered repo. Empty when unresolved.
#   tmb_repo_is_registered <db> <git_root>
#                               — exits 0 when a repos row matches <git_root>
#                                 (tmb_repo_name_for_root), 1 otherwise.
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
# DB reads go through tmb_sqlite_ro (lib/query-task.sh), sourced here when the
# caller has not.

declare -F tmb_sqlite_ro >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/query-task.sh"

# tmb_cmd_cwd <command> [<input_json>]
# Resolve the working directory a Bash command will execute in. SWE and bro
# prefix commands with `cd <repo> &&` (or `git -C <repo>`) to target a specific
# repo in a multi-repo workspace; the session cwd is the non-repo workspace
# root and must NOT be trusted to scope the guard. Resolution order:
#   1. leading `cd <path> &&|;|<newline>` prefix (quoted or bare)
#   2. `git -C <path>` option in the command
#   3. the dir the command starts in (tmb_payload_cwd: the payload `.cwd`)
# A relative path from 1 or 2 is joined to 3, where the shell resolves it.
tmb_cmd_cwd() {
  local cmd="$1"
  local input="${2:-}"
  local cd_path base
  # shellcheck source=scripts/hooks/lib/cmd-analysis.sh disable=SC1091
  declare -F tmb_payload_cwd >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/cmd-analysis.sh"
  base=$(tmb_payload_cwd "$input")
  # Match leading: `cd /some/path &&` or `cd /some/path ;` or `cd /some/path\n`
  cd_path=$(echo "$cmd" | sed -nE 's|^[[:space:]]*cd[[:space:]]+("([^"]+)"\|'"'"'([^'"'"']+)'"'"'\|([^[:space:]&;]+)).*|\2\3\4|p' | head -1)
  if [ -z "$cd_path" ]; then
    cd_path=$(echo "$cmd" | grep -oE 'git -C [^[:space:]]+' | head -1 | awk '{print $3}' | tr -d "'\"")
  fi
  case "$cd_path" in
    '') echo "$base" ;;
    /*) echo "$cd_path" ;;
    *) echo "${base%/}/$cd_path" ;;
  esac
}

# tmb_repo_default_branch <git_root>
# Print the repo's real default branch. Resolution order:
#   1. the remote's default (origin/HEAD's target)
#   2. the first well-known default name that actually exists (main, master, dev)
#   3. the main checkout's current branch (HEAD)
#   4. "main"
# Empty only when <git_root> is empty. Used as the base-check fallback when a
# configured target_branch ref does not actually exist in the repo. Steps 1–2
# avoid returning a feature branch that merely happens to be the checked-out HEAD.
tmb_repo_default_branch() {
  local root="$1"
  [ -n "$root" ] || return 0
  local b cand
  b=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  if [ -n "$b" ]; then
    printf '%s' "$b"
    return 0
  fi
  for cand in main master dev; do
    if git -C "$root" show-ref --verify --quiet "refs/heads/$cand" 2>/dev/null; then
      printf '%s' "$cand"
      return 0
    fi
  done
  b=$(git -C "$root" symbolic-ref --short HEAD 2>/dev/null || true)
  if [ -n "$b" ]; then
    printf '%s' "$b"
    return 0
  fi
  printf 'main'
}

# tmb_repo_git_root <dir>
# Prints the MAIN worktree root for <dir> (or its nearest existing ancestor);
# empty string if not inside a git repo or <dir> is empty. Works correctly for
# linked worktrees and subdirs — always returns the single registered repo
# root, not the linked-worktree path.
tmb_repo_git_root() {
  local target="${1:-}"
  [ -n "$target" ] || return 0
  while [ ! -d "$target" ] && [ "$target" != "/" ] && [ "$target" != "." ]; do
    target=$(dirname "$target")
  done
  [ -d "$target" ] || return 0
  local common
  common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || true
  if [ -n "$common" ]; then
    (cd "$(dirname "$common")" && pwd) 2>/dev/null || true
  else
    git -C "$target" rev-parse --show-toplevel 2>/dev/null || true
  fi
}

# tmb_repo_name_for_root <db> <git_root>
# Prints the name of the repos row whose path is <git_root>: an exact match,
# else the row whose canonical realpath (a relative path joined to the DB dir)
# equals <git_root>'s. Empty when none.
tmb_repo_name_for_root() {
  local db="$1" git_root="$2" name rows want row rname rpath
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ -n "$git_root" ] || return 0
  name=$(tmb_sqlite_ro "$db" \
    "SELECT name FROM repos WHERE path = '$(tmb_sql_quote "$git_root")' LIMIT 1;" | head -1 || true)
  if [ -n "$name" ]; then
    printf '%s\n' "$name"
    return 0
  fi
  want=$(tmb_realdir "$git_root")
  rows=$(tmb_sqlite_ro "$db" "SELECT name || '|' || path FROM repos ORDER BY name;" || true)
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    rname="${row%%|*}"
    rpath="${row#*|}"
    [ -n "$rpath" ] || continue
    case "$rpath" in /*) ;; *) rpath="$(dirname "$db")/$rpath" ;; esac
    if [ "$(tmb_realdir "$rpath")" = "$want" ]; then
      printf '%s\n' "$rname"
      return 0
    fi
  done <<< "$rows"
  return 0
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
  local name
  name=$(tmb_repo_name_for_root "$db" "$git_root")
  [ -n "$name" ] || return 0
  tmb_sqlite_ro "$db" \
    "SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'')
       FROM repos WHERE name = '$(tmb_sql_quote "$name")' LIMIT 1;" \
    | head -1 || true
}

# tmb_repo_remotes <db> <git_root>
# Prints the repo's remotes as a JSON array of {name,provider,url} (primary
# first) built from repo_remotes, for the repos row whose path matches
# <git_root>; "[]" for a registered repo with no remotes. When <git_root> is
# empty or no row matches, falls back to the sole registered repo
# (single-repo). Empty when unresolved.
tmb_repo_remotes() {
  local db="$1"
  local git_root="$2"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local remotes="COALESCE((SELECT json_group_array(json_object('name', rr.name, 'provider', rr.provider, 'url', rr.url))
      FROM (SELECT name, provider, url FROM repo_remotes WHERE repo = r.name ORDER BY is_primary DESC, rowid) rr), '[]')"
  local out="" name=""
  [ -z "$git_root" ] || name=$(tmb_repo_name_for_root "$db" "$git_root")
  if [ -n "$name" ]; then
    out=$(tmb_sqlite_ro "$db" \
      "SELECT ${remotes} FROM repos r WHERE r.name = '$(tmb_sql_quote "$name")' LIMIT 1;" \
      | head -1 || true)
  fi
  if [ -z "$out" ]; then
    local count
    count=$(tmb_sqlite_ro "$db" "SELECT COUNT(*) FROM repos;")
    if [ "${count:-0}" = "1" ]; then
      out=$(tmb_sqlite_ro "$db" "SELECT ${remotes} FROM repos r LIMIT 1;" | head -1 || true)
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
  [ -n "$(tmb_repo_name_for_root "$db" "$git_root")" ]
}

# tmb_repo_path_by_name <db> <name>
# Prints repos.path for the row whose name matches <name>; empty when absent.
tmb_repo_path_by_name() {
  local db="$1"
  local name="$2"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ -n "$name" ] || return 0
  tmb_sqlite_ro "$db" \
    "SELECT path FROM repos WHERE name = '$(printf '%s' "$name" | sed "s/'/''/g")' LIMIT 1;" \
    | head -1 || true
}

# tmb_repo_single_path <db>
# Prints repos.path when EXACTLY one repo is registered, else empty.
# This is the single-repo fallback (matches the MCP resolveDefaultRepoPath).
tmb_repo_single_path() {
  local db="$1"
  [ -f "$db" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local count
  count=$(tmb_sqlite_ro "$db" "SELECT COUNT(*) FROM repos;")
  [ "${count:-0}" = "1" ] || return 0
  tmb_sqlite_ro "$db" "SELECT path FROM repos LIMIT 1;" | head -1 || true
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
