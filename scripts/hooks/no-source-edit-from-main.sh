#!/usr/bin/env bash
# No-source-edit-from-main hook (#108, updated #467, #502, #547).
#
# Rule 1 — Edit/Write to source code from main checkout:
#   Block conditions (all must be true):
#   1. Trajectory DB exists (this is a TMB project)
#   2. Target file is NOT inside .claude/worktrees/ (so this is not an isolated SWE)
#   3. Target file is NOT in the docs/templates/config allowlist
#   4. Normalized agent role is NOT 'swe' (non-isolated SWE first-class permit)
#   Allow conditions (any one allows):
#   - DB missing (not a TMB project)
#   - Target is inside .claude/worktrees/<slug>/... (SWE legitimately edits source there)
#   - Target is in allowlist (docs / configs that are fine to edit from main)
#   - Normalized agent role == 'swe' (non-isolated SWE running in main checkout)
#   Enforcement surfaces (scripts/hooks/, hooks/hooks.json) are ALWAYS denied from
#   main, even for swe — they sit above the swe permit and are never re-opened.
#   Managed-repo scope: in a multi-repo workspace Rule 1 only guards the managed
#   product repo (plugin_config tmb_default_repo); absolute targets in sibling
#   repos are allowed. Empty/'.' tmb_default_repo guards the whole tree (the
#   normal single-repo user project).
#
# Rule 2 — Bash write-form targeting a prompt surface from main checkout:
#   Denied for every agent identity (bro, subagent, swe, unknown) when outside a
#   worktree. Write-forms: >, >>, tee, sed -i, perl -i, python open w/a, cp/mv/rsync.
#   Prompt surfaces: agents/*.md, skills/*/SKILL.md, commands/*.md,
#   templates/*.md, CLAUDE.md, CODEX.md, CURSOR.md, GEMINI.md.
#   Reads (cat/grep/sed -n) are never tripped.
#   Sanctioned route: spawn an SWE task (prompt_bearing=1 for prompt edits).
#
# Bypass: TMB_ALLOW_SOURCE_EDIT=1 (emergency override for hotfixes — rule 1 only).

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$PLUGIN_ROOT/scripts/hooks/lib/normalize-role.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")

case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

