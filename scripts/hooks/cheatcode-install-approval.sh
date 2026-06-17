#!/usr/bin/env bash
# Hook: PreToolUse approval gate for cheatcode_install.
#
# Installs are human-approved, never silent (docs/architecture/CHEATCODES.md
# "Permission & safety invariants"). This gate blocks the cheatcode_install MCP
# tool unless a per-candidate cheatcode_approved audit record exists for the
# candidate's source_url (recorded by cheatcode_approve). It FAILS CLOSED: if
# the candidate source_url can be resolved but no approval record is found, the
# install is denied.
#
# Fires on: PreToolUse — matcher mcp__.*trajectory-server__cheatcode_install.
#
# Decision logic:
#   1. Tool is not cheatcode_install               → allow (pass-through)
#   2. No DB / no sqlite3 (cannot verify approval)  → DENY (fail closed)
#   3. candidate.source_url missing from tool_input → DENY (cannot key approval)
#   4. matching cheatcode_approved audit row exists → allow
#   5. no approval record                           → DENY with recovery
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
case "${TOOL_NAME:-}" in
  *cheatcode_install*) : ;;
  *) exit 0 ;;
esac

deny() {
  jq -nc --arg reason "$1" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","denyReason":$reason}}'
  exit 0
}

SOURCE_URL=$(echo "$INPUT" | jq -r '.tool_input.candidate.source_url // empty' 2>/dev/null || true)
CAND_NAME=$(echo "$INPUT" | jq -r '.tool_input.candidate.name // empty' 2>/dev/null || true)

if [ -z "$SOURCE_URL" ]; then
  deny "BLOCKED: cheatcode_install requires a candidate.source_url so the per-candidate approval can be verified. Recovery: call cheatcode_install with candidate={name,kind,source_url}."
fi

DB=$(tmb_db_path || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  deny "BLOCKED: cheatcode_install approval cannot be verified (trajectory DB unavailable) — failing closed. Installs are human-approved, never silent."
fi

SAFE_URL=$(tmb_sql_quote "$SOURCE_URL")
APPROVED=$(tmb_sqlite_ro "$DB" "
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'cheatcode_approved'
     AND json_extract(content_json, '\$.source_url') = '${SAFE_URL}'
  LIMIT 1;
" 2>/dev/null || echo "0")

if [ "${APPROVED:-0}" -gt 0 ]; then
  exit 0
fi

deny "BLOCKED: no human-approval record for cheatcode '${CAND_NAME:-$SOURCE_URL}' (${SOURCE_URL}). Installs are human-approved, never silent. Recovery: record approval via cheatcode_approve(agent='bro', candidate={name,kind,source_url}) after the Human confirms, then retry cheatcode_install."
