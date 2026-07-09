#!/usr/bin/env bash
# PreToolUse lint on Edit/Write/MultiEdit/NotebookEdit. Fires only when
# a NEW file is being created (parent doesn't yet contain the basename)
# and emits soft `additionalContext` when the basename violates the
# language convention. Existing files are never re-named by this hook.
#
# Conventions:
#   Python (.py)   → snake_case.py
#   TS/JS module   → kebab-case.ts / .js / .mjs / .cjs
#   React (.tsx/.jsx) basename starting with uppercase → PascalCase.tsx
#   SQL (.sql)     → snake_case.sql
#   Shell (.sh)    → kebab-case.sh
#
# Bypass: TMB_SKIP_NAMING_LINT=1

set -uo pipefail

INPUT=$(cat)

if [ "${TMB_SKIP_NAMING_LINT:-0}" = "1" ]; then exit 0; fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

# Skip files that already exist — naming locks at creation time. Hook is
# advisory on rename / first-introduce, not a license to mass-rename.
[ -e "$TARGET" ] && exit 0

BASENAME=$(basename "$TARGET")
NAME="${BASENAME%.*}"
EXT="${BASENAME##*.}"

# Skip metadata files where the canonical name is fixed by tooling.
case "$BASENAME" in
  __init__.py|__main__.py|conftest.py|setup.py|index.ts|index.tsx|index.js|index.mjs|index.cjs) exit 0 ;;
  CHANGELOG*|LICENSE*|README*|TODO*|NOTICE*|AUTHORS*) exit 0 ;;
  .*) exit 0 ;;
esac

# Skip non-source paths — tests, snapshots, fixtures, generated dirs use
# whatever name their tooling demands.
case "$TARGET" in
  */node_modules/*|*/dist/*|*/build/*|*/.next/*|*/__pycache__/*|*/target/*) exit 0 ;;
  */fixtures/*|*/snapshots/*|*/__snapshots__/*) exit 0 ;;
  */migrations/*) exit 0 ;;
esac

is_snake() { echo "$1" | grep -qE '^[a-z][a-z0-9_]*$'; }
is_kebab() { echo "$1" | grep -qE '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$'; }
is_pascal() { echo "$1" | grep -qE '^[A-Z][A-Za-z0-9]*$'; }

VIOLATION=""

case "$EXT" in
  py|sql)
    is_snake "$NAME" || VIOLATION="$EXT files use snake_case (got '$NAME')"
    ;;
  sh|bash)
    is_kebab "$NAME" || VIOLATION="shell scripts use kebab-case (got '$NAME')"
    ;;
  ts|js|mjs|cjs)
    is_kebab "$NAME" || VIOLATION="$EXT modules use kebab-case (got '$NAME')"
    ;;
  tsx|jsx)
    # React components are PascalCase, route/hook files are kebab-case;
    # accept either since the distinction is content-based.
    if ! is_kebab "$NAME" && ! is_pascal "$NAME"; then
      VIOLATION="$EXT files use kebab-case (route/hook) or PascalCase (component); got '$NAME'"
    fi
    ;;
esac

[ -z "$VIOLATION" ] && exit 0

MSG="naming-lint: $TARGET — $VIOLATION. Set TMB_SKIP_NAMING_LINT=1 to bypass when the project's local convention differs."

jq -nc --arg ctx "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
exit 0
