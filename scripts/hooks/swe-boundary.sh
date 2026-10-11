#!/usr/bin/env bash
# Hook: SWE boundary enforcement — structural gates keyed on deterministic
# SWE-context signals.
#
# This is a tripwire for obvious write-forms, not a Bash sandbox. When in
# doubt, the hook passes — precision beats recall here.
#
# Five rules, all for an SWE identity (SWE_CTX):
#
#   (a) Bash: git push from SWE context                  → DENY
#   (b) Bash: gh/glab MUTATING subcommands               → DENY (read-only gh allowed)
#   (c) Edit/Write: target outside assigned worktree      → DENY
#   (d) Edit/Write: prompt-surface paths                  → DENY (unless prompt_bearing=1)
#   (e) Bash: write-form command targeting prompt surface → DENY (unless prompt_bearing=1)
#
# Write-forms matched by rule (e):
#   >, >>, tee, sed -i, perl -i, python/python3 open(...,'w'|'a'), cp/mv/rsync
#   with a prompt-surface destination (verb coupled to destination token).
# Prompt surfaces: agents/*.md, skills/*/SKILL.md, commands/*.md,
#   templates/*.md, CLAUDE.md, CODEX.md, CURSOR.md, GEMINI.md.
# Read-only commands (cat, grep, sed -n, sed without -i) are never tripped.
#
# SWE context = the agent identity (tmb_agent_role in lib/cmd-analysis.sh) is
# swe. A path never decides the role. Bash rules judge the command's
# executable statements only: heredoc bodies and quoted text are data.
#
# Fires on: PreToolUse — matcher: Bash|Edit|Write|MultiEdit|NotebookEdit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)

SWE_CTX="no"
[ "$(tmb_agent_role "$INPUT")" = "swe" ] && SWE_CTX="yes"

