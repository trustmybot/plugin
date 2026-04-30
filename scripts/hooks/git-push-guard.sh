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
#   - branches with no upstream (first push) — bro should review at issue close
#   - commits with no matching tasks row (pre-TMB or non-tracked work)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)

# Only fire for git push (not push --force; that's git-guards's job).
# Matches both `git push ...` and `git -C <path> push ...` forms.
IS_PUSH=""
IS_FORCE=""
case "$CMD" in
  *"git push"*|*"git -C "*" push"*) IS_PUSH="yes" ;;
esac
case "$CMD" in
  *"git push"*"--force"*|*"git push"*"-f "*|\
  *"git -C "*" push"*"--force"*|*"git -C "*" push"*"-f "*) IS_FORCE="yes" ;;
esac
[ "$IS_PUSH" = "yes" ] || exit 0
[ "$IS_FORCE" = "yes" ] && exit 0

# Detect "push from worktree". Pushes only happen from the main checkout
# (where bro reaped the detached commits). Any push originating from
# .claude/worktrees/ is by definition SWE attempting to push directly.
WT_CWD=""
case "$CMD" in
  *"cd "*"/.claude/worktrees/"*) WT_CWD="yes" ;;
  *"git -C "*"/.claude/worktrees/"*) WT_CWD="yes" ;;
esac
if [ -z "$WT_CWD" ] && echo "$PWD" | grep -q "/.claude/worktrees/"; then
  WT_CWD="yes"
fi

if [ "$WT_CWD" = "yes" ]; then
  REASON=$(jq -Rn '"BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`."')
  printf '{"decision":"block","reason":%s}\n' "$REASON"
  exit 0
fi

# Block any git push from SWE context (swe.md "Never push" rule enforced structurally).
# Defense-in-depth fallback: catches non-worktree SWE pushes and cases where
# CC #97 might strip the agent_type field from the payload.
if [ "$AGENT_TYPE" = "tmb:swe" ] || [ "$AGENT_TYPE" = "swe" ]; then
  REASON=$(jq -Rn '"BLOCKED: SWE must never push (swe.md). Bro handles the push gate at MR-open time. If this push was intended, the calling agent identity (.agent_type) is misconfigured."')
  printf '{"decision":"block","reason":%s}\n' "$REASON"
  exit 0
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  # No DB or no sqlite3 — TMB isn't tracking anything in this project; let push through.
  exit 0
fi

# Determine commits about to be pushed. Use upstream tracking if available.
PUSH_SHAS=$(git log '@{u}..HEAD' --pretty=%H 2>/dev/null || true)
if [ -z "$PUSH_SHAS" ]; then
  # No upstream OR no new commits — nothing to gate.
  exit 0
fi

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

# Single-line JSON for CC's hook decision protocol — but the reason needs
# multi-line content. We embed \n explicitly via jq for safe escaping.
REASON=$(jq -Rsn --arg count "$COUNT" --arg list "$LIST" '
  "BLOCKED: pushing \($count) unsigned commit(s). The following tasks lack a pr-reviewer pass verdict:\n\n\($list)\nRun: @bro review before push\n\nbro will spawn pr-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing."
')

printf '{"decision":"block","reason":%s}\n' "$REASON"
exit 0
