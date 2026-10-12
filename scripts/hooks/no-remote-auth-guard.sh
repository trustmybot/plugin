#!/usr/bin/env bash
# PreToolUse hook — deny interactive auth login when no remote is configured.
#
# Blocks `gh auth login` and `glab auth login` (only the `login` subcommand)
# when the current repo's repo_remotes rows (tmb_repo_remotes) carry no non-empty URL.
# Fail-open on any error: missing DB, jq absent, sqlite3 absent → allow.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

[ -n "$CMD" ] || exit 0

# Detect (gh|glab) auth login — the interactive subcommand that hangs without
# TTY/network — as an executable statement (lib/cmd-analysis.sh), never inside
# quoted text or a heredoc. Does NOT match: auth status, auth token, logout.
case "$CMD" in *login*) ;; *) exit 0 ;; esac
MATCHED_TOOL=""
MATCHED_DIR=""
while IFS="$(printf '\t')" read -r dir stmt; do
  case "$stmt" in
    "gh auth login"|"gh auth login "*) MATCHED_TOOL="gh"; MATCHED_DIR="$dir"; break ;;
    "glab auth login"|"glab auth login "*) MATCHED_TOOL="glab"; MATCHED_DIR="$dir"; break ;;
  esac
done < <(tmb_cmd_statements "$CMD" "$(tmb_payload_cwd "$INPUT")")

[ -n "$MATCHED_TOOL" ] || exit 0

# Resolve DB — fail-open on any resolution failure.
DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Read remotes JSON from the login statement's repo (sole source of truth),
# resolved from its effective dir — in a multi-repo workspace $PWD is the
# non-repo workspace root.
_GIT_ROOT=$(tmb_stmt_repo_root "$MATCHED_DIR" "$(tmb_payload_cwd "$INPUT")" 2>/dev/null || true)
REMOTES_JSON=$(tmb_repo_remotes "$DB" "$_GIT_ROOT" 2>/dev/null || true)

# No registered repo resolves → config says nothing → fail-open (allow).
[ -n "$REMOTES_JSON" ] || exit 0

# Check whether any entry has a non-empty url.
HAS_REMOTE=$(printf '%s' "$REMOTES_JSON" | \
  jq -r '[.[]|select(.url!=null and .url!="")]|length>0' 2>/dev/null || true)

# jq errors → fail-open.
[ -n "$HAS_REMOTE" ] || exit 0

# A usable remote exists → allow.
[ "$HAS_REMOTE" = "false" ] || exit 0

REASON="BLOCKED: No remote is configured (remotes have no URL) — TMB is operating locally. Interactive '${MATCHED_TOOL} auth login' will hang here (no TTY/network); remote/push ops are skipped. Work locally."

jq -nc --arg reason "$REASON" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
