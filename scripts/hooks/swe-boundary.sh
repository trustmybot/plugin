#!/usr/bin/env bash
# Hook: SWE boundary enforcement — structural gates keyed on deterministic
# SWE-context signals.
#
# Four rules, all guarded by tmb_swe_context():
#
#   (a) Bash: git push from SWE context            → DENY
#   (b) Bash: gh/glab MUTATING subcommands          → DENY (read-only gh allowed)
#   (c) Edit/Write: target outside assigned worktree → DENY
#   (d) Edit/Write: prompt-surface paths             → DENY (unless prompt_bearing=1)
#
# SWE-context signal (deterministic, defined once here):
#   - For Bash tool calls: PWD is inside .claude/worktrees/* AND a tasks row with
#     matching branch_id exists in state IN ('pending','running','completed'), OR
#     agent_type == 'swe' in the hook payload.
#   - For Edit/Write tool calls: agent_type == 'swe' OR the target path is inside
#     a known worktree path.
#
# Fires on: PreToolUse — matcher: Bash|Edit|Write|MultiEdit|NotebookEdit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")

# tmb_swe_context: returns "yes" when this hook invocation is in a SWE context.
# Two deterministic signals, priority order:
#   1. agent_type field == 'swe' → yes (most reliable when CC populates it)
#   2. agent_type field is a known non-SWE role → no (explicit identity wins)
#   3. agent_type field is absent/empty + $PWD inside .claude/worktrees/ → yes
#      (structural fallback for cases where CC #97 strips the agent_type field)
# Never returns "yes" when agent_type is explicitly a non-SWE role.
tmb_swe_context() {
  if [ "$AGENT_TYPE" = "swe" ]; then
    echo "yes"
    return
  fi
  case "$AGENT_TYPE" in
    bro|pr-reviewer|architect|cto|ceo|pm|consultant)
      echo "no"
      return
      ;;
  esac
  # agent_type absent or unknown — fall back to PWD signal.
  case "$PWD" in
    */.claude/worktrees/*) echo "yes"; return ;;
  esac
  echo "no"
}

SWE_CTX=$(tmb_swe_context)

# ---- Rule (a): git push from SWE context ------------------------------------
# Already handled by git-push-guard.sh (which checks both WT_CWD and agent_type).
# This hook adds defense-in-depth by also checking the SWE_CTX signal for
# non-worktree cases (e.g. SWE calling git push with a cd prefix).
# We skip force-pushes (delegated to git-guards.sh).

if [ "$TOOL_NAME" = "Bash" ] && [ "$SWE_CTX" = "yes" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

  IS_PUSH=""
  IS_FORCE=""
  case "$CMD" in
    "git push"*|"git -C "*" push"*) IS_PUSH="yes" ;;
    *"; git push"*|*"&& git push"*|*"|| git push"*) IS_PUSH="yes" ;;
    *"; git -C "*" push"*|*"&& git -C "*" push"*|*"|| git -C "*" push"*) IS_PUSH="yes" ;;
  esac
  case "$CMD" in
    *"--force"*|*" -f "*) IS_FORCE="yes" ;;
  esac
  if [ "$IS_PUSH" = "yes" ] && [ "$IS_FORCE" != "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
    exit 0
  fi

  # ---- Rule (b): gh/glab MUTATING subcommands from SWE context --------------
  # Read-only gh is allowed (SWEs legitimately read issues/PRs).
  # Blocked: gh issue create/close/edit, gh pr create/merge/close, gh api -X POST/PATCH/PUT/DELETE
  # Same for glab equivalents.
  GH_MUTATING=""
  case "$CMD" in
    *"gh issue create"*|*"gh issue close"*|*"gh issue edit"*|*"gh issue delete"*) GH_MUTATING="yes" ;;
    *"gh pr create"*|*"gh pr merge"*|*"gh pr close"*|*"gh pr edit"*) GH_MUTATING="yes" ;;
    *"gh api"*"-X POST"*|*"gh api"*"-X PATCH"*|*"gh api"*"-X PUT"*|*"gh api"*"-X DELETE"*) GH_MUTATING="yes" ;;
    *"gh api"*"--method POST"*|*"gh api"*"--method PATCH"*|*"gh api"*"--method PUT"*|*"gh api"*"--method DELETE"*) GH_MUTATING="yes" ;;
    *"glab issue create"*|*"glab issue close"*|*"glab issue edit"*) GH_MUTATING="yes" ;;
    *"glab mr create"*|*"glab mr merge"*|*"glab mr close"*|*"glab mr edit"*) GH_MUTATING="yes" ;;
  esac
  if [ "$GH_MUTATING" = "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro."}}'
    exit 0
  fi
fi

# ---- Rules (c) and (d): Edit/Write fence ------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

[ "$SWE_CTX" = "yes" ] || exit 0

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || true)
[ -n "$TARGET" ] || exit 0

# Resolve the assigned worktree root for this SWE instance.
# Primary signal: $PWD when it's inside a worktree. Secondary: agent_transcript_path.
WORKTREE_ROOT=""
case "$PWD" in
  */.claude/worktrees/*)
    WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
    ;;
esac

# ---- Rule (c): target outside assigned worktree ----------------------------
if [ -n "$WORKTREE_ROOT" ]; then
  # Normalize target to absolute path for comparison.
  # If target is relative, prepend PWD.
  case "$TARGET" in
    /*) ABS_TARGET="$TARGET" ;;
    *)  ABS_TARGET="${PWD}/${TARGET}" ;;
  esac
  # Resolve any ./ or ../ without requiring realpath (best-effort).
  case "$ABS_TARGET" in
    *"/../"*|*"/./"*)
      _resolved=$(cd "$(dirname "$ABS_TARGET")" 2>/dev/null && pwd)/$(basename "$ABS_TARGET") || true
      [ -n "$_resolved" ] && ABS_TARGET="$_resolved"
      ;;
  esac
  case "$ABS_TARGET" in
    "${WORKTREE_ROOT}"/*|"${WORKTREE_ROOT}") ;;
    *)
      DENY_MSG="BLOCKED: SWE may only edit files inside its assigned worktree (${WORKTREE_ROOT}). Target '${TARGET}' is outside the worktree."
      jq -nc --arg r "$DENY_MSG" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$r}}'
      exit 0
      ;;
  esac
fi

# ---- Rule (d): prompt-surface paths ----------------------------------------
# Deny edits to agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md,
# CODEX.md, CURSOR.md, GEMINI.md from SWE context — unless the task row has
# prompt_bearing=1.
BASENAME=$(basename "$TARGET")
IS_PROMPT_SURFACE=""
case "$TARGET" in
  */agents/*.md|agents/*.md) IS_PROMPT_SURFACE="yes" ;;
  */skills/*/SKILL.md|skills/*/SKILL.md) IS_PROMPT_SURFACE="yes" ;;
  */commands/*.md|commands/*.md) IS_PROMPT_SURFACE="yes" ;;
  */templates/*.md|templates/*.md) IS_PROMPT_SURFACE="yes" ;;
esac
case "$BASENAME" in
  CLAUDE.md|CODEX.md|CURSOR.md|GEMINI.md) IS_PROMPT_SURFACE="yes" ;;
esac

if [ "$IS_PROMPT_SURFACE" = "yes" ]; then
  DB=$(tmb_db_path || true)
  if [ -n "$DB" ] && tmb_have_sqlite; then
    # Resolve task_id from transcript.
    TASK_ID=""
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      TASK_ID=$(jq -r '
        .message.content // [] |
        .[] | select(.type == "text") | .text // ""
      ' "$TRANSCRIPT_PATH" 2>/dev/null \
        | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)
      case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
    fi
    # Slug fallback: when transcript provides no task_id but a worktree root is
    # known, resolve the task by branch_id slug (same query as swe-scope-fence.sh).
    if [ -z "$TASK_ID" ] && [ -n "$WORKTREE_ROOT" ]; then
      WORKTREE_SLUG=$(echo "$WORKTREE_ROOT" | sed -E 's|.*/.claude/worktrees/([^/]+)$|\1|')
      if [ -n "$WORKTREE_SLUG" ]; then
        SAFE_SLUG=$(tmb_sql_quote "$WORKTREE_SLUG")
        TASK_ID=$(tmb_sqlite_ro "$DB" "
          SELECT id FROM tasks
           WHERE branch_id LIKE '%/${SAFE_SLUG}'
             AND status IN ('pending','running','completed')
           ORDER BY id DESC
           LIMIT 1;
        " 2>/dev/null || true)
        case "$TASK_ID" in ''|*[!0-9]*) TASK_ID="" ;; esac
      fi
    fi
    if [ -n "$TASK_ID" ]; then
      PROMPT_BEARING=$(tmb_sqlite_ro "$DB" "
        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${TASK_ID} LIMIT 1;
      " 2>/dev/null || echo "0")
      if [ "${PROMPT_BEARING:-0}" -eq 1 ]; then
        exit 0
      fi
    fi
  fi
  PS_DENY_MSG="BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${TARGET}. If this task intentionally modifies agent prompts, set prompt_bearing=1 in task_create_batch."
  jq -nc --arg r "$PS_DENY_MSG" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$r}}'
  exit 0
fi

exit 0
