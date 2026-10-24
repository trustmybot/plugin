#!/usr/bin/env bash
# PostToolUse hook on Bash — auto-clean a merged feature branch + its worktree
# after its PR is merged (#772/#89).
#
# After `gh pr merge` / `glab mr merge` succeeds, the merged feature branch and
# its SWE worktree linger locally. This hook removes them:
#   - derive the merged branch (explicit `<branch>` arg, else the current branch),
#   - refuse to touch a protected branch (main/dev, plus repos.protected_branches),
#   - confirm the branch's work is in its base (_cmb_integrated: ancestor, or a
#     squash/rebase merge whose content the base already holds),
#   - if the branch's worktree is dirty (uncommitted/untracked), skip + warn,
#   - else `git worktree remove`, `git branch -D`, `git worktree prune`, then a
#     best-effort `git fetch --prune`.
#
# Non-load-bearing: every path exits 0. Failures emit an informational note to
# stderr (visible in CC's debug log) and never block. Remote deletion is out of
# scope — `gh pr merge --delete-branch` already handles the remote.
#
# Bypass: TMB_DISABLE_CLEAN_MERGED_BRANCH=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

# When sourced (e.g. by a test exercising helpers), stop after defining them.
_clean_merged_branch_main() {
  if [ "${TMB_DISABLE_CLEAN_MERGED_BRANCH:-0}" = "1" ]; then
    exit 0
  fi

  command -v jq >/dev/null 2>&1 || exit 0
  command -v git >/dev/null 2>&1 || exit 0

  local input tool_name cmd resp
  input=$(cat 2>/dev/null) || exit 0
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
  [ "$tool_name" = "Bash" ] || exit 0

  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
  resp=$(printf '%s' "$input" | jq -r '.tool_response | if type == "string" then . else tojson end' 2>/dev/null)
  [ -n "$cmd" ] || exit 0

  # Act only on a PR/MR merge command (word-boundary match; git/gh/glab parity).
  if ! printf '%s' "$cmd" | grep -E '(^|[^[:alnum:]_-])(gh[[:space:]]+pr[[:space:]]+merge|glab[[:space:]]+mr[[:space:]]+merge)([^[:alnum:]_-]|$)' >/dev/null; then
    exit 0
  fi

  # The tool result must indicate success. A failed merge (auth, conflict,
  # not-mergeable) must never trigger deletion. Treat an explicit failure
  # signal in the response as a hard stop; otherwise assume success (PostToolUse
  # only fires after the tool ran, and CC reports failures in tool_response).
  if printf '%s' "$resp" | grep -iE '(is_error|"error"|failed to merge|not mergeable|merge conflict|GraphQL: |pull request is not mergeable)' >/dev/null; then
    exit 0
  fi

  # Resolve the repo from the command's `cd <repo> &&` / `git -C <repo>` target
  # (then the payload .cwd, then $PWD) — in a multi-repo workspace $PWD/.cwd is
  # the non-repo workspace root and would mis-scope the cleanup to the wrong tree.
  local cwd
  cwd=$(tmb_cmd_cwd "$cmd" "$input")

  # Resolve the MAIN repo root (the merge may run from a worktree).
  local repo_root
  repo_root=$(tmb_repo_git_root "$cwd")
  [ -n "$repo_root" ] || exit 0
  [ -d "$repo_root" ] || exit 0

  # Derive the merged branch. `gh pr merge [<number|url|branch>]` /
  # `glab mr merge [<id>]` may name a branch explicitly; only a non-numeric,
  # non-flag token that resolves to a local branch counts. Otherwise fall back
  # to the branch checked out where the merge ran.
  local branch=""
  branch=$(_cmb_branch_from_cmd "$cmd" "$repo_root")
  if [ -z "$branch" ]; then
    branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  fi
  [ -n "$branch" ] || exit 0
  [ "$branch" != "HEAD" ] || exit 0

  # The branch must exist locally to be a deletion candidate.
  git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 || exit 0

  # Protected-branch guard: hard-exclude main/dev, plus repos.protected_branches.
  if _cmb_is_protected "$repo_root" "$branch"; then
    exit 0
  fi

  # Determine the base branch to validate the merge against.
  local base
  base=$(_cmb_base_branch "$repo_root")
  [ -n "$base" ] || exit 0
  # The base must exist; never compare against a missing ref.
  git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$base" >/dev/null 2>&1 || exit 0
  # Don't delete the base itself.
  [ "$branch" != "$base" ] || exit 0

  # The branch's work must already be in the base (merge, squash or rebase).
  # If not, do nothing — the merge may have been a different branch.
  if ! _cmb_integrated "$repo_root" "refs/heads/$branch" "refs/heads/$base"; then
    exit 0
  fi

  # Locate the branch's worktree (if any), and refuse to act on a dirty one.
  local worktree_path
  worktree_path=$(_cmb_worktree_for_branch "$repo_root" "$branch")

  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    if [ -n "$(git -C "$worktree_path" status --porcelain 2>/dev/null)" ]; then
      printf 'tmb: branch %s is merged but its worktree %s has uncommitted/untracked changes — skipping cleanup (never force)\n' "$branch" "$worktree_path" >&2
      exit 0
    fi
    git -C "$repo_root" worktree remove "$worktree_path" >/dev/null 2>&1 || {
      printf 'tmb: worktree remove failed for %s — leaving branch %s in place\n' "$worktree_path" "$branch" >&2
      exit 0
    }
  fi

  # `-D`, not `-d`: git's own merged check is ancestry relative to HEAD/upstream
  # and refuses a squash-merged branch. _cmb_integrated above already proved
  # the branch's content is in the base, so no work can be lost.
  if git -C "$repo_root" branch -D "$branch" >/dev/null 2>&1; then
    git -C "$repo_root" worktree prune >/dev/null 2>&1 || true
    printf 'tmb: cleaned up merged branch %s%s\n' "$branch" \
      "${worktree_path:+ (worktree $worktree_path)}" >&2
  else
    printf 'tmb: branch delete failed for %s — leaving in place\n' "$branch" >&2
    git -C "$repo_root" worktree prune >/dev/null 2>&1 || true
  fi

  # Best-effort prune of the merged branch's remote-tracking ref, detached so a
  # slow or unreachable remote never holds the hook past its timeout.
  (GIT_TERMINAL_PROMPT=0 git -C "$repo_root" fetch --prune --quiet </dev/null >/dev/null 2>&1 &)

  exit 0
}

