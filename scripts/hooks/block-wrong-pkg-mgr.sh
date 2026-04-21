#!/usr/bin/env bash
# Hook: Block wrong package managers. Use uv for Python, bun for TypeScript.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Block pip install (allow pip as substring in other contexts)
if echo "$CMD" | grep -qE '\bpip install\b|\bpip3 install\b'; then
  echo '{"decision":"block","reason":"BLOCKED: Use uv, not pip. Example: uv add <package>"}'
  exit 0
fi

# Block npm, yarn, pnpm (but not as substrings in paths/URLs)
if echo "$CMD" | grep -qE '^\s*(npm|yarn|pnpm)\b|\|\s*(npm|yarn|pnpm)\b|&&\s*(npm|yarn|pnpm)\b|;\s*(npm|yarn|pnpm)\b'; then
  echo '{"decision":"block","reason":"BLOCKED: Use bun, not npm/yarn/pnpm. Example: bun add <package>"}'
  exit 0
fi

exit 0
