#!/usr/bin/env bash
# Tests for scripts/hooks/post-pr-comments-persist.sh
#
# Hook contract: on a pr_comments_get PostToolUse, persist each returned comment
# as a discussions row via sqlite3. The regression under test (#274): a comment
# body containing a single quote must still persist — bash pattern-substitution
# escaping produced backslash-quote (SQLite drops the row); sed "s/'/''/g" is
# correct.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/post-pr-comments-persist.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 unavailable"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

REPO=$(mktemp -d)
trap 'rm -rf "$REPO"' EXIT
(
  cd "$REPO" || exit 1
  git init -q -b fix/1-pr
  git config user.email t@t.io
  git config user.name t
  echo init > README.md && git add README.md && git commit -qm init
)
DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$SCHEMA" >/dev/null
sqlite3 "$DB" "
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1,'t','t','open',datetime('now'),datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
    VALUES (1,1,'fix/1-pr','t','d','open','s',datetime('now'),datetime('now'));
" >/dev/null

# pr_comments_get-shaped tool result with an apostrophe in the body + author.
PAYLOAD=$(jq -cn '{
  tool_name: "pr_comments_get",
  tool_response: { output: {
    pr_number: 42,
    comments: [ { number: 1, author: "o'\''brien", body: "don'\''t drop this comment", pr_number: 42, is_resolved: false } ]
  } }
}')

( cd "$REPO" && echo "$PAYLOAD" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null )

test_case "comment with an apostrophe is persisted (#274)"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM discussions WHERE kind='note' AND body LIKE '%comment by%';")
assert_eq "1" "$COUNT" "the apostrophe-bearing comment row must be inserted"

test_case "body + author round-trip with the literal apostrophe intact"
BODY=$(sqlite3 "$DB" "SELECT body FROM discussions WHERE kind='note' LIMIT 1;")
case "$BODY" in
  *"don't drop this comment"*) echo "  ✓ body preserved: $BODY" ;;
  *) echo "FAIL: body mangled: $BODY"; exit 1 ;;
esac
case "$BODY" in
  *"o'brien"*) echo "  ✓ author preserved" ;;
  *) echo "FAIL: author mangled: $BODY"; exit 1 ;;
esac