# Resolve the assigned worktree root once — used by rules (c), (d), and (e).
# Primary signal: $PWD when it's inside a worktree.
WORKTREE_ROOT=""
case "$PWD" in
  */.claude/worktrees/*)
    WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
    ;;
esac

# ---- Rules (a), (b), (e): Bash from SWE context -----------------------------
# Each rule judges the executable statements of the command
# (tmb_cmd_statements): a push or gh mutation named in a heredoc, a quoted
# string, a grep pattern or a commit message is data and never fires.
if [ "$TOOL_NAME" = "Bash" ] && [ "$SWE_CTX" = "yes" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  STMTS=$(tmb_cmd_statements "$CMD" "$(tmb_payload_cwd "$INPUT")")

  # (a) git push (force pushes are git-guards' job). (b) gh/glab mutating
  # subcommands; read-only gh (view, list, status) stays allowed.
  IS_PUSH=""
  GH_MUTATING=""
  while IFS="$(printf '\t')" read -r _dir stmt; do
    sub=$(tmb_git_subcommand "$stmt")
    case "$sub" in
      push|"push "*)
        case " ${sub} " in
          *" --force "*|*" -f "*|*" --force-with-lease "*|*" --force-with-lease="*) ;;
          *) IS_PUSH="yes" ;;
        esac
        ;;
    esac
    case "$stmt" in
      "gh issue create"*|"gh issue close"*|"gh issue edit"*|"gh issue delete"*) GH_MUTATING="yes" ;;
      "gh pr create"*|"gh pr merge"*|"gh pr close"*|"gh pr edit"*) GH_MUTATING="yes" ;;
      "gh api "*" -X POST"*|"gh api "*" -X PATCH"*|"gh api "*" -X PUT"*|"gh api "*" -X DELETE"*) GH_MUTATING="yes" ;;
      "gh api "*" --method POST"*|"gh api "*" --method PATCH"*|"gh api "*" --method PUT"*|"gh api "*" --method DELETE"*) GH_MUTATING="yes" ;;
      "glab issue create"*|"glab issue close"*|"glab issue edit"*) GH_MUTATING="yes" ;;
      "glab mr create"*|"glab mr merge"*|"glab mr close"*|"glab mr edit"*) GH_MUTATING="yes" ;;
    esac
  done <<< "$STMTS"

  if [ "$IS_PUSH" = "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
    exit 0
  fi
  if [ "$GH_MUTATING" = "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro."}}'
    exit 0
  fi

  # (e) A write position (redirect, tee, cp/mv/rsync/install destination,
  # sed -i / perl -i file, python open w/a) naming a prompt surface. Reads
  # never fire. Lifts when the resolved task has prompt_bearing=1.
  _is_prompt_surface_token() {
    case "$1" in
      agents/*.md|*/agents/*.md) return 0 ;;
      skills/*/SKILL.md|*/skills/*/SKILL.md) return 0 ;;
      commands/*.md|*/commands/*.md) return 0 ;;
      templates/*.md|*/templates/*.md) return 0 ;;
      CLAUDE.md|*/CLAUDE.md) return 0 ;;
      CODEX.md|*/CODEX.md) return 0 ;;
      CURSOR.md|*/CURSOR.md) return 0 ;;
      GEMINI.md|*/GEMINI.md) return 0 ;;
    esac
    return 1
  }

  BASH_PROMPT_WRITE=""
  while IFS= read -r _wpath; do
    if _is_prompt_surface_token "$_wpath"; then BASH_PROMPT_WRITE="yes"; fi
  done < <(tmb_cmd_write_paths "$CMD")

  if [ "$BASH_PROMPT_WRITE" = "yes" ]; then
    # Resolve prompt_bearing via the shared resolver (worktree branch → slug →
    # transcript). Bash write-forms have no Edit target path; pass empty so the
    # resolver derives the worktree from $PWD.
    _PB_DB=$(tmb_db_path || true)
    if [ "$(tmb_db_state)" = "error" ]; then
      tmb_deny_db_unavailable swe-boundary
      exit 0
    fi
    _PB_TASK_ID=$(tmb_resolve_task_id_for_target "" "$INPUT" "$_PB_DB")
    _PB_ALLOWED=""
    if [ -n "$_PB_TASK_ID" ]; then
      if [ -n "$_PB_DB" ] && tmb_have_sqlite; then
        _PB_VAL=$(tmb_gate_read "$_PB_DB" "
          SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${_PB_TASK_ID} LIMIT 1;
        ")
        if [ "$_PB_VAL" = "__ERR__" ]; then
          tmb_deny_db_unavailable swe-boundary
          exit 0
        fi
        [ "${_PB_VAL:-0}" = "1" ] && _PB_ALLOWED="yes"
      fi
    fi
    if [ "$_PB_ALLOWED" != "yes" ]; then
      jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE may not write prompt-surface files via Bash (>, >>, tee, sed -i, perl -i, python open w/a, cp/mv/rsync). Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed."}}'
      exit 0
    fi
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
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
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
  if [ "$(tmb_db_state)" = "error" ]; then
    tmb_deny_db_unavailable swe-boundary
    exit 0
  fi
  if [ -n "$DB" ] && tmb_have_sqlite; then
    # Resolve task_id robustly (worktree branch → slug → transcript), deriving
    # the worktree from the TARGET when $PWD isn't inside one.
    TASK_ID=$(tmb_resolve_task_id_for_target "$TARGET" "$INPUT" "$DB")
    if [ -n "$TASK_ID" ]; then
      PROMPT_BEARING=$(tmb_gate_read "$DB" "
        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${TASK_ID} LIMIT 1;
      ")
      if [ "$PROMPT_BEARING" = "__ERR__" ]; then
        tmb_deny_db_unavailable swe-boundary
        exit 0
      fi
      if [ "${PROMPT_BEARING:-0}" = "1" ]; then
        exit 0
      fi
    fi
  fi
  PS_DENY_MSG="BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${TARGET}. If this task intentionally modifies agent prompts, set prompt_bearing=1 in task_create_batch."
  jq -nc --arg r "$PS_DENY_MSG" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
  exit 0
fi

exit 0
