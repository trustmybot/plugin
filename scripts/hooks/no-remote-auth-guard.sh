#!/usr/bin/env bash
# PreToolUse hook — deny interactive auth login when no remote is configured.
#
# Blocks `gh auth login` and `glab auth login` (only the `login` subcommand)
# when the current repo's repos.remotes contains no entry with a non-empty URL.
# Fail-open on any error: missing DB, jq absent, sqlite3 absent → allow.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

[ -n "$CMD" ] || exit 0

# Detect (gh|glab) auth login — the interactive subcommand that hangs without
# TTY/network. Matches: gh auth login, glab auth login, with optional flags
# between words. Does NOT match: auth status, auth token, auth logout, etc.
MATCHED_TOOL=""
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])gh[[:space:]]+auth[[:space:]]+login([[:space:]]|$|;|&&|\|\||\))'; then
  MATCHED_TOOL="gh"
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:];|&(])glab[[:space:]]+auth[[:space:]]+login([[:space:]]|$|;|&&|\|\||\))'; then
  MATCHED_TOOL="glab"
fi

[ -n "$MATCHED_TOOL" ] || exit 0

# Resolve DB — fail-open on any resolution failure.
DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
tmb_have_sqlite || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Read remotes JSON from the command's repo (sole source of truth). Resolve the
# repo from the command's `cd <repo> &&` / `git -C <repo>` target, not $PWD — in
# a multi-repo workspace $PWD is the non-repo workspace root.
_CMD_CWD=$(tmb_cmd_cwd "$CMD" "$INPUT" 2>/dev/null || true)
_GIT_ROOT=$(tmb_repo_git_root "$_CMD_CWD" 2>/dev/null || true)
REMOTES_JSON=$(tmb_repo_remotes "$DB" "$_GIT_ROOT" 2>/dev/null || true)

# No remotes key at all → config says nothing → fail-open (allow).
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
