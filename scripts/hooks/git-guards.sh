#!/usr/bin/env bash
# Hook: Enforce git workflow rules driven by plugin_config branching model.
# 1. PR must target pr_target
# 2. No direct commits to protected_branches
# 3. No force push to protected_branches
# 4. New branches must be based on latest pr_target
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Determine the actual working directory the command will run in.
# SWE runs in isolated worktrees and prefixes commands with `cd <worktree> &&`.
# Without this awareness, `git branch --show-current` runs in CC's CWD (the
# project root) and always returns the root branch — blocking every legitimate
# worktree commit. The fix: parse the cd prefix and run git from there.
#
# Tries (in order):
#   1. `cd <path> && ...` prefix in the command (SWE's worktree pattern)
#   2. `--git-dir`/`-C <path>` git option in the command
#   3. CC's hook payload `cwd` field (if/when CC populates it)
#   4. Fallback: $PWD (CC's session CWD, usually the project root)
cmd_cwd() {
  local cmd="$1"
  local cd_path
  # Match leading: `cd /some/path &&` or `cd /some/path ;` or `cd /some/path\n`
  cd_path=$(echo "$cmd" | sed -nE 's|^[[:space:]]*cd[[:space:]]+("([^"]+)"\|'"'"'([^'"'"']+)'"'"'\|([^[:space:]&;]+)).*|\2\3\4|p' | head -1)
  if [ -n "$cd_path" ]; then
    echo "$cd_path"
    return
  fi
  # Try git -C <path>
  cd_path=$(echo "$cmd" | grep -oE 'git -C [^[:space:]]+' | head -1 | awk '{print $3}' | tr -d "'\"")
  if [ -n "$cd_path" ]; then
    echo "$cd_path"
    return
  fi
  # Try hook payload cwd (CC may add this in future)
  cd_path=$(echo "$INPUT" | jq -r '.cwd // empty')
  if [ -n "$cd_path" ]; then
    echo "$cd_path"
    return
  fi
  echo "$PWD"
}

# Get the current branch in the dir the command will execute in.
# This is the load-bearing fix — without it, every SWE commit sees `main`.
cmd_branch() {
  local wd
  wd=$(cmd_cwd "$1")
  if [ -d "$wd" ]; then
    (cd "$wd" 2>/dev/null && git branch --show-current 2>/dev/null) || true
  else
    git branch --show-current 2>/dev/null || true
  fi
}

# Resolve the effective branch for a command. When cmd_branch returns empty
# (detached HEAD — SWE's worktree pattern), derive the branch via DB lookup:
# slug = basename of the working directory → tasks.branch_id LIKE '%/<slug>'.
# Falls back to empty if DB is unavailable or no match — Rule 2 stays a no-op
# (status quo with the detached-HEAD blind-spot, but no false-positive blocks).
cmd_effective_branch() {
  local result
  result=$(cmd_branch "$1")
  if [ -n "$result" ]; then
    echo "$result"
    return
  fi
  local wd slug db branch_id
  wd=$(cmd_cwd "$1")
  slug=$(basename "$wd")
  db=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$db" ] && [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    branch_id=$(sqlite3 "$db" "SELECT branch_id FROM tasks WHERE branch_id LIKE '%/$slug' LIMIT 1;" 2>/dev/null || true)
    echo "$branch_id"
  fi
}

BRANCHING_MODEL=$(tmb_config_get "branching_model")

if [ -z "$BRANCHING_MODEL" ]; then
  echo "TMB: branching_model not configured — run bro onboarding" >&2
  exit 0
fi

PR_TARGET=$(tmb_config_get "pr_target")
PROTECTED_RAW=$(tmb_config_raw "protected_branches")

if [ -z "$PR_TARGET" ] || [ -z "$PROTECTED_RAW" ]; then
  echo '{"decision":"block","reason":"BLOCKED: TMB plugin_config keys pr_target or protected_branches are unset. Run bro onboarding or fix your config."}'
  exit 0
fi

if ! echo "$PROTECTED_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo '{"decision":"block","reason":"BLOCKED: TMB plugin_config key protected_branches is malformed JSON. Fix the config or re-run bro onboarding."}'
  exit 0
fi

PROTECTED_BRANCHES=$(tmb_config_array "protected_branches")

branch_is_protected() {
  local branch="$1"
  local protected_branch
  while IFS= read -r protected_branch; do
    [ "$branch" = "$protected_branch" ] && return 0
  done <<< "$PROTECTED_BRANCHES"
  return 1
}

