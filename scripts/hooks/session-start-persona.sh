#!/usr/bin/env bash
# SessionStart hook — delivers bro's persona. Claude Code never loads a
# plugin's CLAUDE.md, so on every source (startup, resume, clear, compact) this
# emits $CLAUDE_PLUGIN_ROOT/CLAUDE.md as `additionalContext` (raw text when jq
# is missing) behind one header line, plus a one-line note when the project's
# CLAUDE.md still holds a tmb:persona block from an older /onboard. Then it
# writes the session marker <project>/.claude/<plugin>/sessions/<session_id>.persona
# that user-prompt-persona.sh checks.
#
# Silent when the project root is the plugin root (Claude Code already loads
# that CLAUDE.md) or the plugin's CLAUDE.md cannot be read. Never writes the
# project's CLAUDE.md; always exits 0.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/persona.sh
. "$SCRIPT_DIR/lib/persona.sh" || exit 0

INPUT=$(cat 2>/dev/null || true)
persona_init || exit 0
CONTEXT=$(persona_context) || exit 0
persona_emit SessionStart "$CONTEXT"
persona_mark "$(persona_session_id "$INPUT")" persona
exit 0
