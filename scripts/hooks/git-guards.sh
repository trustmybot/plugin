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
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

# Early-exit: skip all DB work when the command contains no git/gh word.
# This avoids ~3 sqlite3 opens on every ls/cat/echo call.
_cmd_needs_git_guard() {
  # Match 'git' or 'gh' as standalone words anywhere in the command.
  # Any non-word char may precede (handles `foo;git ...`, `echo y&&git ...`);
  # word chars before (legit) or after (github) do not match.
  printf '%s' "$1" | grep -qE '(^|[^[:alnum:]_./-])(git|gh)([[:space:]]|$)'
}
_cmd_needs_git_guard "$CMD" || exit 0

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

# Fetch all 3 config keys in ONE sqlite3 invocation to avoid repeated DB opens.
_load_config() {
  local db
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] || return 0
  tmb_have_sqlite || return 0
  sqlite3 "$db" "
    SELECT key, value_json
      FROM plugin_config
     WHERE key IN ('branching_model', 'pr_target', 'protected_branches');
  " 2>/dev/null || true
}
_config_rows=$(_load_config)

_cfg_scalar() {
  # Extract unquoted scalar for key $1 from pipe-separated rows (key|value_json).
  printf '%s\n' "$_config_rows" | awk -F'|' -v k="$1" '$1==k{print $2;exit}' \
    | sed 's/^"//;s/"$//'
}
_cfg_raw() {
  printf '%s\n' "$_config_rows" | awk -F'|' -v k="$1" '$1==k{print $2;exit}'
}

BRANCHING_MODEL=$(_cfg_scalar "branching_model")

if [ -z "$BRANCHING_MODEL" ]; then
  echo "TMB: branching_model not configured — run bro onboarding" >&2
  exit 0
fi

PR_TARGET=$(_cfg_scalar "pr_target")
PROTECTED_RAW=$(_cfg_raw "protected_branches")

if [ -z "$PR_TARGET" ] || [ -z "$PROTECTED_RAW" ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:"BLOCKED: TMB plugin_config keys pr_target or protected_branches are unset. Run bro onboarding or fix your config."}}'
  exit 0
fi

if ! printf '%s' "$PROTECTED_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:"BLOCKED: TMB plugin_config key protected_branches is malformed JSON. Fix the config or re-run bro onboarding."}}'
  exit 0
fi

PROTECTED_BRANCHES=$(printf '%s' "$PROTECTED_RAW" | jq -r '.[]' 2>/dev/null || true)

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
        jq -nc --arg r "BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${PR_TARGET}: gh pr create --base ${PR_TARGET} --head <branch>. Got --head=${HEAD_BRANCH}." \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
        exit 0
      fi
    else
      jq -nc --arg r "BLOCKED: PRs must target ${PR_TARGET} branch. Use: gh pr create --base ${PR_TARGET} --head <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
      exit 0
    fi
    ;;
esac

# --- Rule 2: No direct commits/merges/rebases to protected_branches (worktree-aware) ---
# Uses cmd_effective_branch so detached-HEAD worktrees resolve via DB lookup.
# Match the git subcommand by word boundary to avoid false-positives on plumbing
# (commit-tree, commit-graph) or "git commit" appearing inside argument text.
# Only fire when 'git' is at the start of a shell statement (after ^, &&, ||, ;, or \n).
_rule2_match() {
  local cmd="$1"
  # Match 'git <sub>' only when git is at a shell statement start:
  # after ^, or after a shell statement separator (&&, ||, ;, |).
  # Spaces around the separator are consumed to handle `cd /x && git commit`.
  printf '%s' "$cmd" | grep -qE '(^|[[:space:]]*([;&]|[|][|]|[&][&])[[:space:]]*)git[[:space:]]+(commit|merge|rebase|cherry-pick)([[:space:]]|$)'
}
if _rule2_match "$CMD"; then
    BRANCH=$(cmd_effective_branch "$CMD")
    if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
      jq -nc --arg r "BLOCKED: No direct commits to ${BRANCH}. Create a feature branch first." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
      exit 0
    fi
fi

# --- Rule 3: No force push to protected_branches ---
# Extract the push clause only (the part starting with 'git push' up to the end
# of the statement), then token-match force flags so '-f' inside a later
# compound command (e.g. `git push origin dev && rm -f x`) doesn't trigger.
_push_clause() {
  # Strip everything before 'git push'; stop at shell statement separators.
  # Use awk to split on '&&' / '||' / ';' then keep only the token containing 'git push'.
  printf '%s' "$1" | awk '
    BEGIN { RS="&&|\\|\\||;" }
    /git[[:space:]]+push/ { print; exit }
  ' | sed -nE 's/.*git[[:space:]]+push(.*)/\1/p' | head -1 || true
}
_is_force_push() {
  local clause
  clause=$(_push_clause "$1")
  # --follow-tags contains no force token; --force-with-lease is a force flag.
  printf '%s' "$clause" | grep -qE '(^|[[:space:]])(--force(-with-lease)?|-f)([[:space:]]|$)'
}
case "$CMD" in
  *"git push"*)
    if _is_force_push "$CMD"; then
      PUSH_CLAUSE=$(_push_clause "$CMD")
      if printf '%s' "$PUSH_CLAUSE" | grep -qE '\b(origin|upstream)\s+\S+'; then
        PUSH_TARGET=$(printf '%s' "$PUSH_CLAUSE" | grep -oE '\b(origin|upstream)\s+\S+' | awk '{print $2}')
        if branch_is_protected "$PUSH_TARGET"; then
          jq -nc --arg r "BLOCKED: Force push to ${PUSH_TARGET} is forbidden. This is destructive and irreversible." \
            '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
          exit 0
        fi
      else
        BRANCH=$(cmd_branch "$CMD")
        if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
          jq -nc --arg r "BLOCKED: Force push to ${BRANCH} is forbidden. This is destructive and irreversible." \
            '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
          exit 0
        fi
      fi
    fi
    ;;
esac

# --- Rule 4: New branches must be based on latest pr_target (worktree-aware) ---
case "$CMD" in
  *"git checkout -b"*|*"git switch -c"*)
    BRANCH=$(cmd_branch "$CMD")
    if [ "$BRANCH" != "$PR_TARGET" ]; then
      jq -nc --arg r "BLOCKED: New branches must be created from ${PR_TARGET}. Currently on '${BRANCH}'. Run: git checkout ${PR_TARGET} && git pull origin ${PR_TARGET} first." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
      exit 0
    fi
    # fetch/check still operate from CC's CWD — pr_target is the project's root branch concern.
    # timeout 5: portable guard against flaky networks stalling the hook.
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 fetch origin "$PR_TARGET" --quiet 2>/dev/null || true
    # Use --verify: without it, `git rev-parse origin/main` prints the literal
    # string "origin/main" when the ref doesn't exist, then exits non-zero.
    # 2>/dev/null swallows the stderr so the literal-string stdout sneaks
    # through, making LOCAL/REMOTE non-empty even for refs that don't exist.
    # The "behind origin" check then false-fires on any repo without a remote.
    LOCAL=$(git rev-parse --verify "${PR_TARGET}" 2>/dev/null || true)
    REMOTE=$(git rev-parse --verify "origin/${PR_TARGET}" 2>/dev/null || true)
    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
      jq -nc --arg r "BLOCKED: Local ${PR_TARGET} is behind origin/${PR_TARGET}. Run: git pull origin ${PR_TARGET} first." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$r}}'
      exit 0
    fi
    ;;
esac

exit 0
