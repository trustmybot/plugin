#!/usr/bin/env bash
# SessionStart hook (#171). Ensures the project's .gitignore excludes the
# plugin's runtime dir (`.claude/`). If .gitignore doesn't exist, creates
# one. If it exists but doesn't list `.claude/`, appends. Idempotent silent
# no-op when the rule is already present.
#
# Why: the plugin writes runtime state under <project>/.claude/<plugin>/
# (trajectory.db, worktrees, etc.). If those files get committed because
# .gitignore doesn't exclude them, `git worktree add` checks them out
# inside every worktree — a stale DB copy at <worktree>/.claude/<plugin>/
# trajectory.db then poisons every hook that resolves DB path via $(pwd).
#
# Silent no-op when:
#   - not in a git repo
#   - already correctly configured

set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

GITIGNORE="$REPO_ROOT/.gitignore"

# Pattern we ensure is present. Match either `.claude/` or `.claude` line.
if [ -f "$GITIGNORE" ] && grep -qE '^\.claude/?$' "$GITIGNORE" 2>/dev/null; then
  exit 0
fi

if [ ! -f "$GITIGNORE" ]; then
  cat > "$GITIGNORE" <<'EOF'
# TMB plugin runtime state — never commit
.claude/
EOF
else
  printf '\n# TMB plugin runtime state — never commit\n.claude/\n' >> "$GITIGNORE"
fi

# Soft notify — emits to stderr so user/operator sees it once.
printf 'tmb: ensured .claude/ is in %s\n' "$GITIGNORE" >&2
