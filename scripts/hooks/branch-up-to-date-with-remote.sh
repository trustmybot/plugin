#!/usr/bin/env bash
# PreToolUse hook (#170 part 2): when SWE attaches a worktree to a branch,
# verify the branch is up-to-date with the latest remote `pr_target`. Catches
# the "branch was created from stale local main" failure mode — common when
# the user hasn't fetched origin in a while and bro creates a task branch
# from a behind-by-N-commits local pointer.
#
# Behavior:
#   1. Match `git worktree add <path> <branch>` invocations (skip everything
#      else).
#   2. Best-effort `git fetch origin <pr_target>` (silent — offline is fine).
#   3. If `origin/<pr_target>` is NOT an ancestor of `<branch>`, deny with a
#      helpful message: bro must rebase / recreate the branch from the
#      latest origin/<pr_target> before SWE attaches a worktree.
#
# Allow conditions:
#   - Not a worktree-add command
#   - Not a TMB project (no DB)
#   - User explicitly named a non-pr_target base in the spec (e.g.
#     branching from a feature branch — recorded in tasks.parent_branch_id;
#     hook honors this when present)
#   - Bypass: TMB_ALLOW_STALE_BRANCH=1 (offline / disconnected work)
#
# pr_target read from the repos table (defaults to "main").

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

if [ "${TMB_ALLOW_STALE_BRANCH:-0}" = "1" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$CMD" ] || exit 0

case "$CMD" in
  *worktree*) ;;
  *) exit 0 ;;
esac

# The first `git [-C <p>] worktree add` statement of the command's executable
# skeleton (lib/cmd-analysis.sh); one named in quoted text or a heredoc is data.
CWD=$(tmb_payload_cwd "$INPUT")
WT_DIR=""
WT_SUB=""
while IFS="$(printf '\t')" read -r dir stmt; do
  sub=$(tmb_git_subcommand "$stmt")
  case "$sub" in "worktree add "*) WT_DIR="$dir"; WT_SUB="$sub"; break ;; esac
done < <(tmb_cmd_statements "$CMD" "$CWD")
[ -n "$WT_SUB" ] || exit 0

# Skip if -b/-B/--create-branch present — the branch-create-block hook owns
# that case. We only validate when SWE is attaching to an existing branch.
case " $WT_SUB " in
  *" -b "*|*" -B "*|*" --create-branch "*) exit 0 ;;
esac

# The trailing branch arg. Form: `git worktree add [opts] <path> <branch>`.
BRANCH="${WT_SUB##* }"
[ -n "$BRANCH" ] || exit 0

# The repo of the statement's effective dir — in a multi-repo workspace $PWD
# is the non-repo workspace root; every linked worktree shares one repo.
REPO_ROOT=$(tmb_stmt_repo_root "$WT_DIR" "$CWD")
[ -n "$REPO_ROOT" ] || exit 0
DB_PATH=$(tmb_db_path) || exit 0
tmb_have_sqlite || exit 0

# One read: the repos row for REPO_ROOT. No row = unregistered/sibling repo —
# don't impose policy on it (#549). A read error fails closed.
SAFE_REPO_ROOT=$(tmb_sql_quote "$REPO_ROOT")
_REPO_ROW=$(tmb_gate_read "$DB_PATH" \
  "SELECT 'repo|' || COALESCE(target_branch, '') FROM repos WHERE path = '${SAFE_REPO_ROOT}' LIMIT 1;")
if [ "$_REPO_ROW" = "__ERR__" ]; then
  tmb_deny_db_unavailable branch-up-to-date-with-remote
  exit 0
fi
[ -n "$_REPO_ROW" ] || exit 0

# Per-repo target_branch from the repos table (the sole source).
PR_TARGET="${_REPO_ROW#repo|}"
[ -n "$PR_TARGET" ] || PR_TARGET="main"

if ! git -C "$REPO_ROOT" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  exit 0
fi

# Skip remote freshness check when repo has no origin remote (#546).
_HAS_REMOTE=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)
if [ -z "$_HAS_REMOTE" ]; then
  exit 0
fi

git -C "$REPO_ROOT" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 fetch origin "$PR_TARGET" --quiet >/dev/null 2>&1 || true

if ! git -C "$REPO_ROOT" rev-parse --verify "origin/$PR_TARGET" >/dev/null 2>&1; then
  exit 0
fi

if git -C "$REPO_ROOT" merge-base --is-ancestor "origin/$PR_TARGET" "$BRANCH" 2>/dev/null; then
  exit 0
fi

BEHIND=$(git -C "$REPO_ROOT" rev-list --count "$BRANCH..origin/$PR_TARGET" 2>/dev/null || echo "?")
REASON="BLOCKED: branch '$BRANCH' is behind origin/$PR_TARGET by $BEHIND commit(s). bro must rebase the task branch onto the latest origin/$PR_TARGET (or recreate it: \`git branch -D $BRANCH && git fetch origin $PR_TARGET && git branch $BRANCH origin/$PR_TARGET\`) before SWE attaches a worktree. This catches stale-local-main bugs where the worktree starts from yesterday's commit and conflicts on push. Bypass: TMB_ALLOW_STALE_BRANCH=1 (e.g. offline work)."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