# _cmb_branch_from_cmd <cmd> <repo_root>
# Print an explicit branch named on the merge command line, if it resolves to a
# local branch. Empty otherwise (numbers, URLs, and flags are ignored).
_cmb_branch_from_cmd() {
  local cmd="$1" repo_root="$2"
  local merge_args tok
  # Strip everything up to and including the `merge` keyword, then scan tokens.
  merge_args=$(printf '%s' "$cmd" | sed -E 's/^.*(gh[[:space:]]+pr|glab[[:space:]]+mr)[[:space:]]+merge//')
  for tok in $merge_args; do
    case "$tok" in
      -*) continue ;;                       # flag
      *://*) continue ;;                    # URL
      '' ) continue ;;
    esac
    # Pure number → PR/MR id, not a branch.
    case "$tok" in
      *[!0-9]*) ;;                          # has a non-digit → maybe a branch
      *) continue ;;                        # all digits → id
    esac
    if git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$tok" >/dev/null 2>&1; then
      printf '%s' "$tok"
      return 0
    fi
  done
  return 0
}

# _cmb_is_protected <repo_root> <branch>
# Exit 0 when <branch> is protected: it is the repo's real default branch, or it
# is listed in the repos.protected_branches column for this repo.
_cmb_is_protected() {
  local repo_root="$1" branch="$2"
  # Never delete the repo's real default branch.
  local default_branch
  default_branch=$(tmb_repo_default_branch "$repo_root")
  [ -n "$default_branch" ] && [ "$branch" = "$default_branch" ] && return 0
  local db protected
  db=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$db" ] && [ -f "$db" ]; then
    local row
    row=$(tmb_repo_resolve "$db" "$repo_root")
    protected=$(printf '%s' "$row" | cut -d'|' -f3)
    if [ -n "$protected" ]; then
      # protected_branches is a JSON array or comma list; match the branch as a
      # whole token regardless of surrounding quotes/brackets/commas.
      local tokens
      tokens=$(printf '%s' "$protected" | sed 's/[][",]/ /g')
      local p
      for p in $tokens; do
        [ "$p" = "$branch" ] && return 0
      done
    fi
  fi
  return 1
}

# _cmb_base_branch <repo_root>
# Print the repo's base branch: repos.target_branch when set, else the repo's
# real default branch (origin/HEAD's target / the main checkout's branch).
_cmb_base_branch() {
  local repo_root="$1"
  local db
  db=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$db" ] && [ -f "$db" ]; then
    local row target
    row=$(tmb_repo_resolve "$db" "$repo_root")
    target=$(printf '%s' "$row" | cut -d'|' -f1)
    if [ -n "$target" ]; then
      printf '%s' "$target"
      return 0
    fi
  fi
  tmb_repo_default_branch "$repo_root"
}

# _cmb_integrated <repo_root> <tip> <target>
# Exit 0 when <tip>'s work is already in <target>. Twin of tipIntegratedInto in
# mcp/trajectory-server/src/tools/world_model.ts (GH 1674), cheapest first:
# ancestor; merging it into <target> is a no-op (`merge-tree --write-tree`
# yields <target>'s tree — squash/rebase merges); `git cherry` finds every
# branch commit's patch in <target>. A `[gone]` upstream is not evidence: a PR
# closed unmerged looks the same.
_cmb_integrated() {
  local repo_root="$1" tip="$2" target="$3" merged target_tree cherry
  git -C "$repo_root" merge-base --is-ancestor "$tip" "$target" 2>/dev/null && return 0
  if merged=$(git -C "$repo_root" merge-tree --write-tree "$target" "$tip" 2>/dev/null); then
    target_tree=$(git -C "$repo_root" rev-parse "$target^{tree}" 2>/dev/null) || target_tree=""
    [ -n "$target_tree" ] && [ "${merged%%$'\n'*}" = "$target_tree" ] && return 0
  fi
  cherry=$(git -C "$repo_root" cherry "$target" "$tip" 2>/dev/null) || return 1
  # Here-string, not a pipe: under pipefail, `grep -q` quitting early SIGPIPEs
  # a writer of a long list, and `!` would read that as "no + lines".
  ! grep -q '^+' <<<"$cherry"
}

# _cmb_worktree_for_branch <repo_root> <branch>
# Print the worktree path attached to <branch>, or empty. Never prints the main
# worktree (a feature branch isn't normally checked out there, but guard anyway).
_cmb_worktree_for_branch() {
  local repo_root="$1" branch="$2"
  git -C "$repo_root" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$branch" -v root="$repo_root" '
    /^worktree / { wt = substr($0, 10) }
    /^branch /   { if (substr($0, 8) == b && wt != root) { print wt; exit } }
  '
}

# Execute only when run directly; when sourced, expose helpers for tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _clean_merged_branch_main
fi
