#!/usr/bin/env bash
# Keeps prompts independent of the session working directory.
# A subagent inherits bro's cwd and bro's cwd can sit in a subdir or a worktree,
# so a prompt names every project path and every branch-moving git command explicitly.
#
# Flags, in agents/*.md, commands/*.md and every *.md under skills/*/:
#   - a relative `.claude/` path: one not preceded by `<placeholder>/` (such as
#     `<project>/`, `<repo path>/`, `<worktree_path>/`), `~/` or `$HOME/`
#   - `git push`, `git switch`, `git checkout` or `git pull` with no `-C <dir>`
#
# Usage: bash tests/l1-lint/prompt-explicit-paths.sh [plugin-root]
# Exit 1 on any finding.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$HERE/../.." && pwd)}"

ANCHORED_CLAUDE='(<[^<>]+>|~|\$HOME|\$\{HOME\})/\.claude/'
BARE_GIT='(^|[^[:alnum:]_-])git[[:space:]]+(push|switch|checkout|pull)([^[:alnum:]_-]|$)'

FAIL=0

lint_file() {
  local f="$1" rel line
  rel="${f#"$ROOT/"}"
  while IFS= read -r line; do
    printf '%s:%s: relative .claude/ path — anchor it as <project>/.claude/...\n' "$rel" "${line%%:*}"
    FAIL=1
  done < <(grep -n '\.claude/' "$f" | sed -E "s#${ANCHORED_CLAUDE}##g" | grep '\.claude/')
  while IFS= read -r line; do
    printf '%s:%s: git command without -C — use git -C <repo path> ...\n' "$rel" "${line%%:*}"
    FAIL=1
  done < <(grep -nE "$BARE_GIT" "$f")
}

while IFS= read -r -d '' f; do
  lint_file "$f"
done < <(
  for d in agents commands; do
    [ -d "$ROOT/$d" ] && find "$ROOT/$d" -maxdepth 1 -name '*.md' -print0
  done
  [ -d "$ROOT/skills" ] && find "$ROOT/skills" -mindepth 2 -name '*.md' -print0
)

if [ "$FAIL" -ne 0 ]; then
  printf '\nprompt-explicit-paths: FAIL\n' >&2
  exit 1
fi

printf 'prompt-explicit-paths: PASS\n'
