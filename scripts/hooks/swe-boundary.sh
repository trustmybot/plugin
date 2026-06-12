#!/usr/bin/env bash
# Hook: SWE boundary enforcement — structural gates keyed on deterministic
# SWE-context signals.
#
# This is a tripwire for obvious write-forms, not a Bash sandbox. When in
# doubt, the hook passes — precision beats recall here.
#
# Five rules, all guarded by tmb_swe_context():
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

# Resolve the assigned worktree root once — used by rules (c), (d), and (e).
# Primary signal: $PWD when it's inside a worktree.
WORKTREE_ROOT=""
case "$PWD" in
  */.claude/worktrees/*)
    WORKTREE_ROOT=$(echo "$PWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
    ;;
esac

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

  # ---- Rule (e): Bash write-form targeting a prompt surface ------------------
  # Tripwire for the obvious forms only — reads (cat/grep/sed -n) never fire.
  # Deny lifts when the resolved task has prompt_bearing=1 (same resolution as
  # rule (d), including the slug fallback).
  #
  # Destination-coupled matching: the verb/redirect operator must be adjacent to
  # the prompt-surface path token. A prompt-surface path mentioned inside a quoted
  # string argument (grep/echo) or as the SOURCE of cp/mv does not count.
  #
  # _is_prompt_surface_token <token>: returns 0 if the token is a prompt-surface path.
  _is_prompt_surface_token() {
    local tok="$1"
    case "$tok" in
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

  _bash_writes_prompt_surface() {
    local cmd="$1"

    # --- Redirect forms: > <dest> or >> <dest> ---
    # Extract the token immediately after > or >> (with optional leading spaces).
    # We strip the redirect operator and look at what follows.
    # Pattern: anything then ">>" or ">" then optional space then the dest token.
    # We use a two-step approach: find the dest token after the last redirect.
    local after_redir=""
    case "$cmd" in
      *">>"*)
        # Extract what comes after >> (rightmost occurrence for pipelines).
        after_redir="${cmd##*>>}"
        # Strip leading whitespace.
        after_redir="${after_redir#"${after_redir%%[! ]*}"}"
        # Take first token (up to space or end).
        local dest_tok="${after_redir%% *}"
        _is_prompt_surface_token "$dest_tok" && return 0
        ;;
    esac
    case "$cmd" in
      *">"*)
        # Only match single > (not >>). Strip >> occurrences first.
        local no_dbl
        no_dbl=$(printf '%s' "$cmd" | sed 's/>>//g')
        case "$no_dbl" in
          *">"*)
            after_redir="${no_dbl##*>}"
            after_redir="${after_redir#"${after_redir%%[! ]*}"}"
            local dest_tok2="${after_redir%% *}"
            _is_prompt_surface_token "$dest_tok2" && return 0
            ;;
        esac
        ;;
    esac

    # --- tee: match "tee <dest>" or "tee -a <dest>" ---
    # The destination is the last non-flag argument to tee.
    # Extract the argument after 'tee' (or 'tee -a').
    local tee_rest=""
    case "$cmd" in
      *" tee "*|*" tee	"*|"tee "*)
        # Capture everything after the last occurrence of " tee " or "tee ".
        case "$cmd" in
          *" tee "*) tee_rest="${cmd##* tee }" ;;
          "tee "*) tee_rest="${cmd#tee }" ;;
        esac
        # Skip -a flag if present.
        case "$tee_rest" in
          "-a "*) tee_rest="${tee_rest#-a }" ;;
        esac
        local tee_dest="${tee_rest%% *}"
        _is_prompt_surface_token "$tee_dest" && return 0
        ;;
    esac

    # --- sed -i: match "sed -i[suffix] ... <file>" ---
    # The file is the last token. We check if the command has sed -i and a
    # prompt-surface path token appears after sed -i (not before).
    case "$cmd" in
      *"sed -i"*|*"sed --in-place"*)
        local after_sedi=""
        case "$cmd" in
          *"sed --in-place"*) after_sedi="${cmd##*sed --in-place}" ;;
          *"sed -i"*) after_sedi="${cmd##*sed -i}" ;;
        esac
        # The last token in after_sedi is the file.
        local sedi_file="${after_sedi##* }"
        _is_prompt_surface_token "$sedi_file" && return 0
        ;;
    esac

    # --- perl -i: match "perl -i[suffix] ... <file>" ---
    case "$cmd" in
      *"perl -i"*)
        local after_perli="${cmd##*perl -i}"
        local perli_file="${after_perli##* }"
        _is_prompt_surface_token "$perli_file" && return 0
        ;;
    esac

    # --- python/python3 open(<path>, 'w'|'a'): the path inside open() ---
    case "$cmd" in
      *"python"*"open("*"'w'"*|*"python"*"open("*'"w"'*)
        local open_arg="${cmd##*open(}"
        local open_path="${open_arg%%,*}"
        # Strip surrounding quotes.
        open_path="${open_path#\'}"
        open_path="${open_path%\'}"
        open_path="${open_path#\"}"
        open_path="${open_path%\"}"
        _is_prompt_surface_token "$open_path" && return 0
        ;;
    esac
    case "$cmd" in
      *"python"*"open("*"'a'"*|*"python"*"open("*'"a"'*)
        local open_arg2="${cmd##*open(}"
        local open_path2="${open_arg2%%,*}"
        open_path2="${open_path2#\'}"
        open_path2="${open_path2%\'}"
        open_path2="${open_path2#\"}"
        open_path2="${open_path2%\"}"
        _is_prompt_surface_token "$open_path2" && return 0
        ;;
    esac

    # --- cp/mv/rsync: destination is the LAST argument ---
    # The prompt-surface path must be the last token (destination).
    case "$cmd" in
      "cp "*|*" cp "*)
        local cp_last="${cmd##* }"
        _is_prompt_surface_token "$cp_last" && return 0
        ;;
    esac
    case "$cmd" in
      "mv "*|*" mv "*)
        local mv_last="${cmd##* }"
        _is_prompt_surface_token "$mv_last" && return 0
        ;;
    esac
    case "$cmd" in
      "rsync "*|*" rsync "*)
        local rsync_last="${cmd##* }"
        _is_prompt_surface_token "$rsync_last" && return 0
        ;;
    esac

    return 1
  }

  BASH_PROMPT_WRITE=""
  if _bash_writes_prompt_surface "$CMD"; then
    BASH_PROMPT_WRITE="yes"
  fi

  if [ "$BASH_PROMPT_WRITE" = "yes" ]; then
    # Resolve prompt_bearing via transcript or slug fallback (mirrors rule (d)).
    _PB_TASK_ID=""
    _PB_TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
    if [ -n "$_PB_TRANSCRIPT" ] && [ -f "$_PB_TRANSCRIPT" ]; then
      _PB_TASK_ID=$(jq -r '
        .message.content // [] |
        .[] | select(.type == "text") | .text // ""
      ' "$_PB_TRANSCRIPT" 2>/dev/null \
        | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)
      case "$_PB_TASK_ID" in ''|*[!0-9]*) _PB_TASK_ID="" ;; esac
    fi
    if [ -z "$_PB_TASK_ID" ] && [ -n "$WORKTREE_ROOT" ]; then
      _PB_SLUG=$(echo "$WORKTREE_ROOT" | sed -E 's|.*/.claude/worktrees/([^/]+)$|\1|')
      if [ -n "$_PB_SLUG" ]; then
        _PB_DB=$(tmb_db_path || true)
        if [ -n "$_PB_DB" ] && tmb_have_sqlite; then
          _SAFE_SLUG=$(tmb_sql_quote "$_PB_SLUG")
          _PB_TASK_ID=$(tmb_sqlite_ro "$_PB_DB" "
            SELECT id FROM tasks
             WHERE branch_id LIKE '%/${_SAFE_SLUG}'
               AND status IN ('pending','running','completed')
             ORDER BY id DESC
             LIMIT 1;
          " 2>/dev/null || true)
          case "$_PB_TASK_ID" in ''|*[!0-9]*) _PB_TASK_ID="" ;; esac
        fi
      fi
    fi
    _PB_ALLOWED=""
    if [ -n "$_PB_TASK_ID" ]; then
      _PB_DB=$(tmb_db_path || true)
      if [ -n "$_PB_DB" ] && tmb_have_sqlite; then
        _PB_VAL=$(tmb_sqlite_ro "$_PB_DB" "
          SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${_PB_TASK_ID} LIMIT 1;
        " 2>/dev/null || echo "0")
        [ "${_PB_VAL:-0}" -eq 1 ] && _PB_ALLOWED="yes"
      fi
    fi
    if [ "$_PB_ALLOWED" != "yes" ]; then
      jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":"BLOCKED: SWE may not write prompt-surface files via Bash (>, >>, tee, sed -i, perl -i, python open w/a, cp/mv/rsync). Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_review_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed."}}'
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
