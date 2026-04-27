#!/usr/bin/env bash
# No-source-edit-from-main hook (#108).
#
# Blocks Edit/Write tool calls when bro mode is active and the target is a
# source-code file outside an SWE worktree. Enforces the "bro never edits
# source code directly" doctrine — every code change goes through SWE.
#
# Block conditions (all must be true):
#   1. Trajectory DB exists (this is a TMB project)
#   2. Bro mode is active (transcript shows prior "Entering bro mode." with
#      no later "exit bro mode" / "stop being bro")
#   3. CWD is NOT inside .claude/worktrees/ (so this is bro, not SWE)
#   4. Target file is NOT in the bro-allowlist (markdown, license, gitignore,
#      git templates, plugin/agent/skill manifests, etc.)
#
# Allow conditions (any one allows):
#   - DB missing (not a TMB project)
#   - No bro mode (regular Claude Code session)
#   - In worktree (SWE legitimately edits source there)
#   - Target is in allowlist (docs / configs that are bro's job)
#
# Bypass: TMB_ALLOW_SOURCE_EDIT=1 (emergency override for hotfixes).

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

if [ "${TMB_ALLOW_SOURCE_EDIT:-0}" = "1" ]; then
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

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi
grep -q 'Entering bro mode.' "$TRANSCRIPT" 2>/dev/null || exit 0
if grep -qiE 'exit bro mode|stop being bro' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

case "$PWD" in
  *.claude/worktrees/*) exit 0 ;;
esac

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

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
  */hooks/hooks.json|hooks/hooks.json) exit 0 ;;
  */agents/*.md|agents/*.md) exit 0 ;;
  */skills/*/SKILL.md|skills/*/SKILL.md) exit 0 ;;
  *.github/*) exit 0 ;;
esac

REASON="BLOCKED: bro is a pure planner — every code change goes through SWE. Target '$TARGET' looks like source code; route via the code-touching ask chain (tmb_planning-simple or tmb_planning-difficult → task_create_batch → spawn SWE in a worktree). For emergency hotfix-style overrides, set TMB_ALLOW_SOURCE_EDIT=1."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
