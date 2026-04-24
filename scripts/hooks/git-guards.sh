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

# --- Rule 1: PR must target pr_target ---
case "$CMD" in
  *"gh pr create"*)
    if ! echo "$CMD" | grep -qF -- "--base ${PR_TARGET}"; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: PRs must target ${PR_TARGET} branch. Use: gh pr create --base ${PR_TARGET}\"}"
      exit 0
    fi
    ;;
esac

# --- Rule 2: No direct commits to protected_branches ---
case "$CMD" in
  *"git commit"*)
    BRANCH=$(git branch --show-current 2>/dev/null || true)
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
      BRANCH=$(git branch --show-current 2>/dev/null || true)
      if [ -n "$BRANCH" ] && branch_is_protected "$BRANCH"; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Force push to ${BRANCH} is forbidden. This is destructive and irreversible.\"}"
        exit 0
      fi
    fi
    ;;
esac

# --- Rule 4: New branches must be based on latest pr_target ---
case "$CMD" in
  *"git checkout -b"*|*"git switch -c"*)
    BRANCH=$(git branch --show-current 2>/dev/null || true)
    if [ "$BRANCH" != "$PR_TARGET" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: New branches must be created from ${PR_TARGET}. Currently on '${BRANCH}'. Run: git checkout ${PR_TARGET} && git pull origin ${PR_TARGET} first.\"}"
      exit 0
    fi
    git fetch origin "$PR_TARGET" --quiet 2>/dev/null || true
    LOCAL=$(git rev-parse "$PR_TARGET" 2>/dev/null || true)
    REMOTE=$(git rev-parse "origin/${PR_TARGET}" 2>/dev/null || true)
    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Local ${PR_TARGET} is behind origin/${PR_TARGET}. Run: git pull origin ${PR_TARGET} first.\"}"
      exit 0
    fi
    ;;
esac

exit 0
