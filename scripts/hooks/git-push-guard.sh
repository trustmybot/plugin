#!/usr/bin/env bash
# Hook: Block `git push` when the commits being pushed include closed tasks
# that lack a passing pr-reviewer verdict in the trajectory DB.
#
# Doctrine: bro is the task gate (closes tasks atomically after SWE).
# pr-reviewer is the push gate — runs only when commits are about to ship.
# This hook enforces that doctrine at the Bash boundary.
#
# Skips:
#   - `git push --force` / `-f` (handled by git-guards.sh — destructive ops)
#   - commits with no matching tasks row (pre-TMB or non-tracked work)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")

# Only fire for git push (not push --force; that's git-guards's job).
# Matches both `git push ...` and `git -C <path> push ...` forms.
IS_PUSH=""
IS_FORCE=""
case "$CMD" in
  "git push"*|"git -C "*" push"*) IS_PUSH="yes" ;;
  *"; git push"*|*"&& git push"*|*"|| git push"*|*"| git push"*) IS_PUSH="yes" ;;
  *"; git -C "*" push"*|*"&& git -C "*" push"*|*"|| git -C "*" push"*) IS_PUSH="yes" ;;
esac
case "$CMD" in
  "git push"*"--force"*|"git push"*"-f "*) IS_FORCE="yes" ;;
  "git -C "*" push"*"--force"*|"git -C "*" push"*"-f "*) IS_FORCE="yes" ;;
  *"; git push"*"--force"*|*"&& git push"*"--force"*|*"|| git push"*"--force"*) IS_FORCE="yes" ;;
  *"; git push"*"-f "*|*"&& git push"*"-f "*|*"|| git push"*"-f "*) IS_FORCE="yes" ;;
  *"; git -C "*" push"*"--force"*|*"&& git -C "*" push"*"--force"*|*"|| git -C "*" push"*"--force"*) IS_FORCE="yes" ;;
  *"; git -C "*" push"*"-f "*|*"&& git -C "*" push"*"-f "*|*"|| git -C "*" push"*"-f "*) IS_FORCE="yes" ;;
esac
[ "$IS_PUSH" = "yes" ] || exit 0
[ "$IS_FORCE" = "yes" ] && exit 0

# Detect "push from worktree". Pushes only happen from the main checkout
# (where bro reaped the detached commits). Any push originating from
# .claude/worktrees/ is by definition SWE attempting to push directly.
#
# Three signals, in priority order:
#   1. The command itself does `git -C <worktree-path> push` — explicit.
#   2. The command starts with `cd <path> && ...` — trust the cd target;
#      $PWD is stale (PreToolUse hooks fire BEFORE the embedded cd runs).
#   3. Fall back to $PWD when neither (1) nor (2) match.
WT_CWD=""
CD_OVERRIDE=""
CD_TARGET=""

# Signal 1: explicit `git -C <path> ... push`.
# Also extract the -C path for later use in git log calls (#368).
case "$CMD" in
  *"git -C "*" push"*)
    GIT_C_PATH=$(printf '%s' "$CMD" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+).*/\1/p')
    if [ -n "$GIT_C_PATH" ]; then
      CD_TARGET="$GIT_C_PATH"
      case "$GIT_C_PATH" in
        *"/.claude/worktrees/"*) WT_CWD="yes" ;;
      esac
    fi
    ;;
esac

# Signal 2: leading `cd <path> && ...` overrides $PWD.
#   Match shapes: `cd /abs/path && git push`, `cd ./rel && git push`,
#                 `cd /p ; git push`, etc.
#   Don't match: `git push && cd /elsewhere` (post-push cd is not relevant).
if [ -z "$WT_CWD" ]; then
  case "$CMD" in
    "cd "*"&&"*"git push"*|"cd "*";"*"git push"*)
      CD_TARGET=$(printf '%s' "$CMD" | sed -nE 's/^cd[[:space:]]+([^[:space:]&;]+).*/\1/p')
      if [ -n "$CD_TARGET" ]; then
        CD_OVERRIDE="yes"
        case "$CD_TARGET" in
          *"/.claude/worktrees/"*) WT_CWD="yes" ;;
        esac
      fi
      ;;
  esac
fi

