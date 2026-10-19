#!/usr/bin/env bash
# Hook: SWE boundary enforcement — structural gates keyed on deterministic
# SWE-context signals.
#
# This is a tripwire for obvious write-forms, not a Bash sandbox. When in
# doubt, the hook passes — precision beats recall here.
#
# Eight rules, all for an SWE identity (SWE_CTX):
#
#   (a) Bash: git push from SWE context                  → DENY
#   (b) Bash: gh/glab MUTATING subcommands               → DENY (read-only gh allowed)
#   (c) Edit/Write: target outside assigned worktree      → DENY
#   (d) Edit/Write: CLAUDE.md at the worktree root        → DENY (always)
#       Edit/Write: prompt-surface paths                  → DENY (unless prompt_bearing=1)
#   (e) Bash: a written CLAUDE.md at the worktree root    → DENY (always)
#       Bash: a written path on the prompt surface        → DENY (unless prompt_bearing=1)
#   (f) Bash: a written path inside the worktree but outside the task's
#       files[] dirs                                      → NOTE (additionalContext, once per path)
#   (g) Bash: a write target behind a variable the command does not set
#                                                         → DENY (unless prompt_bearing=1)
#   (h) Edit/Write: a path a PreToolUse Bash gate denied a write to earlier in
#       the session (dispatch.sh keeps the record)        → ALLOW, audit hook_block_bypassed
#
# Bash writes are judged by the same rules as Edit/Write: every path a
# statement writes (tmb_cmd_write_paths in lib/cmd-analysis.sh, the one list
# of write shapes, resolved against the statement's own cd / git -C dir) goes
# through the prompt-surface predicate (tmb_is_prompt_surface_path) and the
# files[] classifier (lib/scope-fence.sh, shared with swe-scope-fence.sh).
# Scope itself is judged at close: bro_atomic_close diffs the task's own
# commits against files[]. Reads and read inputs of a write never fire.
#
# SWE context = the agent identity (tmb_agent_role in lib/cmd-analysis.sh) is
# swe. A path never decides the role. The assigned worktree and task are the
# caller's own run (tmb_caller_run in lib/query-task.sh, keyed on the payload
# agent_id); a payload with no bound run falls back to $PWD for rule (c) and
# to the target's worktree for task lookups. Bash rules judge the command's
# executable statements only: data heredocs and quoted text are data; a
# program fed to an interpreter through a heredoc is analysed for the paths it
# writes, and a variable set earlier in the same command is resolved.
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

claude_md_reason() {
  printf 'BLOCKED: SWE may not edit CLAUDE.md at the repo root (Human-owned; prompt_bearing does not lift this). Target: %s. Propose the change in your report; the Human applies it.' "$1"
}

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)

SWE_CTX="no"
[ "$(tmb_agent_role "$INPUT")" = "swe" ] && SWE_CTX="yes"

# The caller's own run (tmb_caller_run: the swe agent_runs row bound to the
# payload agent_id). When bound, its root and task decide rule (c), the Bash
# write root and every task lookup below, ahead of $PWD or the target.
CALLER_TASK=""
CALLER_ROOT=""
if [ "$SWE_CTX" = "yes" ]; then
  _CALLER_DB=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$_CALLER_DB" ] && tmb_have_sqlite; then
    _CALLER=$(tmb_caller_run "$INPUT" "$_CALLER_DB")
    if [ "$_CALLER" = "__ERR__" ]; then
      tmb_deny_db_unavailable swe-boundary
      exit 0
    fi
    if [ -n "$_CALLER" ]; then
      CALLER_TASK=$(tmb_sql_int "${_CALLER%%|*}")
      CALLER_ROOT="${_CALLER#*|}"
    fi
  fi
fi

# _task_for <target> <db> — the caller's task when bound, else the task the
# target's worktree resolves to.
_task_for() {
  if [ -n "$CALLER_TASK" ]; then
    printf '%s\n' "$CALLER_TASK"
  else
    tmb_resolve_task_id_for_target "$1" "$INPUT" "$2"
  fi
}

