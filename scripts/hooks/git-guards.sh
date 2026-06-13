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
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

# Early-exit: skip all DB work when the command contains no git/gh word.
# This avoids ~3 sqlite3 opens on every ls/cat/echo call.
_cmd_needs_git_guard() {
  # Match 'git', 'gh', or 'glab' as standalone words anywhere in the command.
  # Any non-word char may precede (handles `foo;git ...`, `echo y&&git ...`);
  # word chars before (legit) or after (github/glabber) do not match.
  printf '%s' "$1" | grep -qE '(^|[^[:alnum:]_./-])(git|gh|glab)([[:space:]]|$)'
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
  local wd slug slug_sql db branch_id
  wd=$(cmd_cwd "$1")
  slug=$(basename "$wd")
  slug_sql=$(tmb_sql_quote "$slug")
  db=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$db" ] && [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    branch_id=$(sqlite3 "$db" "SELECT branch_id FROM tasks WHERE branch_id LIKE '%/${slug_sql}' LIMIT 1;" 2>/dev/null || true)
    echo "$branch_id"
  fi
}

# --- Per-repo config resolution ---
# Resolve the effective branching config from the repos row for the git
# toplevel of the command's working directory, falling back to global
# plugin_config for legacy single-repo installs.
# If the cwd's git root is not a registered TMB repo, guard no-ops (exit 0).
_CMD_CWD=$(cmd_cwd "$CMD")
_GIT_ROOT=$(tmb_repo_git_root "$_CMD_CWD")
_DB=$(tmb_db_path 2>/dev/null || true)

if [ -n "$_DB" ] && [ -f "$_DB" ] && tmb_have_sqlite && [ -n "$_GIT_ROOT" ]; then
  if ! tmb_repo_is_registered "$_DB" "$_GIT_ROOT"; then
    exit 0
  fi
  _REPO_ROW=$(tmb_repo_resolve "$_DB" "$_GIT_ROOT")
  _REPO_TARGET=$(printf '%s' "$_REPO_ROW" | cut -d'|' -f1)
  _REPO_MODEL=$(printf '%s' "$_REPO_ROW" | cut -d'|' -f2)
  _REPO_PROTECTED=$(printf '%s' "$_REPO_ROW" | cut -d'|' -f3)
else
  _REPO_TARGET=""
  _REPO_MODEL=""
  _REPO_PROTECTED=""
fi

# Fetch global config as fallback for repos rows that lack per-repo values.
_load_global_config() {
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
_global_config_rows=$(_load_global_config)

_gcfg_scalar() {
  printf '%s\n' "$_global_config_rows" | awk -F'|' -v k="$1" '$1==k{print $2;exit}' \
    | sed 's/^"//;s/"$//'
}
_gcfg_raw() {
  printf '%s\n' "$_global_config_rows" | awk -F'|' -v k="$1" '$1==k{print $2;exit}'
}

# Effective values: per-repo wins, global is fallback.
if [ -n "$_REPO_MODEL" ]; then
  BRANCHING_MODEL="$_REPO_MODEL"
else
  BRANCHING_MODEL=$(_gcfg_scalar "branching_model")
fi

if [ -z "$BRANCHING_MODEL" ]; then
  echo "TMB: branching_model not configured — run bro onboarding" >&2
  exit 0
fi

if [ -n "$_REPO_TARGET" ]; then
  PR_TARGET="$_REPO_TARGET"
else
  PR_TARGET=$(_gcfg_scalar "pr_target")
fi

if [ -n "$_REPO_PROTECTED" ]; then
  PROTECTED_RAW="$_REPO_PROTECTED"
else
  PROTECTED_RAW=$(_gcfg_raw "protected_branches")
fi

if [ -z "$PR_TARGET" ] || [ -z "$PROTECTED_RAW" ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"BLOCKED: TMB plugin_config keys pr_target or protected_branches are unset. Run bro onboarding or fix your config."}}'
  exit 0
fi

if ! printf '%s' "$PROTECTED_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"BLOCKED: TMB plugin_config key protected_branches is malformed JSON. Fix the config or re-run bro onboarding."}}'
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
# explicit `--head dev` / --source-branch dev or the current branch is `dev`
# and the flag is omitted). Any other head targeting main is blocked — feature
# branches do not PR directly to main.
#
# Uses an anchored _rule1_match (mirroring _rule2_match's boundary class) so
# the trigger phrase inside quoted argument text does NOT fire.
_rule1_match() {
  local cmd="$1"
  # Return which forge tool's PR/MR-create command is present at a statement
  # boundary (start of string, or after ; && || | with optional spaces).
  # Exits 0 with "gh" or "glab" printed; exits 1 when neither matches.
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]]*([;&]|[|][|]|[&][&])[[:space:]]*)gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
    echo "gh"; return 0
  fi
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]]*([;&]|[|][|]|[&][&])[[:space:]]*)glab[[:space:]]+mr[[:space:]]+create([[:space:]]|$)'; then
    echo "glab"; return 0
  fi
  return 1
}

