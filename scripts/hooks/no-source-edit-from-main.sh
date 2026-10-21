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
#   Enforcement surfaces (scripts/hooks/, hooks/hooks.json) of the plugin's own
#   source repo (target git root has a .claude-plugin/plugin.json named like the
#   running plugin) are ALWAYS denied from main, even for swe — they sit above
#   the swe permit and are never re-opened. In any other repo those paths follow
#   the ordinary rules.
#   Managed-repo scope: in a multi-repo workspace Rule 1 only guards a REGISTERED
#   product repo; absolute targets whose git-root is an unregistered sibling repo
#   are allowed. A single-repo project's sole registered repo IS the root, so the
#   whole tree is guarded.
#
# Rule 2 — Bash write-form targeting a prompt surface from main checkout:
#   Denied for every agent identity (bro, subagent, swe, unknown) when outside a
#   worktree. Written paths: tmb_cmd_write_paths and prompt surfaces:
#   tmb_is_prompt_surface_path (lib/cmd-analysis.sh, shared with
#   swe-boundary.sh). Reads are never tripped.
#   Sanctioned route: spawn an SWE task (prompt_bearing=1 for prompt edits).
#
# Bypass: TMB_ALLOW_SOURCE_EDIT=1 (emergency override for hotfixes — rule 1 only).

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh disable=SC1091
. "$PLUGIN_ROOT/scripts/hooks/lib/cmd-analysis.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh disable=SC1091
. "$PLUGIN_ROOT/scripts/hooks/lib/resolve-repo.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
AGENT_TYPE=$(tmb_agent_role "$INPUT")

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

  # Worktree exemption: allow only when the WRITE TARGET (destination token)
  # lives inside a worktree — not merely because the command string mentions a
  # worktree path anywhere (#1031). The old whole-command test exempted
  # `sed '...' .claude/worktrees/x/agents/a.md > agents/a.md`, which reads from a
  # worktree but WRITES a prompt surface in the main checkout.
  # The project's own path never counts: a project checked out under some
  # .claude/worktrees/<n> is still the main checkout (GH 1550).
  _PROJ=$(tmb_project_root)
  _PROJ_REAL=$(tmb_realdir "$_PROJ")
  _token_in_worktree() {
    local p="$1" root
    for root in "$_PROJ" "$_PROJ_REAL"; do
      [ -n "$root" ] || continue
      case "$p" in "$root"/*) p="${p#"$root"/}"; break ;; esac
    done
    case "$p" in
      */.claude/worktrees/*|.claude/worktrees/*) return 0 ;;
    esac
    return 1
  }

  # Destination-coupled matching on the command's executable skeleton
  # (tmb_cmd_write_paths, the shared list of write shapes; a target behind an
  # unresolvable variable is judged as written). A prompt-surface path inside
  # quoted text or a data heredoc is data. Exempt only when the WRITE DESTINATION is inside a
  # worktree (#1031) — not when the command merely reads from one.
  _BASH_DEST_TOK=""
  while IFS= read -r _wpath; do
    _wpath="${_wpath#UNRESOLVED:*:}"
    if tmb_is_prompt_surface_path "$_wpath" && ! _token_in_worktree "$_wpath"; then
      _BASH_DEST_TOK="$_wpath"
      break
    fi
  done < <(tmb_cmd_write_paths "$CMD" "$(tmb_payload_cwd "$INPUT")")
  if [ -n "$_BASH_DEST_TOK" ]; then
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

DB_PATH=$(tmb_db_path) || exit 0

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

# Worktree exemption: any write whose target path lives inside
# `.claude/worktrees/<slug>/...` is a legitimate SWE edit in its task
# worktree — allow regardless of agent identity. This is a target-path
# check, never a cwd check: CC subagents inherit the parent's cwd (GH 1550).
case "$TARGET" in
  */.claude/worktrees/*|.claude/worktrees/*) exit 0 ;;
esac

# Sanctioned scratch: `.claude/tmb/scratch/` is TMB's own scratch dir, never
# source. A `..` in the path could climb out of it, and a scratch dir inside
# an enforcement surface is that surface, so both stay guarded.
case "$TARGET" in
  */../*|../*|*/..|*/scripts/hooks/*|scripts/hooks/*) ;;
  */.claude/tmb/scratch/*|.claude/tmb/scratch/*) exit 0 ;;
esac

if [ "$(tmb_db_state)" = "error" ]; then
  tmb_deny_db_unavailable no-source-edit-from-main
  exit 0
fi

# Managed-repo scope by REGISTRATION (#693, ADR: path-keyed repo resolution):
# in a multi-repo workspace Rule 1 must only guard a REGISTERED product repo,
# not its siblings. Resolve the target's git-root and enforce iff that root is a
# `repos` row (matched by path); an absolute target whose git-root is an
# unregistered sibling tree is outside Rule 1 scope (exit 0). An absolute target
# whose existing directory sits inside no git repository (the session
# scratchpad, a tmp dir) cannot be a registered-repo source edit and is also
# outside scope (exit 0). A target whose parent directory is absent fails closed,
# and a resolvable git-root that IS a `repos` row (including a single-repo
# project whose sole repo is the root) is guarded as before.
case "$TARGET" in
  /*)
    TARGET_DIR=$(dirname "$TARGET")
    # Only consult registration when the target's directory actually exists;
    # a target whose parent dir is absent fails closed (guarded).
    if tmb_have_sqlite && [ -d "$TARGET_DIR" ]; then
      TARGET_GIT_ROOT=$(tmb_repo_git_root "$TARGET_DIR")
      if [ -n "$TARGET_GIT_ROOT" ]; then
        if [ "$(tmb_gate_read "$DB_PATH" "SELECT COUNT(*) FROM repos;")" = "__ERR__" ]; then
          tmb_deny_db_unavailable no-source-edit-from-main
          exit 0
        fi
        [ -n "$(tmb_repo_name_for_root "$DB_PATH" "$TARGET_GIT_ROOT")" ] || exit 0   # unregistered sibling repo — outside Rule 1 scope
      else
        exit 0   # directory in no git repository — outside Rule 1 scope
      fi
    fi
    ;;
esac

# _target_is_plugin_source_repo: succeeds when the target's git root carries a
# .claude-plugin/plugin.json whose name equals the running plugin's manifest name.
# A missing or unreadable manifest on either side means "not the plugin repo".
_target_is_plugin_source_repo() {
  local running_manifest="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/.claude-plugin/plugin.json"
  local start git_root running_name repo_name
  case "$TARGET" in
    /*)
      start=$(dirname "$TARGET")
      while [ ! -d "$start" ] && [ "$start" != "/" ]; do start=$(dirname "$start"); done
      ;;
    *) start=$(dirname "$(tmb_payload_cwd "$INPUT")/$TARGET") ;;
  esac
  git_root=$(tmb_repo_git_root "$start")
  [ -n "$git_root" ] || return 1
  [ -f "$running_manifest" ] && [ -f "$git_root/.claude-plugin/plugin.json" ] || return 1
  running_name=$(jq -r '.name // empty' "$running_manifest" 2>/dev/null)
  repo_name=$(jq -r '.name // empty' "$git_root/.claude-plugin/plugin.json" 2>/dev/null)
  [ -n "$running_name" ] && [ "$running_name" = "$repo_name" ]
}

# Enforcement surfaces of the plugin's own source repo: deny before any
# allowlist entry is evaluated. No pattern — including *.md or docs/ — can
# re-open these paths from the main checkout. Route all edits through a
# worktree (spawn SWE). Any other repo's scripts/hooks/ follows the ordinary rules.
case "$TARGET" in
  */scripts/hooks/*|scripts/hooks/*|*/hooks/hooks.json|hooks/hooks.json)
    if _target_is_plugin_source_repo; then
      REASON="BLOCKED: enforcement surfaces (scripts/hooks/ and hooks/hooks.json) of the plugin's own source repo are only editable through task worktrees — spawn an SWE task. Main-checkout edits to these paths are denied regardless of file type."
      jq -nc --arg reason "$REASON" '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: $reason
        }
      }'
      exit 0
    fi
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

REASON="BLOCKED: source edits from the main checkout are denied. Normal route: use tmb_planning → task_create_batch to spawn SWE in an isolated worktree. If the worktree-create step failed (e.g. WorktreeCreate input had no .branch field), SWE running with agent_type='swe' is auto-permitted to edit in-place (non-isolated mode). For a bro emergency hotfix, set TMB_ALLOW_SOURCE_EDIT=1 in the PROCESS environment at launch time — setting it in a shell rc file has no effect on an already-running session. Scratch scripts and notes belong in .claude/tmb/scratch/ (or /tmp/claude-<uid>), which are always writable."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
