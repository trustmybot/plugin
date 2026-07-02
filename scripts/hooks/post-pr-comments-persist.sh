#!/usr/bin/env bash
# PostToolUse hook on pr_monitor_comments_get. Persists each returned comment as a
# discussion_append row automatically, so bro doesn't need to loop through
# and call discussion_append for each comment manually.
#
# Doctrine: "After A, also do B" — the discussion_append after pr_monitor_comments_get
# is a fixed side-effect with no judgment component. PostToolUse is the right
# mechanism (DETERMINISM.md mech 4).
#
# Output shape expected from pr_monitor_comments_get:
#   { "comments": [ { "number": N, "author": "...", "body": "...", "pr_number": N, "is_resolved": bool } ] }
#
# This hook writes a discussion row per comment using sqlite3 directly (the
# hook environment has no MCP access). If TRAJECTORY_DB_PATH is unset or
# sqlite3 is unavailable, the hook exits silently — bro falls back to the
# manual loop.
#
# Bypass: TMB_SKIP_PR_COMMENTS_PERSIST=1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

if [ "${TMB_SKIP_PR_COMMENTS_PERSIST:-0}" = "1" ]; then
  exit 0
fi

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
echo "$TOOL_NAME" | grep -q 'pr_monitor_comments_get' || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] || exit 0
[ -f "$DB" ] || exit 0

# Extract the output from the tool result.
# CC delivers MCP results as .tool_response.content[0].text; keep .output for the test harness.
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response.content[0].text // .tool_response.output // .output // ""' 2>/dev/null)
[ -n "$TOOL_OUTPUT" ] || exit 0

COMMENTS=$(echo "$TOOL_OUTPUT" | jq -c '.comments // [] | .[]' 2>/dev/null) || exit 0
[ -n "$COMMENTS" ] || exit 0

# PR number: prefer the tool_input args (authoritative), fall back to the
# tool_response payload for the harness. Integer-validated so interpolation is safe.
PR_NUMBER=$(echo "$INPUT" | jq -r '.tool_input.pr_number // empty' 2>/dev/null)
[ -n "$PR_NUMBER" ] || PR_NUMBER=$(echo "$TOOL_OUTPUT" | jq -r '.pr_number // empty' 2>/dev/null)
case "$PR_NUMBER" in
  ''|*[!0-9]*) exit 0 ;;
esac

REPO=$(echo "$INPUT" | jq -r '.tool_input.repo // empty' 2>/dev/null)
REPO_ESC=$(printf '%s' "$REPO" | sed "s/'/''/g")

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)

# Resolve the carrier issue from the PR (pr_number [+ repo]) — NOT the git branch
# (#1024). `git rev-parse --abbrev-ref HEAD` from the main checkout returns the
# base branch (dev/main), which never matches a feature task's branch_id, so the
# hook silently dropped every comment; worse, the branch was interpolated raw
# into SQL (an injection sink). pr_review_runs is the pr_number-keyed link to a
# task; PR_NUMBER is integer-validated and REPO is sed-escaped like AUTHOR/BODY.
if [ -n "$REPO" ]; then
  REPO_CLAUSE="AND r.repo = '${REPO_ESC}'"
else
  REPO_CLAUSE=""
fi
ISSUE_ID=$(sqlite3 "$DB" \
  "SELECT t.issue_id
     FROM pr_review_runs r
     JOIN tasks t ON t.id = r.task_id
    WHERE r.pr_number = ${PR_NUMBER} ${REPO_CLAUSE}
      AND t.status NOT IN ('closed','failed')
    ORDER BY r.id DESC LIMIT 1" \
  2>/dev/null || true)
[ -n "$ISSUE_ID" ] || exit 0

echo "$COMMENTS" | while IFS= read -r comment; do
  AUTHOR=$(echo "$comment" | jq -r '.author // "unknown"' 2>/dev/null)
  BODY=$(echo "$comment" | jq -r '.body // ""' 2>/dev/null)
  [ -n "$BODY" ] || continue

  NOTE_BODY="[PR #${PR_NUMBER} comment by ${AUTHOR}] ${BODY}"
  # Escape single quotes for SQLite by doubling them (''). bash pattern
  # substitution emits backslash-quote here, which SQLite does NOT treat as an
  # escape — the literal stays open and the INSERT is silently dropped (#274).
  # sed "s/'/''/g" is the correct, codebase-standard escape.
  NOTE_BODY_ESC=$(printf '%s' "$NOTE_BODY" | sed "s/'/''/g")
  AUTHOR_ESC=$(printf '%s' "$AUTHOR" | sed "s/'/''/g")

  sqlite3 "$DB" \
    "INSERT OR IGNORE INTO discussions (issue_id, author, kind, body, created_at)
     VALUES (${ISSUE_ID}, '${AUTHOR_ESC}', 'note', '${NOTE_BODY_ESC}', '${NOW}')" \
    2>/dev/null || true
done

exit 0
