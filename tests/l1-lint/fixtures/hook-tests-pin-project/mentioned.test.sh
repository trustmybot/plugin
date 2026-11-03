#!/usr/bin/env bash
# Pin with CLAUDE_PROJECT_DIR="$PROJECT" before the call (not done here).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unset CLAUDE_PROJECT_DIR TRAJECTORY_DB_PATH
echo '{}' | node "$HERE/../../../../mcp/trajectory-server/dist/hooks.js" PreToolUse
