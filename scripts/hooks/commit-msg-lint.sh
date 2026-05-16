#!/usr/bin/env bash
# PreToolUse lint on Bash for `git commit -m <msg>`. Validates the
# Conventional-Commits-with-emoji format that the retired
# tmb_git-conventions skill described:
#
#   <emoji> <type>(<optional-scope>): <one-line description>
#
# Allowed types: feat, fix, refactor, docs, test, perf, chore, build,
#                ci, style, revert, schema (TMB-specific for DDL changes).
#
# Soft-warn via `additionalContext` — does not block the commit. Bypass:
# TMB_SKIP_COMMIT_MSG_LINT=1, or run a real `commit-msg` git hook for
# hard enforcement.

set -uo pipefail

INPUT=$(cat)

if [ "${TMB_SKIP_COMMIT_MSG_LINT:-0}" = "1" ]; then exit 0; fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$CMD" ] || exit 0

# Only fire on `git commit` lines (handle `git -C path commit` too).
case "$CMD" in
  *"git commit "*|*"git -C "*" commit "*) ;;
  *) exit 0 ;;
esac

# Skip merge / amend / fixup / squash — those have their own message rules.
case "$CMD" in
  *" --amend"*|*" --no-edit"*|*" --fixup"*|*" --squash"*|*" --merge"*) exit 0 ;;
esac

# Extract the -m / --message argument.
MSG=$(printf '%s' "$CMD" | sed -nE "s/.*-m[[:space:]]+['\"]([^'\"]+)['\"].*/\1/p")
if [ -z "$MSG" ]; then
  MSG=$(printf '%s' "$CMD" | sed -nE "s/.*--message[[:space:]]*[=]?[[:space:]]*['\"]([^'\"]+)['\"].*/\1/p")
fi

# HEREDOC commits (`-m "$(cat <<EOF ... EOF)"`) are common in the project's
# own workflow; we can't see the rendered body from the command string, so
# skip those rather than false-warn.
if echo "$CMD" | grep -qE '<<-?\s*[A-Za-z]+'; then exit 0; fi
if [ -z "$MSG" ]; then exit 0; fi

FIRST_LINE=$(printf '%s' "$MSG" | head -n 1)

VIOLATION=""

# Conventional Commits with emoji prefix: <emoji> <type>(<scope>)?: <subject>.
# Emoji-detection is byte-based (any UTF-8 multi-byte sequence at offset 0)
# rather than regex-ranged so macOS grep doesn't choke on locale ranges.
TYPES='feat|fix|refactor|docs|test|perf|chore|build|ci|style|revert|schema'

PREFIX=$(printf '%s' "$FIRST_LINE" | awk '{print $1}')
REST=$(printf '%s' "$FIRST_LINE" | awk '{$1=""; sub(/^[[:space:]]+/, ""); print}')

prefix_ok=
if printf '%s' "$PREFIX" | grep -qE '^:[a-z0-9_+-]+:$'; then
  prefix_ok=1
elif printf '%s' "$PREFIX" | LC_ALL=C grep -qE '[^[:print:][:space:]]'; then
  # Any high byte at the start = literal emoji.
  prefix_ok=1
fi

rest_ok=
if printf '%s' "$REST" | grep -qE "^($TYPES)(\\([a-z0-9._/-]+\\))?:[[:space:]].+"; then
  rest_ok=1
fi

if [ -z "$prefix_ok" ] || [ -z "$rest_ok" ]; then
  VIOLATION="commit subject does not match '<emoji> <type>(<scope>): <description>' (allowed types: $TYPES)"
fi

# Subject line ≤72 chars is the conventional cap; bytes ≠ chars under
# multi-byte emoji, so use wc -m for char count.
SUBJ_LEN=$(printf '%s' "$FIRST_LINE" | wc -m | tr -d ' ')
if [ -z "$VIOLATION" ] && [ "$SUBJ_LEN" -gt 72 ]; then
  VIOLATION="commit subject is $SUBJ_LEN chars (>72)"
fi

[ -z "$VIOLATION" ] && exit 0

MSG_OUT="commit-msg-lint: $VIOLATION. Subject seen: \"$FIRST_LINE\". Set TMB_SKIP_COMMIT_MSG_LINT=1 to bypass."

jq -nc --arg ctx "$MSG_OUT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
exit 0
