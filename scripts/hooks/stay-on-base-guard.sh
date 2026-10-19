#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): Stay-on-base guard.
#
# The main checkout (workspace repo root, not a worktree) must stay on the
# base branch (pr_target, typically 'dev') while SWE tasks are in flight.
# Switching the main checkout to a task branch while SWE work is open would
# cause bro to operate on the wrong HEAD — PR targets, branch comparisons,
# and world-model scans all break silently.
#
# Each `git [-C <p>] checkout|switch` statement of the command's executable
# skeleton (lib/cmd-analysis.sh) is judged in its effective dir. DENY when:
#   1. it switches branches — NOT a new-branch creation (-b/-B/-c/-C/--create)
#      and not a file restore (checkout -- <file>);
#   2. the target branch is the branch_id of an open task (status IN
#      ('pending','running','needs_validation'));
#   3. the dir is the MAIN checkout (not inside .claude/worktrees/*) — or is
#      ambiguous (linked worktrees exist and the statement names no dir), which
#      denies with ambiguous_git_target and its remedy.
#
# ALLOW: branch creation, switches to non-task branches, switches run inside a
# worktree, switches named only in quoted text or a heredoc.
#
# The deny names the task's worktree as an absolute path: tmb_task_location
# (<repos.path>/.claude/worktrees/<slug>), else under the statement dir's main
# checkout.
#
# Pattern follows #428 hardening: numeric task_id validation, fail-closed
# tmb_gate_read from lib/query-task.sh, early-exit for non-checkout commands.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"
# shellcheck source=scripts/hooks/lib/agent-context.sh
. "$SCRIPT_DIR/lib/agent-context.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
case "$CMD" in *checkout*|*switch*) ;; *) exit 0 ;; esac

SWITCHES=""
while IFS="$(printf '\t')" read -r dir stmt; do
  sub=$(tmb_git_subcommand "$stmt")
  case "$sub" in "checkout "*|"switch "*) ;; *) continue ;; esac
  case " $sub " in
    *" -b "*|*" -B "*|*" -c "*|*" -C "*|*" --create "*|*" -- "*) continue ;;
  esac
  target=""
  read -r -a words <<< "${sub#* }"
  for w in "${words[@]}"; do
    case "$w" in -*) ;; *) target="$w" ;; esac
  done
  [ -n "$target" ] || continue
  printf '%s' "$target" | grep -E '^[a-zA-Z0-9_./:@^~-]+$' >/dev/null || continue
  SWITCHES="${SWITCHES}${dir}$(printf '\t')${target}$(printf '\t')${stmt}
"
done < <(tmb_cmd_statements "$CMD" "$(tmb_payload_cwd "$INPUT")")
[ -n "$SWITCHES" ] || exit 0

tmb_have_sqlite || exit 0
DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] && [ -f "$DB" ] || exit 0

while IFS="$(printf '\t')" read -r DIR TARGET_BRANCH STMT; do
  [ -n "$TARGET_BRANCH" ] || continue
  case "$DIR" in
    */.claude/worktrees/*|-) continue ;;
  esac

  SAFE_BRANCH=$(tmb_sql_quote "$TARGET_BRANCH")
  OPEN_TASK_ID=$(tmb_gate_read "$DB" "
    SELECT id FROM tasks
     WHERE branch_id = '${SAFE_BRANCH}'
       AND status IN ('pending','running','needs_validation')
     LIMIT 1;
  ")
  if [ "$OPEN_TASK_ID" = "__ERR__" ]; then
    tmb_deny_db_unavailable stay-on-base-guard
    exit 0
  fi
  [ -n "$OPEN_TASK_ID" ] || continue
  printf '%s' "$OPEN_TASK_ID" | grep -E '^[0-9]+$' >/dev/null || continue

  if [ "$DIR" = "?" ]; then
    tmb_deny_ambiguous_git_target "$STMT"
    exit 0
  fi

  if tmb_task_location "$DB" "$OPEN_TASK_ID"; then
    WT="$TMB_CTX_WORKTREE"
  else
    MAIN_ROOT=$(tmb_repo_git_root "$DIR")
    WT="${MAIN_ROOT:-$DIR}/.claude/worktrees/$(tmb_branch_slug "$TARGET_BRANCH")"
  fi
  jq -nc --arg reason \
    "the main checkout stays on the base; SWE work lives in worktrees — use the worktree at ${WT}. Branch '${TARGET_BRANCH}' belongs to open task #${OPEN_TASK_ID}. Switch to the worktree instead: cd ${WT}" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
  exit 0
done <<< "$SWITCHES"

exit 0