# Signal 3: $PWD fallback (only when neither cd nor git -C in command).
if [ -z "$WT_CWD" ] && [ -z "$CD_OVERRIDE" ] && \
   ! echo "$CMD" | grep -q 'git -C ' && \
   echo "$PWD" | grep -q "/.claude/worktrees/"; then
  WT_CWD="yes"
fi

if [ "$WT_CWD" = "yes" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`."}}'
  exit 0
fi

# Block any git push from SWE context (enforced structurally by this gate).
# Defense-in-depth fallback: catches non-worktree SWE pushes and cases where
# CC #97 might strip the agent_type field from the payload.
if [ "$AGENT_TYPE" = "swe" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
  exit 0
fi

# Block any git push from pr-reviewer context.
# pr-reviewer renders a verdict row; the push decision belongs to bro
# after that verdict — pr-reviewer itself must never initiate a push.
if [ "$AGENT_TYPE" = "pr-reviewer" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: pr-reviewer must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed."}}'
  exit 0
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  # No DB or no sqlite3 — TMB isn't tracking anything in this project; let push through.
  exit 0
fi

# Determine the git directory to run log/config commands in.
# Reuse the parsed cd/-C target dir already resolved above (#368): when the
# command is `cd /other/repo && git push`, $PWD is stale (PreToolUse fires
# before the cd runs). Running bare `git log` from $PWD would compute the
# wrong SHA set — a false block or false allow of the pr-reviewer gate.
GIT_DIR_ARGS=""
if [ -n "$CD_TARGET" ]; then
  GIT_DIR_ARGS="-C $CD_TARGET"
fi

# Determine commits about to be pushed. Use upstream tracking if available.
# shellcheck disable=SC2086
PUSH_SHAS=$(git ${GIT_DIR_ARGS} log '@{u}..HEAD' --pretty=%H 2>/dev/null || true)
if [ -z "$PUSH_SHAS" ]; then
  # No upstream — first push of new branch. Compute commits unique to this
  # branch vs the per-repo target_branch (repos table is the sole source).
  _PUSH_GIT_ROOT=$(tmb_repo_git_root "${CD_TARGET:-$PWD}")
  _PUSH_REPO_ROW=$(tmb_repo_resolve "$DB" "$_PUSH_GIT_ROOT")
  PR_TARGET=$(printf '%s' "$_PUSH_REPO_ROW" | cut -d'|' -f1)
  PR_TARGET="${PR_TARGET:-dev}"
  # shellcheck disable=SC2086
  PUSH_SHAS=$(git ${GIT_DIR_ARGS} log "origin/${PR_TARGET}..HEAD" --pretty=%H 2>/dev/null || true)
fi
[ -z "$PUSH_SHAS" ] && exit 0

# Build a SQL IN clause from the SHA list.
SHA_LIST=""
while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  if [ -z "$SHA_LIST" ]; then
    SHA_LIST="'$sha'"
  else
    SHA_LIST="$SHA_LIST,'$sha'"
  fi
done <<< "$PUSH_SHAS"

if [ -z "$SHA_LIST" ]; then
  exit 0
fi

# Find tasks whose commit_sha is in the push set AND lack a passing validation row.
UNSIGNED=$(sqlite3 "$DB" "
  SELECT t.id || '|' || t.branch_id || '|' || substr(t.title, 1, 60)
    FROM tasks t
   WHERE t.commit_sha IN ($SHA_LIST)
     AND NOT EXISTS (
       SELECT 1 FROM validation_attempts v
        WHERE v.task_id = t.id
          AND v.verdict = 'pass'
     );
" 2>/dev/null || true)

if [ -z "$UNSIGNED" ]; then
  # All commits in the push are either (a) reviewed or (b) untracked by TMB. Allow.
  exit 0
fi

# Build the block message.
COUNT=$(echo "$UNSIGNED" | wc -l | tr -d ' ')
LIST=$(echo "$UNSIGNED" | awk -F'|' '{ printf "  - task_id=%s  %s  (%s)\n", $1, $2, $3 }')
DENY_REASON="BLOCKED: pushing ${COUNT} unsigned commit(s). The following tasks lack a pr-reviewer pass verdict:

${LIST}
Run: @bro review before push

bro will spawn pr-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing."

jq -nc --arg reason "$DENY_REASON" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$reason}}'
exit 0
