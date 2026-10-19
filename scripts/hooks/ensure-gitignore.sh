#!/usr/bin/env bash
# SessionStart hook (#171). Ensures the .gitignore of each git repo TMB works
# in excludes the plugin's runtime dir (`.claude/`): the project's own repo
# and, when the trajectory DB reads, every registered `repos` row's repo. If
# .gitignore doesn't exist, creates one. If it exists but doesn't list
# `.claude/`, appends. Idempotent silent no-op when the rule is already
# present.
#
# Why: the plugin writes runtime state under <project>/.claude/<plugin>/
# (the trajectory DB) and worktrees under <repos.path>/.claude/worktrees/. If
# those files get committed because .gitignore doesn't exclude them, `git
# worktree add` checks them out inside every worktree as a stale DB copy.
#
# The repos come from the project (tmb_project_root: the project holding the
# resolved DB, else CLAUDE_PROJECT_DIR) and the repos table, never from the
# session's cwd (GH 1550).
#
# Silent no-op when:
#   - no project resolves, or none of its dirs is in a git repo
#   - already correctly configured

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"

PROJECT=$(tmb_project_root)
[ -n "$PROJECT" ] || exit 0

DIRS=("$PROJECT")
DB=$(tmb_db_path 2>/dev/null) || DB=""
if [ -n "$DB" ] && [ -f "$DB" ] && tmb_have_sqlite; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    DIRS+=("$(tmb_repo_path_abs "$DB" "$p")")
  done < <(tmb_sqlite_ro "$DB" "SELECT path FROM repos WHERE path IS NOT NULL AND path <> '';")
fi

# ensure_ignored <repo_root>
ensure_ignored() {
  local gitignore="$1/.gitignore"
  # Pattern we ensure is present. Match `.claude`, `.claude/`, or `.claude/*`.
  if [ -f "$gitignore" ] && grep -qE '^\.claude(/\*?)?$' "$gitignore" 2>/dev/null; then
    return 0
  fi
  if [ ! -f "$gitignore" ]; then
    printf '# TMB plugin runtime state — never commit\n.claude/\n' > "$gitignore"
  else
    printf '\n# TMB plugin runtime state — never commit\n.claude/\n' >> "$gitignore"
  fi
  # Soft notify — emits to stderr so user/operator sees it once.
  printf 'tmb: ensured .claude/ is in %s\n' "$gitignore" >&2
}

SEEN=$'\n'
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  root=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || continue
  [ -n "$root" ] || continue
  case "$SEEN" in *$'\n'"$root"$'\n'*) continue ;; esac
  SEEN="${SEEN}${root}"$'\n'
  ensure_ignored "$root"
done
exit 0
