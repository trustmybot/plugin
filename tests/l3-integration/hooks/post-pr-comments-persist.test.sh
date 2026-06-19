#!/usr/bin/env bash
# Tests for scripts/hooks/post-pr-comments-persist.sh
#
# Hook contract: on a pr_monitor_comments_get PostToolUse, persist each returned comment
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

# pr_monitor_comments_get-shaped tool result with an apostrophe in the body + author.
PAYLOAD=$(jq -cn '{
  tool_name: "pr_monitor_comments_get",
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

# ── #349: content[0].text shape (production CC delivery) ─────────────────────
test_case "#349: .tool_response.content[0].text shape is parsed correctly"
sqlite3 "$DB" "DELETE FROM discussions;"
PAYLOAD_CONTENT=$(jq -cn '{
  tool_name: "pr_monitor_comments_get",
  tool_response: { content: [ { type: "text", text: "{\"pr_number\":99,\"comments\":[{\"number\":2,\"author\":\"reviewer\",\"body\":\"looks good\",\"pr_number\":99,\"is_resolved\":false}]}" } ] }
}')
( cd "$REPO" && echo "$PAYLOAD_CONTENT" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null )
COUNT2=$(sqlite3 "$DB" "SELECT COUNT(*) FROM discussions WHERE kind='note' AND body LIKE '%reviewer%';")
assert_eq "1" "$COUNT2" "content[0].text shape must be parsed and row inserted"

# ── #349: walk-up DB resolution (no TRAJECTORY_DB_PATH) ──────────────────────
test_case "#349: DB resolved via walk-up when TRAJECTORY_DB_PATH is unset"
WALK_ROOT=$(mktemp -d -t tmb-pr-walk-XXXX)
trap 'rm -rf "$WALK_ROOT"' EXIT
WALK_DB="$WALK_ROOT/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WALK_DB")"
sqlite3 "$WALK_DB" < "$SCHEMA" >/dev/null
(
  cd "$WALK_ROOT" || exit 1
  git init -q -b fix/walk-pr
  git config user.email t@t.io
  git config user.name t
  echo init > README.md && git add README.md && git commit -qm init
)
sqlite3 "$WALK_DB" "
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (2,'t','t','open',datetime('now'),datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
    VALUES (2,2,'fix/walk-pr','t','d','open','s',datetime('now'),datetime('now'));
" >/dev/null
WALK_PAYLOAD=$(jq -cn '{
  tool_name: "pr_monitor_comments_get",
  tool_response: { output: {
    pr_number: 55,
    comments: [ { number: 3, author: "walk", body: "walk-up comment", pr_number: 55, is_resolved: false } ]
  } }
}')
( cd "$WALK_ROOT" && echo "$WALK_PAYLOAD" | bash "$HOOK" 2>/dev/null )
COUNT3=$(sqlite3 "$WALK_DB" "SELECT COUNT(*) FROM discussions WHERE kind='note' AND body LIKE '%walk-up comment%';")
assert_eq "1" "$COUNT3" "walk-up must find the DB and insert the comment row"

# ── injection regression ──────────────────────────────────────────────────────
# The discussions INSERT uses CURRENT_BRANCH (from git rev-parse), ISSUE_ID
# (from DB SELECT), AUTHOR_ESC and NOTE_BODY_ESC (both escaped via sed).
# We test: injection via comment body does NOT corrupt the DB.

test_case "injection in comment body: treated as literal string, no SQL error"
sqlite3 "$DB" "DELETE FROM discussions;"
INJ_PAYLOAD=$(jq -cn '{
  tool_name: "pr_monitor_comments_get",
  tool_response: { output: {
    pr_number: 99,
    comments: [ { number: 9, author: "hax", body: "1; DROP TABLE discussions;-- end", pr_number: 99, is_resolved: false } ]
  } }
}')
( cd "$REPO" && echo "$INJ_PAYLOAD" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null )
TABLE_EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='discussions';")
assert_eq "1" "$TABLE_EXISTS" "discussions table must survive injection attempt in body"
COUNT_INJ=$(sqlite3 "$DB" "SELECT COUNT(*) FROM discussions WHERE kind='note';")
assert_eq "1" "$COUNT_INJ" "injection-string comment inserted as a literal row"

test_case "comment author with single quotes: row inserted intact"
sqlite3 "$DB" "DELETE FROM discussions;"
QUOTE_PAYLOAD=$(jq -cn '{
  tool_name: "pr_monitor_comments_get",
  tool_response: { output: {
    pr_number: 77,
    comments: [ { number: 5, author: "o'\''reilly", body: "it'\''s fine", pr_number: 77, is_resolved: false } ]
  } }
}')
( cd "$REPO" && echo "$QUOTE_PAYLOAD" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null )
STORED_BODY=$(sqlite3 "$DB" "SELECT body FROM discussions WHERE kind='note' LIMIT 1;")
case "$STORED_BODY" in
  *"it's fine"*) echo "  ✓ single-quoted body preserved" ;;
  *) echo "FAIL: body mangled: $STORED_BODY"; exit 1 ;;
esac

summarize
