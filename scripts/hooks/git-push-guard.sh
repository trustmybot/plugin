#!/usr/bin/env bash
# Hook: Block `git push` when the commits being pushed include closed tasks
# that lack a passing pr-reviewer verdict in the trajectory DB.
#
# Doctrine: bro is the task gate (closes tasks atomically after SWE).
# pr-reviewer is the push gate — runs only when commits are about to ship.
# This hook enforces that doctrine at the Bash boundary.
#
# A push is a `git [-C <p>] push` statement of the command's executable
# skeleton (lib/cmd-analysis.sh): pushes named inside heredocs, quoted text,
# grep patterns or commit messages are data. Each push is judged in its
# effective dir (git -C, else a preceding cd, else the payload cwd when it
# belongs to one checkout); a push whose dir is ambiguous or unresolvable is
# denied with ambiguous_git_target. The role comes from the agent identity
# only (tmb_agent_role).
#
# Skips:
#   - `git push --force` / `-f` (handled by git-guards.sh — destructive ops)
#   - commits with no matching tasks row (pre-TMB or non-tracked work)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
printf '%s' "$CMD" | grep -qE 'push' || exit 0

CWD=$(tmb_payload_cwd "$INPUT")
PUSHES=""
while IFS="$(printf '\t')" read -r dir stmt; do
  sub=$(tmb_git_subcommand "$stmt")
  case "$sub" in push|"push "*) ;; *) continue ;; esac
  case " ${sub} " in
    *" --force "*|*" -f "*|*" --force-with-lease "*|*" --force-with-lease="*) continue ;;
  esac
  PUSHES="${PUSHES}${dir}$(printf '\t')${stmt}
"
done < <(tmb_cmd_statements "$CMD" "$CWD")
[ -n "$PUSHES" ] || exit 0

ROLE=$(tmb_agent_role "$INPUT")
if [ "$ROLE" = "swe" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
  exit 0
fi
# pr-reviewer renders a verdict row; the push decision belongs to bro after
# that verdict — pr-reviewer itself must never initiate a push.
if [ "$ROLE" = "pr-reviewer" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: pr-reviewer must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed."}}'
  exit 0
fi

DB=$(tmb_db_path || true)

while IFS="$(printf '\t')" read -r DIR STMT <&3; do
  [ -n "$STMT" ] || continue
  case "$DIR" in
    '?'|-) tmb_deny_ambiguous_git_target "$STMT"; exit 0 ;;
  esac
  # Pushes happen from the main checkout, where bro reaped the task commits;
  # a push run in .claude/worktrees/ is a direct push of unreviewed work.
  case "$DIR" in
    */.claude/worktrees/*)
      jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`."}}'
      exit 0
      ;;
  esac
  # No DB or no sqlite3 — TMB isn't tracking anything in this project.
  if [ -z "$DB" ] || ! tmb_have_sqlite; then
    continue
  fi

  # Commits about to be pushed: upstream tracking when available.
  PUSH_SHAS=$(git -C "$DIR" log '@{u}..HEAD' --pretty=%H 2>/dev/null || true)
  if [ -z "$PUSH_SHAS" ]; then
    # No upstream — first push of a new branch: commits unique to this branch
    # vs the target branch: this repo's repos row, else the sole registered
    # repo's row, else the remote's default branch, else main.
    _PUSH_REPO_ROW=$(tmb_repo_resolve "$DB" "$(tmb_stmt_repo_root "$DIR")")
    PR_TARGET=$(printf '%s' "$_PUSH_REPO_ROW" | cut -d'|' -f1)
    if [ -z "$PR_TARGET" ]; then
      _PUSH_SOLE_PATH=$(tmb_repo_single_path "$DB")
      [ -n "$_PUSH_SOLE_PATH" ] && PR_TARGET=$(tmb_repo_resolve "$DB" "$_PUSH_SOLE_PATH" | cut -d'|' -f1)
    fi
    if [ -z "$PR_TARGET" ]; then
      PR_TARGET=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
    fi
    PR_TARGET="${PR_TARGET:-main}"
    # H4: resolve a base ref that ACTUALLY EXISTS — origin/<target>, <target>,
    # then the remote's default; none → FAIL CLOSED by gating all of HEAD so
    # unsigned commits never bypass the gate on a main-only repo.
    _BASE_REF=""
    for _cand in "origin/${PR_TARGET}" "${PR_TARGET}"; do
      if git -C "$DIR" rev-parse --verify --quiet "$_cand" >/dev/null 2>&1; then
        _BASE_REF="$_cand"
        break
      fi
    done
    if [ -z "$_BASE_REF" ]; then
      _PUSH_DEFAULT=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
      if [ -n "$_PUSH_DEFAULT" ]; then
        for _cand in "origin/${_PUSH_DEFAULT}" "${_PUSH_DEFAULT}"; do
          if git -C "$DIR" rev-parse --verify --quiet "$_cand" >/dev/null 2>&1; then
            _BASE_REF="$_cand"
            break
          fi
        done
      fi
    fi
    if [ -n "$_BASE_REF" ]; then
      PUSH_SHAS=$(git -C "$DIR" log "${_BASE_REF}..HEAD" --pretty=%H 2>/dev/null || true)
    else
      PUSH_SHAS=$(git -C "$DIR" log HEAD --pretty=%H 2>/dev/null || true)
    fi
  fi
  [ -n "$PUSH_SHAS" ] || continue

  SHA_LIST=""
  while IFS= read -r sha; do
    case "$sha" in ''|*[!0-9a-f]*) continue ;; esac
    if [ -z "$SHA_LIST" ]; then SHA_LIST="'$sha'"; else SHA_LIST="$SHA_LIST,'$sha'"; fi
  done <<< "$PUSH_SHAS"
  [ -n "$SHA_LIST" ] || continue

  # Tasks whose commit_sha is in the push set AND lack a passing validation row.
  UNSIGNED=$(tmb_gate_read "$DB" "
    SELECT t.id || '|' || t.branch_id || '|' || substr(t.title, 1, 60)
      FROM tasks t
     WHERE t.commit_sha IN ($SHA_LIST)
       AND NOT EXISTS (
         SELECT 1 FROM validation_attempts v
          WHERE v.task_id = t.id
            AND v.verdict = 'pass'
       );
  ")

  if [ "$UNSIGNED" = "__ERR__" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB and retry the push."}}'
    exit 0
  fi
  [ -n "$UNSIGNED" ] || continue

  COUNT=$(printf '%s\n' "$UNSIGNED" | wc -l | tr -d ' ')
  LIST=$(printf '%s\n' "$UNSIGNED" | awk -F'|' '{ printf "  - task_id=%s  %s  (%s)\n", $1, $2, $3 }')
  DENY_REASON="BLOCKED: pushing ${COUNT} unsigned commit(s). The following tasks lack a pr-reviewer pass verdict:

${LIST}
Run: @bro review before push

bro will spawn pr-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing."
  jq -nc --arg reason "$DENY_REASON" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
done 3<<< "$PUSHES"

exit 0
