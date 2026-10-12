#!/usr/bin/env bash
# Hook: SWE boundary enforcement — structural gates keyed on deterministic
# SWE-context signals.
#
# This is a tripwire for obvious write-forms, not a Bash sandbox. When in
# doubt, the hook passes — precision beats recall here.
#
# Six rules, all for an SWE identity (SWE_CTX):
#
#   (a) Bash: git push from SWE context                  → DENY
#   (b) Bash: gh/glab MUTATING subcommands               → DENY (read-only gh allowed)
#   (c) Edit/Write: target outside assigned worktree      → DENY
#   (d) Edit/Write: prompt-surface paths                  → DENY (unless prompt_bearing=1)
#   (e) Bash: a written path on the prompt surface        → DENY (unless prompt_bearing=1)
#   (f) Bash: a written path inside the worktree but outside the task's
#       files[] dirs                                      → DENY (scope fence)
#
# Bash writes are judged by the same rules as Edit/Write: every path a
# statement writes (tmb_cmd_write_paths in lib/cmd-analysis.sh, the one list
# of write shapes, resolved against the statement's own cd / git -C dir) goes
# through the prompt-surface predicate (tmb_is_prompt_surface_path) and the
# scope fence (lib/scope-fence.sh, shared with swe-scope-fence.sh). Reads and
# read inputs of a write never fire.
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
# shellcheck source=scripts/hooks/lib/scope-fence.sh
. "$SCRIPT_DIR/lib/scope-fence.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)

SWE_CTX="no"
[ "$(tmb_agent_role "$INPUT")" = "swe" ] && SWE_CTX="yes"

# Resolve the assigned worktree root once — used by rule (c).
# Primary signal: $PWD when it's inside a worktree.
WORKTREE_ROOT=""
case "$PWD" in
  */.claude/worktrees/*)
    WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
    ;;
esac

# ---- Rules (a), (b), (e), (f): Bash from SWE context ------------------------
# Each rule judges the executable statements of the command
# (tmb_cmd_statements): a push or gh mutation named in a heredoc, a quoted
# string, a grep pattern or a commit message is data and never fires.
if [ "$TOOL_NAME" = "Bash" ] && [ "$SWE_CTX" = "yes" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  STMTS=$(tmb_cmd_statements "$CMD" "$(tmb_payload_cwd "$INPUT")")

  # (a) git push (force pushes are git-guards' job). (b) gh/glab mutating
  # subcommands and api calls with a write verb (tmb_gh_mutation); read-only
  # gh (view, list, status, api GET) stays allowed.
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
    if [ -n "$(tmb_gh_mutation "$stmt")" ]; then GH_MUTATING="yes"; fi
  done <<< "$STMTS"

  if [ "$IS_PUSH" = "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
    exit 0
  fi
  if [ "$GH_MUTATING" = "yes" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro."}}'
    exit 0
  fi

  # (e), (f) Every written path, relative to the worktree it lies in.
  _wt_of() {
    case "$1" in
      */.claude/worktrees/*) printf '%s' "$1" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|' ;;
    esac
  }

  SURFACE_PATH=""
  SURFACE_ANCHOR=""
  FENCE_PATHS=()
  while IFS= read -r _wpath; do
    [ -n "$_wpath" ] || continue
    _wt=$(_wt_of "$_wpath")
    _rel="${_wpath#"$_wt"/}"
    if [ -z "$_wt" ] || [ "$_rel" = "$_wpath" ]; then _wt=""; _rel="$_wpath"; fi
    if [ -z "$SURFACE_PATH" ] && tmb_is_prompt_surface_path "$_rel"; then
      SURFACE_PATH="$_wpath"
      SURFACE_ANCHOR="${_wt:+$_wpath}"
    fi
    if [ -n "$_wt" ]; then FENCE_PATHS+=("$_wpath"); fi
  done < <(tmb_cmd_write_paths "$CMD" "$(tmb_payload_cwd "$INPUT")")

  if [ -n "$SURFACE_PATH" ] || [ "${#FENCE_PATHS[@]}" -gt 0 ]; then
    _DB=$(tmb_db_path || true)
    if [ "$(tmb_db_state)" = "error" ]; then
      tmb_deny_db_unavailable swe-boundary
      exit 0
    fi
  fi

  # (e) Lifts when the resolved task has prompt_bearing=1.
  if [ -n "$SURFACE_PATH" ]; then
    _PB_ALLOWED=""
    _PB_TASK_ID=$(tmb_resolve_task_id_for_target "$SURFACE_ANCHOR" "$INPUT" "$_DB")
    if [ -n "$_PB_TASK_ID" ] && [ -n "$_DB" ] && tmb_have_sqlite; then
      _PB_VAL=$(tmb_gate_read "$_DB" "
        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${_PB_TASK_ID} LIMIT 1;
      ")
      if [ "$_PB_VAL" = "__ERR__" ]; then
        tmb_deny_db_unavailable swe-boundary
        exit 0
      fi
      if [ "${_PB_VAL:-0}" = "1" ]; then _PB_ALLOWED="yes"; fi
    fi
    if [ "$_PB_ALLOWED" != "yes" ]; then
      jq -nc --arg r "BLOCKED: SWE may not write prompt-surface files via Bash ($(tmb_cmd_write_shapes)). Target: ${SURFACE_PATH}. Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed." \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      exit 0
    fi
  fi

  # (f) Scope fence, per worktree a written path lies in.
  if [ "${#FENCE_PATHS[@]}" -gt 0 ] && [ -n "$_DB" ] && tmb_have_sqlite; then
    _FENCE_WT=""
    for _wpath in "${FENCE_PATHS[@]}"; do
      _wt=$(_wt_of "$_wpath")
      if [ "$_wt" != "$_FENCE_WT" ]; then
        _FENCE_WT="$_wt"
        tmb_scope_fence_load "$_DB" "$(tmb_resolve_task_id_for_target "$_wpath" "$INPUT" "$_DB")"
        if [ "$TMB_FENCE_STATE" = "error" ]; then
          tmb_deny_db_unavailable swe-boundary
          exit 0
        fi
      fi
      [ "$TMB_FENCE_STATE" = "ok" ] || continue
      _rel="${_wpath#"$_wt"/}"
      if tmb_scope_fence_allows "$_rel"; then continue; fi
      jq -nc --arg r "$(tmb_scope_fence_reason "$_rel")" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      exit 0
    done
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
# Deny edits to the prompt surface (tmb_is_prompt_surface_path) from SWE
# context — unless the task row has prompt_bearing=1.
_WT_D=$(tmb_worktree_root_for_target "$TARGET")
_SUBJECT="${TARGET#"$_WT_D"/}"
IS_PROMPT_SURFACE=""
tmb_is_prompt_surface_path "$_SUBJECT" && IS_PROMPT_SURFACE="yes"

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