if [ "${TMB_ALLOW_SOURCE_EDIT:-0}" = "1" ] && [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# ---- Rule 2 (Bash): write-form targeting a prompt surface -------------------
# Applies before the DB check — this rule does not require a TMB project.
# Denied for every agent identity when the target is NOT inside a worktree.
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)

  # Worktree exemption: if the command is operating inside a worktree, allow.
  _main_bash_in_worktree() {
    local cmd="$1"
    case "$cmd" in
      */.claude/worktrees/*|*.claude/worktrees/*) return 0 ;;
    esac
    return 1
  }

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

  # _main_bash_writes_prompt_surface: destination-coupled matching.
  # The verb/redirect operator must be adjacent to the prompt-surface path token.
  _main_bash_writes_prompt_surface() {
    local cmd="$1"

    # --- Redirect forms: > <dest> or >> <dest> ---
    local after_redir=""
    case "$cmd" in
      *">>"*)
        after_redir="${cmd##*>>}"
        after_redir="${after_redir#"${after_redir%%[! ]*}"}"
        local dest_tok="${after_redir%% *}"
        _is_prompt_surface_token "$dest_tok" && return 0
        ;;
    esac
    case "$cmd" in
      *">"*)
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
    local tee_rest=""
    case "$cmd" in
      *" tee "*|*" tee	"*|"tee "*)
        case "$cmd" in
          *" tee "*) tee_rest="${cmd##* tee }" ;;
          "tee "*) tee_rest="${cmd#tee }" ;;
        esac
        case "$tee_rest" in
          "-a "*) tee_rest="${tee_rest#-a }" ;;
        esac
        local tee_dest="${tee_rest%% *}"
        _is_prompt_surface_token "$tee_dest" && return 0
        ;;
    esac

    # --- sed -i: file is the last token after sed -i ---
    case "$cmd" in
      *"sed -i"*|*"sed --in-place"*)
        local after_sedi=""
        case "$cmd" in
          *"sed --in-place"*) after_sedi="${cmd##*sed --in-place}" ;;
          *"sed -i"*) after_sedi="${cmd##*sed -i}" ;;
        esac
        local sedi_file="${after_sedi##* }"
        _is_prompt_surface_token "$sedi_file" && return 0
        ;;
    esac

    # --- perl -i: file is the last token after perl -i ---
    case "$cmd" in
      *"perl -i"*)
        local after_perli="${cmd##*perl -i}"
        local perli_file="${after_perli##* }"
        _is_prompt_surface_token "$perli_file" && return 0
        ;;
    esac

    # --- python/python3 open(<path>, 'w'|'a'): path inside open() ---
    case "$cmd" in
      *"python"*"open("*"'w'"*|*"python"*"open("*'"w"'*|*"python"*"open("*"'a'"*|*"python"*"open("*'"a"'*)
        local open_arg="${cmd##*open(}"
        local open_path="${open_arg%%,*}"
        open_path="${open_path#\'}"
        open_path="${open_path%\'}"
        open_path="${open_path#\"}"
        open_path="${open_path%\"}"
        _is_prompt_surface_token "$open_path" && return 0
        ;;
    esac

    # --- cp/mv/rsync: destination is the LAST argument ---
    case "$cmd" in
      "cp "*|*" cp "*|"mv "*|*" mv "*|"rsync "*|*" rsync "*)
        local copy_last="${cmd##* }"
        _is_prompt_surface_token "$copy_last" && return 0
        ;;
    esac

    return 1
  }

  if ! _main_bash_in_worktree "$CMD" \
      && _main_bash_writes_prompt_surface "$CMD"; then
    BASH_DENY_REASON="BLOCKED: Bash write-forms targeting prompt-surface files (agents/*.md, skills/*/SKILL.md, commands/*.md, templates/*.md, CLAUDE.md, CODEX/CURSOR/GEMINI.md) are denied from the main checkout for every agent identity. Sanctioned route: spawn an SWE task (prompt_bearing=1) for intentional prompt edits. Reads (cat/grep/sed -n) are always allowed."
    jq -nc --arg reason "$BASH_DENY_REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
  fi

  exit 0
fi

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

# Worktree exemption: any write whose target path lives inside
# `.claude/worktrees/<slug>/...` is a legitimate SWE edit in its task
# worktree — allow regardless of agent identity. This MUST be a
# target-path check, not a $PWD check: CC subagents inherit the parent's
# CWD, so $PWD is always the project root for every hook invocation
# (the previous $PWD-based check never matched and silently blocked SWE).
case "$TARGET" in
  */.claude/worktrees/*|.claude/worktrees/*) exit 0 ;;
esac

# Managed-repo scope (#592): in a multi-repo workspace, Rule 1 must only guard
# the managed product repo (plugin_config tmb_default_repo), not its siblings.
# tmb_default_repo is the repo NAME, so the managed root is resolved by a
# path-keyed lookup against repos.path (the canonical absolute path set by scan)
# rather than string-joining the workspace root with the name — that join
# mis-scopes single-repo-at-root layouts (where the git repo IS the workspace
# root) one level too deep, leaking the whole tree as a "sibling". Both the
# resolved MANAGED_ROOT and the absolute target are realpath-normalized before
# the enclosure test (handles /tmp->/private/tmp symlinks and trailing slashes).
# Fail-closed: if the repos.path lookup is empty (repo name not found), the whole
# tree is guarded — the same as an empty/'.' tmb_default_repo (single-repo user
# project). Only a resolved MANAGED_ROOT plus a target outside it allows a
# sibling-repo edit.
_realpath() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$1" 2>/dev/null || printf '%s' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}
DEFAULT_REPO=""
if command -v sqlite3 >/dev/null 2>&1; then
  DEFAULT_REPO=$(sqlite3 -readonly -cmd '.timeout 500' "$DB_PATH" \
    "SELECT json_extract(value_json, '\$') FROM plugin_config WHERE key='tmb_default_repo' LIMIT 1;" \
    2>/dev/null || true)
fi
if [ -n "$DEFAULT_REPO" ] && [ "$DEFAULT_REPO" != "." ]; then
  case "$TARGET" in
    /*)
      MANAGED_ROOT=""
      if command -v sqlite3 >/dev/null 2>&1; then
        MANAGED_ROOT=$(sqlite3 -readonly -cmd '.timeout 500' "$DB_PATH" \
          "SELECT path FROM repos WHERE name='$(printf '%s' "$DEFAULT_REPO" | sed "s/'/''/g")' LIMIT 1;" \
          2>/dev/null || true)
      fi
      if [ -n "$MANAGED_ROOT" ]; then
        MANAGED_ROOT=$(_realpath "$MANAGED_ROOT")
        TARGET_REAL=$(_realpath "$TARGET")
        case "$TARGET_REAL" in
          "$MANAGED_ROOT"/*) : ;;       # inside the managed repo — keep guarding
          *) exit 0 ;;                  # sibling repo — outside Rule 1 scope
        esac
      fi
      ;;
  esac
fi

# Enforcement surfaces: deny before any allowlist entry is evaluated.
# No pattern — including *.md or docs/ — can re-open these paths from
# the main checkout. Route all edits through a worktree (spawn SWE).
case "$TARGET" in
  */scripts/hooks/*|scripts/hooks/*|*/hooks/hooks.json|hooks/hooks.json)
    REASON="BLOCKED: enforcement surfaces (scripts/hooks/ and hooks/hooks.json) are only editable through task worktrees — spawn an SWE task. Main-checkout edits to these paths are denied regardless of file type."
    jq -nc --arg reason "$REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
    ;;