# --- Rule 1: PR must target pr_target, with the dev → main release-merge exception ---
#
# Default: feature/* branches must PR to PR_TARGET (typically `dev` for the
# dual-tier dev/main model, or `main` for single-tier github-flow).
#
# Exception: when PR_TARGET == "dev" (dual-tier model), `dev → main` is the
# release-merge path and is allowed. The head MUST be `dev` (either
# explicit `--head dev` or the current branch is `dev` and `--head` is
# omitted). Any other head targeting main is blocked — feature branches do
# not PR directly to main.
case "$CMD" in
  *"gh pr create"*)
    if echo "$CMD" | grep -qF -- "--base ${PR_TARGET}"; then
      :  # OK — feature → pr_target (the standard path)
    elif [ "$PR_TARGET" = "dev" ] && echo "$CMD" | grep -qF -- "--base main"; then
      # Dual-tier exception: dev → main release merge.
      # `set -o pipefail` makes the assignment fail when grep finds no
      # `--head` (which is the common case — gh defaults head to the
      # current branch). The `|| true` keeps the pipeline succeeding.
      HEAD_BRANCH=$(echo "$CMD" | grep -oE -- '--head[= ][^[:space:]]+' | head -1 | sed -E 's/--head[= ]+//' | tr -d "'\"" || true)
      if [ -z "$HEAD_BRANCH" ]; then
        HEAD_BRANCH=$(git branch --show-current 2>/dev/null || true)
      fi
      if [ "$HEAD_BRANCH" != "dev" ]; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${PR_TARGET}: gh pr create --base ${PR_TARGET} --head <branch>. Got --head=${HEAD_BRANCH}.\"}"
        exit 0
      fi
    else
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: PRs must target ${PR_TARGET} branch. Use: gh pr create --base ${PR_TARGET} --head <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)\"}"
      exit 0
    fi
    ;;
esac

# --- Rule 2: No direct commits to protected_branches (worktree-aware) ---
# Uses cmd_effective_branch so detached-HEAD worktrees resolve via DB lookup.
case "$CMD" in
  *"git commit"*)
    BRANCH=$(cmd_effective_branch "$CMD")
    if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: No direct commits to ${BRANCH}. Create a feature branch first.\"}"
      exit 0
    fi
    ;;
esac

# --- Rule 3: No force push to protected_branches ---
case "$CMD" in
  *"git push"*"--force"*|*"git push"*"-f"*)
    if echo "$CMD" | grep -qE '\b(origin|upstream)\s+\S+'; then
      PUSH_TARGET=$(echo "$CMD" | grep -oE '\b(origin|upstream)\s+\S+' | awk '{print $2}')
      if branch_is_protected "$PUSH_TARGET"; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Force push to ${PUSH_TARGET} is forbidden. This is destructive and irreversible.\"}"
        exit 0
      fi
    else
      BRANCH=$(cmd_branch "$CMD")
      if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Force push to ${BRANCH} is forbidden. This is destructive and irreversible.\"}"
        exit 0
      fi
    fi
    ;;
esac

# --- Rule 4: New branches must be based on latest pr_target (worktree-aware) ---
case "$CMD" in
  *"git checkout -b"*|*"git switch -c"*)
    BRANCH=$(cmd_branch "$CMD")
    if [ "$BRANCH" != "$PR_TARGET" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: New branches must be created from ${PR_TARGET}. Currently on '${BRANCH}'. Run: git checkout ${PR_TARGET} && git pull origin ${PR_TARGET} first.\"}"
      exit 0
    fi
    # fetch/check still operate from CC's CWD — pr_target is the project's root branch concern.
    git fetch origin "$PR_TARGET" --quiet 2>/dev/null || true
    # Use --verify: without it, `git rev-parse origin/main` prints the literal
    # string "origin/main" when the ref doesn't exist, then exits non-zero.
    # 2>/dev/null swallows the stderr so the literal-string stdout sneaks
    # through, making LOCAL/REMOTE non-empty even for refs that don't exist.
    # The "behind origin" check then false-fires on any repo without a remote.
    LOCAL=$(git rev-parse --verify "${PR_TARGET}" 2>/dev/null || true)
    REMOTE=$(git rev-parse --verify "origin/${PR_TARGET}" 2>/dev/null || true)
    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Local ${PR_TARGET} is behind origin/${PR_TARGET}. Run: git pull origin ${PR_TARGET} first.\"}"
      exit 0
    fi
    ;;
esac

exit 0
