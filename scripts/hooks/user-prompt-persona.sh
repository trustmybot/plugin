#!/usr/bin/env bash
# UserPromptSubmit hook — the fallback for bro's persona. When this session has
# no persona marker (<project>/.claude/<plugin>/sessions/<session_id>.persona,
# written by session-start-persona.sh), as after the plugin's hooks are
# reloaded mid-session, it injects the same context once and
# writes the marker. When the plugin's CLAUDE.md cannot be read it shows the
# Human a plain notice to start a new session instead, once per session.
#
# Silent when the session already has the marker, the payload has no usable
# session_id, or the project root is the plugin root. Never writes the
# project's CLAUDE.md; always exits 0.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/persona.sh
. "$SCRIPT_DIR/lib/persona.sh" || exit 0

INPUT=$(cat 2>/dev/null || true)
SESSION_ID=$(persona_session_id "$INPUT")
[ -n "$SESSION_ID" ] || exit 0
persona_init || exit 0
[ -e "$(persona_marker "$SESSION_ID" persona)" ] && exit 0

if CONTEXT=$(persona_context); then
  persona_emit UserPromptSubmit "$CONTEXT"
  persona_mark "$SESSION_ID" persona
  exit 0
fi

[ -e "$(persona_marker "$SESSION_ID" persona-notice)" ] && exit 0
printf '%s\n' '{"systemMessage":"TMB could not read the plugin CLAUDE.md that carries bro'"'"'s persona, so this session runs without it. Start a new Claude Code session to load it."}'
persona_mark "$SESSION_ID" persona-notice
exit 0
