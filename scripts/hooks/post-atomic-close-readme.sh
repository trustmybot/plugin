#!/usr/bin/env bash
# PostToolUse hook on bro_atomic_close: surface a README-staleness nudge.
#
# The kuzu world model derives each directory's summary from that dir's
# README.md (scan_run walks the README tree). When a task closes having
# touched files under a directory whose README.md is missing or older than
# the commit that just landed, that dir's world-model summary is now stale —
# every later world_model_get / world_model_search reads the old description.
# This hook surfaces that deterministically so bro can decide whether to
# refresh the README (the README update is bro's JUDGMENT, exercised in L6 —
# NOT performed here).
#
# Detection is deterministic; emission is a non-blocking additionalContext
# nudge. Records one `readme_staleness_surfaced` audit row when a nudge fires.
#
# No-op (exit 0, no context) when:
#   - the tool isn't bro_atomic_close, or the call returned an error
#   - the task / commit / repo can't be resolved
#   - nothing the commit touched has a stale-or-absent README
#
# Never exits 2 — this is advisory, never load-bearing.
# Bypass: TMB_DISABLE_README_STALENESS_HOOK=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_README_STALENESS_HOOK:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  mcp__*trajectory-server__bro_atomic_close) ;;
  *) exit 0 ;;
esac

# Don't fire if the close itself failed (gate violation, bad status, etc.).
RESPONSE_ERROR=$(echo "$INPUT" | jq -r '.tool_response.is_error // false' 2>/dev/null)
[ "$RESPONSE_ERROR" = "true" ] && exit 0

TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)
TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$TASK_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] && [ -f "$DB" ] || exit 0
tmb_have_sqlite || exit 0

# Resolve the closed task's commit + repo + issue/branch for the audit row.
TASK_ROW=$(tmb_sqlite_ro "$DB" "
  SELECT COALESCE(commit_sha,'') || '|' ||
         COALESCE(repo,'')       || '|' ||
         COALESCE(issue_id,'')   || '|' ||
         COALESCE(branch_id,'')
    FROM tasks WHERE id = ${TASK_ID};
")
[ -n "$TASK_ROW" ] || exit 0

COMMIT_SHA="${TASK_ROW%%|*}"
_REST="${TASK_ROW#*|}"
REPO="${_REST%%|*}"
_REST="${_REST#*|}"
ISSUE_ID="${_REST%%|*}"
BRANCH_ID="${_REST#*|}"

# A close with no recorded commit can't be diffed.
case "$COMMIT_SHA" in
  ''|*[!0-9a-fA-F]*) exit 0 ;;
esac

# Resolve the repo working tree. The DB lives at
# <workspace_root>/.claude/<plugin>/trajectory.db, so workspace_root is the
# grandparent's parent. The product repo is <workspace_root>/<repo>, falling
# back to <workspace_root> itself (single-repo CC, empty repo column).
WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB")")")"
REPO_PATH=""
if [ -n "$REPO" ] && [ -d "$WORKSPACE_ROOT/$REPO/.git" ]; then
  REPO_PATH="$WORKSPACE_ROOT/$REPO"
elif [ -n "$REPO" ] && [ -d "$WORKSPACE_ROOT/$REPO" ] && git -C "$WORKSPACE_ROOT/$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  REPO_PATH="$WORKSPACE_ROOT/$REPO"
elif git -C "$WORKSPACE_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  REPO_PATH="$WORKSPACE_ROOT"
fi
[ -n "$REPO_PATH" ] || exit 0

# Commit must exist in this repo to diff it.
git -C "$REPO_PATH" cat-file -e "${COMMIT_SHA}^{commit}" 2>/dev/null || exit 0

# Commit authorship epoch — the freshness baseline a dir's README must beat.
COMMIT_EPOCH=$(git -C "$REPO_PATH" show -s --format=%ct "$COMMIT_SHA" 2>/dev/null || echo "")
case "$COMMIT_EPOCH" in
  ''|*[!0-9]*) exit 0 ;;
esac

# Directories the commit touched (dirname of each changed path; '' = repo root).
TOUCHED_FILES=$(git -C "$REPO_PATH" show --name-only --pretty=format: "$COMMIT_SHA" 2>/dev/null | grep -v '^$' || true)
[ -n "$TOUCHED_FILES" ] || exit 0

TOUCHED_DIRS=$(printf '%s\n' "$TOUCHED_FILES" | while IFS= read -r f; do
  if [ "${f%/*}" != "$f" ]; then
    printf '%s\n' "${f%/*}"
  else
    printf '%s\n' "."
  fi
done | sort -u)

# README.mtime helper: epoch seconds, portable across GNU + BSD stat.
_readme_mtime() {
  local p="$1"
  stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo ""
}

STALE_DIRS=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  if [ "$d" = "." ]; then
    readme="$REPO_PATH/README.md"
    label="$REPO/"
    [ -n "$REPO" ] || label="<repo root>"
  else
    readme="$REPO_PATH/$d/README.md"
    label="$d"
  fi
  if [ ! -f "$readme" ]; then
    STALE_DIRS="${STALE_DIRS}${label} (no README.md)
"
    continue
  fi
  mtime=$(_readme_mtime "$readme")
  case "$mtime" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$mtime" -lt "$COMMIT_EPOCH" ]; then
    STALE_DIRS="${STALE_DIRS}${label} (README.md older than the commit)
"
  fi
done <<EOF
$TOUCHED_DIRS
EOF

STALE_DIRS="${STALE_DIRS%
}"
[ -n "$STALE_DIRS" ] || exit 0

# --- Emit the nudge + record the audit row. ---
ISSUE_ID=$(tmb_sql_int "$ISSUE_ID")
[ -n "$ISSUE_ID" ] || ISSUE_ID=-1

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SUMMARY="task ${TASK_ID}: README may be stale in $(printf '%s\n' "$STALE_DIRS" | grep -c .) dir(s) after ${COMMIT_SHA:0:7}"
SUMMARY_SQL=$(tmb_sql_quote "$SUMMARY")
BRANCH_SQL=$(tmb_sql_quote "$BRANCH_ID")
CONTENT_JSON=$(jq -nc \
  --argjson task_id "$TASK_ID" \
  --arg commit "$COMMIT_SHA" \
  --arg dirs "$STALE_DIRS" \
  '{task_id: $task_id, commit_sha: $commit, stale: ($dirs | split("\n"))}')
CONTENT_SQL=$(tmb_sql_quote "$CONTENT_JSON")

sqlite3 "$DB" \
  "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
   VALUES (${ISSUE_ID}, '${BRANCH_SQL}', 'bro', 'readme_staleness_surfaced', '${SUMMARY_SQL}', '${CONTENT_SQL}', '${NOW}');" 2>/dev/null || true

REASON="📝 README-staleness check (task ${TASK_ID}, commit ${COMMIT_SHA:0:7}): the world model derives each directory's summary from that dir's README.md, so a stale README degrades world_model_get / world_model_search for that dir.

The commit touched directories whose README.md is missing or older than the commit:
${STALE_DIRS}

For each, consider updating the directory's README.md so the next /scan picks up an accurate summary. This is a judgment call — skip it when the change doesn't alter what the README describes."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $reason
  }
}'

exit 0