_RULE1_FORGE=$(_rule1_match "$CMD" || true)
if [ -n "$_RULE1_FORGE" ]; then
  if [ "$_RULE1_FORGE" = "gh" ]; then
    # --- gh pr create ---
    if echo "$CMD" | grep -qF -- "--base ${PR_TARGET}"; then
      :  # OK — feature → pr_target (the standard path)
    elif [ "$PR_TARGET" = "dev" ] && echo "$CMD" | grep -qF -- "--base main"; then
      # Dual-tier exception: dev → main release merge.
      HEAD_BRANCH=$(echo "$CMD" | grep -oE -- '--head[= ][^[:space:]]+' | head -1 | sed -E 's/--head[= ]+//' | tr -d "'\"" || true)
      if [ -z "$HEAD_BRANCH" ]; then
        HEAD_BRANCH=$(git branch --show-current 2>/dev/null || true)
      fi
      if [ "$HEAD_BRANCH" != "dev" ]; then
        jq -nc --arg r "BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${PR_TARGET}: gh pr create --base ${PR_TARGET} --head <branch>. Got --head=${HEAD_BRANCH}." \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
        exit 0
      fi
    else
      jq -nc --arg r "BLOCKED: PRs must target ${PR_TARGET} branch. Use: gh pr create --base ${PR_TARGET} --head <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
  else
    # --- glab mr create ---
    # Target flag: --target-branch <b> or -b <b> (or --target-branch=<b>)
    TARGET_BRANCH=$(echo "$CMD" | grep -oE -- '--target-branch[= ][^[:space:]]+' | head -1 | sed -E 's/--target-branch[= ]+//' | tr -d "'\"" || true)
    if [ -z "$TARGET_BRANCH" ]; then
      TARGET_BRANCH=$(echo "$CMD" | grep -oE -- '-b[= ][^[:space:]]+' | head -1 | sed -E 's/-b[= ]+//' | tr -d "'\"" || true)
    fi
    # Head/source flag: --source-branch <b> or -s <b>
    SOURCE_BRANCH=$(echo "$CMD" | grep -oE -- '--source-branch[= ][^[:space:]]+' | head -1 | sed -E 's/--source-branch[= ]+//' | tr -d "'\"" || true)
    if [ -z "$SOURCE_BRANCH" ]; then
      SOURCE_BRANCH=$(echo "$CMD" | grep -oE -- '-s[= ][^[:space:]]+' | head -1 | sed -E 's/-s[= ]+//' | tr -d "'\"" || true)
    fi
    if [ -z "$SOURCE_BRANCH" ]; then
      SOURCE_BRANCH=$(git branch --show-current 2>/dev/null || true)
    fi

    if [ "$TARGET_BRANCH" = "$PR_TARGET" ]; then
      :  # OK — feature → pr_target (the standard path)
    elif [ "$PR_TARGET" = "dev" ] && [ "$TARGET_BRANCH" = "main" ]; then
      # Dual-tier exception: dev → main release merge.
      if [ "$SOURCE_BRANCH" != "dev" ]; then
        jq -nc --arg r "BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must MR to ${PR_TARGET}: glab mr create --target-branch ${PR_TARGET} --source-branch <branch>. Got --source-branch=${SOURCE_BRANCH}." \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
        exit 0
      fi
    else
      jq -nc --arg r "BLOCKED: MRs must target ${PR_TARGET} branch. Use: glab mr create --target-branch ${PR_TARGET} --source-branch <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
  fi
fi

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
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
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
            '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
          exit 0
        fi
      else
        BRANCH=$(cmd_branch "$CMD")
        if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
          jq -nc --arg r "BLOCKED: Force push to ${BRANCH} is forbidden. This is destructive and irreversible." \
            '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
          exit 0
        fi
      fi
    fi
    ;;
esac

# --- Rule 4: New branches must be based on latest pr_target (worktree-aware) ---
# Remote freshness check is skipped when the repo has no origin remote or
# origin/<pr_target> does not exist — avoids false blocks on offline/local repos.
case "$CMD" in
  *"git checkout -b"*|*"git switch -c"*)
    BRANCH=$(cmd_effective_branch "$CMD")
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "$PR_TARGET" ]; then
      jq -nc --arg r "BLOCKED: New branches must be created from ${PR_TARGET}. Currently on '${BRANCH}'. Run: git checkout ${PR_TARGET} && git pull origin ${PR_TARGET} first." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
    # Detached HEAD (BRANCH empty): guide to checkout -B rather than hard-deny.
    if [ -z "$BRANCH" ]; then
      jq -nc --arg r "BLOCKED: Detached HEAD detected. Run: git checkout -B ${PR_TARGET} origin/${PR_TARGET} to reattach, then create your feature branch." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
    # Skip remote freshness check when repo has no origin remote configured.
    _HAS_REMOTE=$(git -C "$_CMD_CWD" remote get-url origin 2>/dev/null || true)
    if [ -z "$_HAS_REMOTE" ]; then
      exit 0
    fi
    # timeout 5: portable guard against flaky networks stalling the hook.
    git -C "$_CMD_CWD" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 fetch origin "$PR_TARGET" --quiet 2>/dev/null || true
    # Use --verify: without it, `git rev-parse origin/main` prints the literal
    # string "origin/main" when the ref doesn't exist, then exits non-zero.
    # 2>/dev/null swallows the stderr so the literal-string stdout sneaks
    # through, making LOCAL/REMOTE non-empty even for refs that don't exist.
    # The "behind origin" check then false-fires on any repo without a remote.
    LOCAL=$(git -C "$_CMD_CWD" rev-parse --verify "${PR_TARGET}" 2>/dev/null || true)
    REMOTE=$(git -C "$_CMD_CWD" rev-parse --verify "origin/${PR_TARGET}" 2>/dev/null || true)
    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
      jq -nc --arg r "BLOCKED: Local ${PR_TARGET} is behind origin/${PR_TARGET}. Run: git pull origin ${PR_TARGET} first." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
    ;;
esac

exit 0
