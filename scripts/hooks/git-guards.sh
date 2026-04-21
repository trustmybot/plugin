#!/usr/bin/env bash
# Hook: Enforce git workflow rules.
# 1. PR must target dev (not main)
# 2. No direct commits to dev or main
# 3. No force push to main
# 4. New branches must be based on latest dev
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# --- Rule 1: PR must target dev ---
case "$CMD" in
  *"gh pr create"*)
    if ! echo "$CMD" | grep -q '\-\-base dev'; then
      echo '{"decision":"block","reason":"BLOCKED: PRs must target dev branch. Use: gh pr create --base dev"}'
      exit 0
    fi
    ;;
esac

# --- Rule 2: No direct commits to dev or main ---
case "$CMD" in
  *"git commit"*)
    BRANCH=$(git branch --show-current 2>/dev/null || true)
    if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] || [ "$BRANCH" = "dev" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: No direct commits to $BRANCH. Create a feature branch first.\"}"
      exit 0
    fi
    ;;
esac

# --- Rule 3: No force push to main ---
case "$CMD" in
  *"git push"*"--force"*|*"git push"*"-f"*)
    if echo "$CMD" | grep -qE '\b(main|master)\b'; then
      echo '{"decision":"block","reason":"BLOCKED: Force push to main/master is forbidden. This is destructive and irreversible."}'
      exit 0
    fi
    # If no branch specified, check current branch
    if ! echo "$CMD" | grep -qE '\b(origin|upstream)\s+\S+'; then
      BRANCH=$(git branch --show-current 2>/dev/null || true)
      if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
        echo '{"decision":"block","reason":"BLOCKED: Force push to main/master is forbidden. This is destructive and irreversible."}'
        exit 0
      fi
    fi
    ;;
esac

# --- Rule 4: New branches must be based on latest dev ---
case "$CMD" in
  *"git checkout -b"*|*"git switch -c"*)
    BRANCH=$(git branch --show-current 2>/dev/null || true)
    if [ "$BRANCH" != "dev" ]; then
      echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: New branches must be created from dev. Currently on '$BRANCH'. Run: git checkout dev && git pull origin dev first.\"}"
      exit 0
    fi
    # Check if dev is up to date with origin
    git fetch origin dev --quiet 2>/dev/null || true
    LOCAL=$(git rev-parse dev 2>/dev/null || true)
    REMOTE=$(git rev-parse origin/dev 2>/dev/null || true)
    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
      echo '{"decision":"block","reason":"BLOCKED: Local dev is behind origin/dev. Run: git pull origin dev first."}'
      exit 0
    fi
    ;;
esac

exit 0
