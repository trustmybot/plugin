#!/usr/bin/env bash
# Fixture: hook that decides a role from a path instead of the agent identity.
# Used by tests/l1-lint/no-bare-role-compare.sh --self-test (three violations).

INPUT=$(cat)

guess_role() {
  case "$PWD" in
    */.claude/worktrees/*) echo "swe" ;;
    *) echo "bro" ;;
  esac
}

SWE_CTX=$(printf '%s' "$INPUT" | jq -r '.cwd' | grep -q worktrees && echo yes)

case "$CWD" in
  */.claude/worktrees/*) AGENT_TYPE="swe" ;;
esac

[ "$(guess_role)" = "swe" ] && [ -n "$SWE_CTX" ] && [ "$AGENT_TYPE" = "swe" ] && echo "would block"
