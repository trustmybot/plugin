#!/usr/bin/env bash
# PostToolUse hook on Read. When bro Reads a file that exists in
# file_registry with summary IS NULL, inject `additionalContext`
# reminding bro to call file_registry_update_summaries before the next
# Read on a tracked file (CLAUDE.md "After Read for context | follow
# with file_registry_update_summaries if summary was null").
#
# Captures L6 scenario 11 — bro reads files for context but skips the
# registry update, leaving summaries stale and forcing future sessions
# to re-Read.
#
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Read" ] || exit 0

# Only fire when target is a regular file path (skip notebook paths /
# image previews / etc.).
TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then DB_PATH="$candidate"; break; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$DB_PATH" ] && DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi
[ -f "$DB_PATH" ] || exit 0

# Convert absolute path → repo-relative if possible. file_registry stores
# repo-relative paths (e.g. 'src/auth.py'). The repos table tells us
# which repo paths bro might be reading under.
REL_PATH=""
REPO_NAME=""
ROW=$(sqlite3 -separator $'\x1f' "$DB_PATH" \
  "SELECT name, path FROM repos ORDER BY length(path) DESC" 2>/dev/null) || ROW=""
if [ -n "$ROW" ]; then
  while IFS=$'\x1f' read -r repo_name repo_path; do
    [ -n "$repo_path" ] || continue
    case "$TARGET" in
      "$repo_path"/*)
        REL_PATH="${TARGET#$repo_path/}"
        REPO_NAME="$repo_name"
        break
        ;;
    esac
  done <<< "$ROW"
fi

# Fall back to the legacy single-repo path (repo='').
if [ -z "$REL_PATH" ]; then
  REL_PATH="$TARGET"
  REPO_NAME=""
fi

NEEDS_SUMMARY=$(sqlite3 "$DB_PATH" \
  "SELECT 1 FROM file_registry WHERE repo='$REPO_NAME' AND path='$(echo "$REL_PATH" | sed "s/'/''/g")' AND (summary IS NULL OR summary = '') LIMIT 1" 2>/dev/null) || NEEDS_SUMMARY=""

[ "$NEEDS_SUMMARY" = "1" ] || exit 0

REASON="📝 file_registry reminder: ${REL_PATH} is tracked but its summary is empty. Per CLAUDE.md \"After Read for context | follow with file_registry_update_summaries if summary was null\", call file_registry_update_summaries(updates=[{path:'${REL_PATH}', summary:'<1-2 line description>'}]) before continuing. Required by the close-time hook anyway."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $reason
  }
}'

exit 0
