#!/usr/bin/env bash
# SessionStart hook — probes required host binaries and emits a loud
# TMB-DEGRADED banner into additionalContext when any are missing.
# Also emits a calm offline note when no remote has a usable URL.
#
# Healthy path (all 4 present, remote configured): exits 0, emits nothing.
# Degraded path (any missing):  emits hookSpecificOutput.additionalContext
#   beginning "TMB DEGRADED:" naming each missing binary and consequence.
# No-remote path: emits a calm offline note (even when binaries are healthy).
# Both degraded AND offline: includes both notes in one additionalContext.
#
# Self-contained: JSON is built with printf, NOT jq — jq may itself be missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MISSING_PARTS=""

_check() {
  local bin="$1"
  local consequence="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [ -n "$MISSING_PARTS" ]; then
      MISSING_PARTS="${MISSING_PARTS}; "
    fi
    MISSING_PARTS="${MISSING_PARTS}missing ${bin} — ${consequence}"
  fi
}

_check jq      "most PreToolUse gates and the bro/swe doctrine hooks are inoperative"
_check sqlite3 "task/spawn gates cannot verify state"
_check git     "branch guards and commit-message lint are inoperative"
_check node    "MCP trajectory-server and scan tooling cannot start"

# Detect local-only mode: no remote with a non-empty url in the current repo's
# repos.remotes (#980 — the sole source of truth, resolved per repo).
OFFLINE_NOTE=""
if command -v sqlite3 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  # shellcheck source=scripts/hooks/lib/query-task.sh
  . "$SCRIPT_DIR/lib/query-task.sh"
  # shellcheck source=scripts/hooks/lib/resolve-repo.sh
  . "$SCRIPT_DIR/lib/resolve-repo.sh"
  _DB=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$_DB" ]; then
    _GIT_ROOT=$(tmb_repo_git_root "$PWD" 2>/dev/null || true)
    _REMOTES_JSON=$(tmb_repo_remotes "$_DB" "$_GIT_ROOT" 2>/dev/null || true)
    if [ -n "$_REMOTES_JSON" ]; then
      _HAS_REMOTE=$(printf '%s' "$_REMOTES_JSON" | \
        jq -r '[.[]|select(.url!=null and .url!="")]|length>0' 2>/dev/null || true)
      if [ "$_HAS_REMOTE" = "false" ]; then
        OFFLINE_NOTE="TMB: operating locally — no remote configured; remote/push ops are skipped."
      fi
    fi
  fi
fi

[ -z "$MISSING_PARTS" ] && [ -z "$OFFLINE_NOTE" ] && exit 0

CONTEXT=""
if [ -n "$MISSING_PARTS" ]; then
  CONTEXT="TMB DEGRADED: ${MISSING_PARTS}. Install the missing tools to restore enforcement."
fi
if [ -n "$OFFLINE_NOTE" ]; then
  if [ -n "$CONTEXT" ]; then
    CONTEXT="${CONTEXT} ${OFFLINE_NOTE}"
  else
    CONTEXT="$OFFLINE_NOTE"
  fi
fi

# Escape for JSON string using bash substitutions only — no sed/awk required
# (those tools may also be absent from PATH). Backslashes first, then quotes.
ESCAPED="${CONTEXT//\\/\\\\}"
ESCAPED="${ESCAPED//\"/\\\"}"

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ESCAPED"