# The assigned worktree root — used by rule (c): the caller's run root, else
# $PWD when it's inside a worktree (a payload with no agent_id).
WORKTREE_ROOT="$CALLER_ROOT"
if [ -z "$WORKTREE_ROOT" ]; then
  case "$PWD" in
    */.claude/worktrees/*)
      WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
      ;;
  esac
fi

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

  _SWE_CWD=$(tmb_payload_cwd "$INPUT")
  _SWE_ROOT="$CALLER_ROOT"
  [ -n "$_SWE_ROOT" ] || _SWE_ROOT=$(_wt_of "$_SWE_CWD")
  [ -n "$_SWE_ROOT" ] || _SWE_ROOT="${CLAUDE_PROJECT_DIR:-}"

  SURFACE_PATH=""
  SURFACE_ANCHOR=""
  ROOT_CLAUDE_MD=""
  UNRESOLVED_TARGET=""
  FENCE_PATHS=()
  while IFS= read -r _wpath; do
    [ -n "$_wpath" ] || continue
    case "$_wpath" in
      UNRESOLVED:*)
        [ -n "$UNRESOLVED_TARGET" ] || UNRESOLVED_TARGET="${_wpath#UNRESOLVED:*:}"
        continue
        ;;
    esac
    _wt=$(_wt_of "$_wpath")
    _rel="${_wpath#"$_wt"/}"
    if [ -z "$_wt" ] || [ "$_rel" = "$_wpath" ]; then _wt=""; _rel="$_wpath"; fi
    if [ -n "$_wt" ] && [ "$_rel" = "CLAUDE.md" ]; then ROOT_CLAUDE_MD="$_wpath"; fi
    if [ -z "$SURFACE_PATH" ] && tmb_is_prompt_surface_path "$_rel" "$_wt"; then
      SURFACE_PATH="$_wpath"
      SURFACE_ANCHOR="${_wt:+$_wpath}"
    fi
    if [ -n "$_wt" ]; then FENCE_PATHS+=("$_wpath"); fi
  done < <(tmb_cmd_write_paths "$CMD" "$_SWE_CWD" "" "$_SWE_ROOT")

  if [ -n "$ROOT_CLAUDE_MD" ]; then
    jq -nc --arg r "$(claude_md_reason "$ROOT_CLAUDE_MD")" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
    exit 0
  fi

  _DB=""
  if [ -n "$SURFACE_PATH" ] || [ -n "$UNRESOLVED_TARGET" ] || [ "${#FENCE_PATHS[@]}" -gt 0 ]; then
    _DB=$(tmb_db_path || true)
  fi
  if { [ -n "$SURFACE_PATH" ] || [ -n "$UNRESOLVED_TARGET" ]; } && [ "$(tmb_db_state)" = "error" ]; then
    tmb_deny_db_unavailable swe-boundary
    exit 0
  fi

  # (e), (g) Lift when the resolved task has prompt_bearing=1.
  _PB_ALLOWED=""
  if [ -n "$SURFACE_PATH" ] || [ -n "$UNRESOLVED_TARGET" ]; then
    [ -n "$SURFACE_ANCHOR" ] || SURFACE_ANCHOR="$(tmb_payload_cwd "$INPUT")/"
    _PB_TASK_ID=$(_task_for "$SURFACE_ANCHOR" "$_DB")
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
  fi
  if [ -n "$SURFACE_PATH" ]; then
    if [ "$_PB_ALLOWED" != "yes" ] && [ "${SURFACE_PATH%%[*?[]*}" != "$SURFACE_PATH" ]; then
      jq -nc --arg r "BLOCKED: a loop or glob over $(dirname "${SURFACE_PATH%%[*?[]*}x") reaches prompt-surface paths (${SURFACE_PATH}); scope the listing below agents/, skills/, commands/, templates/ and rules/, exclude them in the source (-not -path '*/agents/*', --glob '!agents/**', ':!agents'), or inline the paths. Sanctioned route for intentional prompt edits: a prompt_bearing=1 task." \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      exit 0
    fi
    if [ "$_PB_ALLOWED" != "yes" ]; then
      jq -nc --arg r "BLOCKED: SWE may not write prompt-surface files via Bash ($(tmb_cmd_write_shapes)). Target: ${SURFACE_PATH}. Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed." \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      exit 0
    fi
  fi

  if [ -n "$UNRESOLVED_TARGET" ] && [ "$_PB_ALLOWED" != "yes" ]; then
    jq -nc --arg r "BLOCKED: write target \"${UNRESOLVED_TARGET}\" depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command." \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
    exit 0
  fi

  # (f) files[] note, per worktree a written path lies in. Never denies.
  if [ "${#FENCE_PATHS[@]}" -gt 0 ] && [ -n "$_DB" ] && tmb_have_sqlite; then
    _FENCE_WT=""
    _FENCE_TASK=""
    _NOTES=""
    for _wpath in "${FENCE_PATHS[@]}"; do
      _wt=$(_wt_of "$_wpath")
      if [ "$_wt" != "$_FENCE_WT" ]; then
        _FENCE_WT="$_wt"
        _FENCE_TASK=$(_task_for "$_wpath" "$_DB")
        tmb_scope_fence_load "$_DB" "$_FENCE_TASK"
      fi
      [ "$TMB_FENCE_STATE" = "ok" ] || continue
      _rel="${_wpath#"$_wt"/}"
      if tmb_scope_fence_allows "$_rel"; then continue; fi
      _note=$(tmb_scope_fence_note "$_FENCE_TASK" "$_rel")
      [ -n "$_note" ] && _NOTES="${_NOTES:+$_NOTES; }$_note"
    done
    if [ -n "$_NOTES" ]; then
      jq -nc --arg c "TMB: $_NOTES" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$c}}'
    fi
  fi
  exit 0
fi

# ---- Rule (h): Edit/Write after a Bash deny on the same path ----------------
# bypass_check — the allow path of an Edit/Write. When dispatch.sh recorded a
# Bash deny of a write to this path in this session within
# TMB_BYPASS_WINDOW_MIN minutes (default 10), appends a hook_block_bypassed
# audit row, removes the record and prints an additionalContext reminder. The
# write stays allowed; no DB, session or record means no output.
bypass_check() {
  local session state record window gate denied_at now abs db task issue rel content summary ctx
  session=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  case "$session" in ''|*/*|.*) return 0 ;; esac
  state=$(tmb_state_dir 2>/dev/null) || return 0
  case "$TARGET" in
    /*) abs="$TARGET" ;;
    *)  abs="$(tmb_payload_cwd "$INPUT")/$TARGET" ;;
  esac
  record="$(tmb_path_canonical "$state")/locks/boundary-denies/$session/$(tmb_path_digest "$abs")"
  [ -f "$record" ] || return 0
  gate=$(sed -n 1p "$record" 2>/dev/null || true)
  denied_at=$(sed -n 2p "$record" 2>/dev/null || true)
  case "$denied_at" in ''|*[!0-9]*) rm -f "$record"; return 0 ;; esac
  window="${TMB_BYPASS_WINDOW_MIN:-10}"
  case "$window" in ''|*[!0-9]*|0) window=10 ;; esac
  now=$(date +%s)
  if [ $((now - denied_at)) -gt $((window * 60)) ]; then rm -f "$record"; return 0; fi
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] && tmb_have_sqlite || return 0
  # shellcheck source=scripts/hooks/lib/db-write.sh
  . "$SCRIPT_DIR/lib/db-write.sh"
  task=$(_task_for "$TARGET" "$db")
  issue=-1
  if [ -n "$task" ]; then
    issue=$(tmb_sql_int "$(tmb_sqlite_ro "$db" "SELECT issue_id FROM tasks WHERE id = ${task};" 2>/dev/null || true)")
    [ -n "$issue" ] || issue=-1
  fi
  rel="$TARGET"
  [ -n "$_WT_D" ] && rel="${TARGET#"$_WT_D"/}"
  content=$(jq -cn --arg tool "$TOOL_NAME" --arg path "$TARGET" --arg gate "$gate" --argjson at "$denied_at" --arg sid "$session" --arg tid "$task" \
    '{tool:$tool, path:$path, denied_gate:$gate, denied_at:$at, session_id:$sid, task_id:(if $tid == "" then null else ($tid | tonumber) end)}')
  summary="$TOOL_NAME to $rel after $gate denied a Bash write to it"
  tmb_audit_append "$db" "$issue" '' "hook:swe-boundary" "hook_block_bypassed" "$summary" "$content" || return 0
  rm -f "$record"
  ctx="TMB: $TOOL_NAME to $TARGET follows a $gate Bash deny in this session; recorded as hook_block_bypassed. A hook block is a hard stop: report it to bro instead of rewriting the file with another tool."
  jq -nc --arg c "$ctx" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$c}}'
}

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

# ---- Rule (d): CLAUDE.md and prompt-surface paths --------------------------
# Deny CLAUDE.md at the worktree root always; deny the rest of the prompt
# surface (tmb_is_prompt_surface_path) from SWE context unless the task row
# has prompt_bearing=1.
_WT_D=$(tmb_worktree_root_for_target "$TARGET")
_SUBJECT="$TARGET"
[ -z "$_WT_D" ] || _SUBJECT="${TARGET#"$_WT_D"/}"
if [ -n "$_WT_D" ] && [ "$_SUBJECT" = "CLAUDE.md" ]; then
  jq -nc --arg r "$(claude_md_reason "$TARGET")" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
  exit 0
fi
IS_PROMPT_SURFACE=""
tmb_is_prompt_surface_path "$_SUBJECT" "$_WT_D" && IS_PROMPT_SURFACE="yes"

if [ "$IS_PROMPT_SURFACE" = "yes" ]; then
  DB=$(tmb_db_path || true)
  if [ "$(tmb_db_state)" = "error" ]; then
    tmb_deny_db_unavailable swe-boundary
    exit 0
  fi
  if [ -n "$DB" ] && tmb_have_sqlite; then
    # The caller's task when bound; else resolve it robustly (worktree branch
    # → slug → transcript), deriving the worktree from the TARGET when $PWD
    # isn't inside one.
    TASK_ID=$(_task_for "$TARGET" "$DB")
    if [ -n "$TASK_ID" ]; then
      PROMPT_BEARING=$(tmb_gate_read "$DB" "
        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${TASK_ID} LIMIT 1;
      ")
      if [ "$PROMPT_BEARING" = "__ERR__" ]; then
        tmb_deny_db_unavailable swe-boundary
        exit 0
      fi
      if [ "${PROMPT_BEARING:-0}" = "1" ]; then
        bypass_check
        exit 0
      fi
    fi
  fi
  PS_DENY_MSG="BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${TARGET}. If this task intentionally modifies agent prompts, set prompt_bearing=1 in task_create_batch."
  jq -nc --arg r "$PS_DENY_MSG" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
  exit 0
fi

bypass_check
exit 0
