#!/usr/bin/env bash
# L3 tests: post-atomic-close-readme.sh PostToolUse hook on bro_atomic_close.
#
# When a closed task's commit touched a directory whose README.md is missing
# or older than the commit, the hook emits an additionalContext nudge and
# writes one `readme_staleness_surfaced` audit row. A fresh README (newer than
# the commit) or an unresolvable payload is a no-op at exit 0 — never blocks.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

HOOK="$PLUGIN_ROOT/scripts/hooks/post-atomic-close-readme.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not available"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not available"; exit 0; }
[ -f "$SCHEMA" ] || { echo "SKIP: schema.sql not found at $SCHEMA"; exit 0; }

TMPDIR_R=$(mktemp -d)
trap 'rm -rf "$TMPDIR_R"' EXIT

# ── Fixture: workspace with a git repo + a trajectory DB ───────────────────────
#   $WS/                          ← workspace root (dirname^3 of the DB)
#     .claude/tmb/trajectory.db
#     repo-a/                     ← the product repo the task closed against
#       README.md                 ← repo-root README (kept fresh)
#       src/                      ← touched dir whose README is stale
WS="$TMPDIR_R/ws"
REPO="$WS/repo-a"
mkdir -p "$REPO/src"

git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t

# Stale README: older than the commit (backdated mtime).
echo "# src (old summary)" > "$REPO/src/README.md"
echo "# repo-a" > "$REPO/README.md"
echo "v1" > "$REPO/src/feature.txt"
git -C "$REPO" add .
git -C "$REPO" commit -qm "init"

# The commit under test touches src/feature.txt — its README must look stale.
echo "v2" > "$REPO/src/feature.txt"
git -C "$REPO" add src/feature.txt
git -C "$REPO" commit -qm "update feature"
COMMIT=$(git -C "$REPO" rev-parse HEAD)

# Force src/README.md to be older than the commit (commit epoch is "now").
touch -t 200001010000 "$REPO/src/README.md"

# DB at workspace root so the hook resolves WORKSPACE_ROOT=$WS, repo=repo-a.
DB="$WS/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$SCHEMA"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, description, status, created_at, updated_at)
  VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, commit_sha, created_at, updated_at)
  VALUES (1, 1, 'feat/x', 'd', 'closed', 'repo-a', '${COMMIT}', datetime('now'), datetime('now'));
"

_payload() {
  local task_id="$1" is_error="${2:-false}"
  jq -nc \
    --argjson task_id "$task_id" \
    --argjson is_error "$is_error" \
    '{tool_name:"mcp__plugin_dev_trajectory-server__bro_atomic_close",
      tool_input:{task_id:$task_id},
      tool_response:{is_error:$is_error}}'
}

# ── Test: stale README → nudge + audit row ─────────────────────────────────────
test_case "stale README → additionalContext nudge"
OUT=$(_payload 1 | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null || true)
assert_contains "$OUT" "additionalContext" "hook emits additionalContext"
assert_contains "$OUT" "README" "nudge mentions README"
CTX=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
assert_contains "$CTX" "src" "nudge names the stale dir"

test_case "stale README → readme_staleness_surfaced audit row"
ROWS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='readme_staleness_surfaced';")
assert_eq "1" "$ROWS" "exactly one readme_staleness_surfaced audit row"
ISSUE=$(sqlite3 "$DB" "SELECT issue_id FROM audit WHERE event_type='readme_staleness_surfaced' LIMIT 1;")
assert_eq "1" "$ISSUE" "audit row carries the task's issue_id"

# ── Test: absent README → nudge + audit row ────────────────────────────────────
test_case "absent README → nudge"
mkdir -p "$REPO/docs"
echo "v1" > "$REPO/docs/page.txt"
git -C "$REPO" add docs/page.txt
git -C "$REPO" commit -qm "add docs"
COMMIT2=$(git -C "$REPO" rev-parse HEAD)
sqlite3 "$DB" "UPDATE tasks SET commit_sha='${COMMIT2}' WHERE id=1;"
OUT2=$(_payload 1 | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null || true)
assert_contains "$OUT2" "additionalContext" "absent README emits nudge"
CTX2=$(echo "$OUT2" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)
assert_contains "$CTX2" "docs" "nudge names the dir with no README"

# ── Test: fresh README → no-op ─────────────────────────────────────────────────
test_case "fresh README → no nudge, no new audit row"
mkdir -p "$REPO/fresh"
echo "v1" > "$REPO/fresh/code.txt"
git -C "$REPO" add fresh/code.txt
git -C "$REPO" commit -qm "add fresh dir"
COMMIT3=$(git -C "$REPO" rev-parse HEAD)
# README written AFTER the commit → newer than commit epoch → fresh.
echo "# fresh" > "$REPO/fresh/README.md"
echo "# repo-a (refreshed)" > "$REPO/README.md"
sqlite3 "$DB" "UPDATE tasks SET commit_sha='${COMMIT3}' WHERE id=1;"
BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='readme_staleness_surfaced';")
OUT3=$(_payload 1 | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null; echo "EXIT:$?")
RC3="${OUT3##*EXIT:}"
BODY3="${OUT3%EXIT:*}"
assert_eq "0" "$RC3" "fresh-README run exits 0"
assert_not_contains "$BODY3" "additionalContext" "fresh README emits no nudge"
AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='readme_staleness_surfaced';")
assert_eq "$BEFORE" "$AFTER" "no audit row written for fresh README"

# ── Test: error response → no-op ───────────────────────────────────────────────
test_case "is_error response → no-op"
BEFORE_E=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='readme_staleness_surfaced';")
sqlite3 "$DB" "UPDATE tasks SET commit_sha='${COMMIT}' WHERE id=1;"
OUTE=$(_payload 1 true | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null; echo "EXIT:$?")
assert_eq "0" "${OUTE##*EXIT:}" "errored close exits 0"
assert_not_contains "${OUTE%EXIT:*}" "additionalContext" "errored close emits no nudge"
AFTER_E=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='readme_staleness_surfaced';")
assert_eq "$BEFORE_E" "$AFTER_E" "errored close writes no audit row"

# ── Test: wrong tool → no-op ───────────────────────────────────────────────────
test_case "non-bro_atomic_close tool → no-op"
OUTW=$(echo '{"tool_name":"Bash","tool_input":{}}' | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null; echo "EXIT:$?")
assert_eq "0" "${OUTW##*EXIT:}" "wrong tool exits 0"
assert_not_contains "${OUTW%EXIT:*}" "additionalContext" "wrong tool emits no nudge"

# ── Test: unresolvable task_id → no-op ─────────────────────────────────────────
test_case "unresolvable task_id → no-op"
OUTU=$(_payload 999 | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null; echo "EXIT:$?")
assert_eq "0" "${OUTU##*EXIT:}" "missing task exits 0"
assert_not_contains "${OUTU%EXIT:*}" "additionalContext" "missing task emits no nudge"

# ── Test: bypass env var ───────────────────────────────────────────────────────
test_case "TMB_DISABLE_README_STALENESS_HOOK=1 → no-op"
sqlite3 "$DB" "UPDATE tasks SET commit_sha='${COMMIT}' WHERE id=1;"
OUTB=$(_payload 1 | TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_README_STALENESS_HOOK=1 bash "$HOOK" 2>/dev/null || true)
assert_not_contains "$OUTB" "additionalContext" "bypass emits no nudge"

summarize
