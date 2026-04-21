#!/usr/bin/env bash
# Hook: Block bash commands that write to source code paths from the main
# conversation. Worktree paths are exempt (SWE agents work in worktrees).
#
# Customize the PROTECTED regex below to match your project's source paths.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# Allow if running from a worktree
case "$PWD" in */.claude/worktrees/*) exit 0 ;; esac
if [ -n "${CLAUDE_WORKTREE_DIR:-}" ]; then
  exit 0
fi

TOOL_CWD=$(echo "$INPUT" | jq -r '.session.worktree_path // .cwd // empty' 2>/dev/null)
case "${TOOL_CWD:-}" in */.claude/worktrees/*) exit 0 ;; esac

# ═══════════════════════════════════════════════════════════════════
# PROJECT-SPECIFIC: customize this regex to match YOUR source paths.
# Common patterns: src/, lib/, app/, tests/, web/*/src/, *.sql
# ═══════════════════════════════════════════════════════════════════
PROTECTED='src/|lib/|app/|tests/|__tests__/|spec/|\.sql$|web/.*/src/'

# Check if the command references any protected path
if ! echo "$CMD" | grep -qE "$PROTECTED"; then
  exit 0
fi

# --- Allowed commands (read-only or safe) ---

# git commands (status, log, diff, add, commit, etc.)
if echo "$CMD" | grep -qE '^git '; then
  exit 0
fi

# Read-only commands
if echo "$CMD" | grep -qE '^(grep|rg|find|ls|wc|cat|head|tail|diff|stat) '; then
  exit 0
fi

# Lint/build/test commands (read + execute, don't write source)
if echo "$CMD" | grep -qE '(bun run lint|bun run build|bun run dev|bun test|uv run ruff|uv run pytest|eslint|tsc|pytest|jest|vitest|go test|cargo test)'; then
  exit 0
fi

# uv run / bun run that are NOT writing files
if echo "$CMD" | grep -qE '^(uv run|bun run|DATABASE_URL=)' && ! echo "$CMD" | grep -qE "(open\(|> |>> |write\()"; then
  exit 0
fi

# Copying FROM worktree TO main repo (normal SWE output flow)
if echo "$CMD" | grep -qE '(cp|/bin/cp|mv|/bin/mv) ' && echo "$CMD" | grep -qE '\.claude/worktrees/'; then
  exit 0
fi

# Commands operating ON worktree paths
if echo "$CMD" | grep -qE '\.claude/worktrees/'; then
  exit 0
fi

# cd into worktree then do work
if echo "$CMD" | grep -qE 'cd .*/\.claude/worktrees/'; then
  exit 0
fi

# --- Everything else that touches protected paths is blocked ---
echo '{"decision":"block","reason":"BLOCKED: Bash write to source code path. Source edits must go through SWE agents in worktrees."}'
exit 0