esac

BASENAME=$(basename "$TARGET")

case "$TARGET" in
  *.md|*.markdown|*.txt|*.rst) exit 0 ;;
  */docs/*|docs/*) exit 0 ;;
  */templates/*|templates/*) exit 0 ;;
esac

case "$BASENAME" in
  LICENSE|LICENSE.*|.gitignore|.gitattributes|.editorconfig|.npmignore|.dockerignore) exit 0 ;;
  CHANGELOG|CHANGELOG.md|README|README.md) exit 0 ;;
esac

case "$TARGET" in
  *.claude-plugin/plugin.json|*.claude-plugin/marketplace.json) exit 0 ;;
  */agents/*.md|agents/*.md) exit 0 ;;
  */skills/*/SKILL.md|skills/*/SKILL.md) exit 0 ;;
  *.github/*) exit 0 ;;
esac

# Non-isolated SWE permit: a genuine SWE role editing source from the main
# checkout (non-isolated mode) is allowed. This fires AFTER the worktree allow,
# AFTER the enforcement-surface denies, and AFTER the docs/allowlist allows —
# so enforcement surfaces (scripts/hooks/, hooks/hooks.json) remain
# worktree-only even for swe, and bro/unknown/absent roles still fail closed.
if [ "$AGENT_TYPE" = "swe" ]; then exit 0; fi

REASON="BLOCKED: source edits from the main checkout are denied. Normal route: use tmb_planning → task_create_batch to spawn SWE in an isolated worktree. If the worktree-create step failed (e.g. WorktreeCreate input had no .branch field), SWE running with agent_type='swe' is auto-permitted to edit in-place (non-isolated mode). For a bro emergency hotfix, set TMB_ALLOW_SOURCE_EDIT=1 in the PROCESS environment at launch time — setting it in a shell rc file has no effect on an already-running session."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
