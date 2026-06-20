#!/usr/bin/env bash
# PreToolUse(Agent) PREPARE step — deterministically create swe's worktree.
#
# Non-interactive `claude -p` skips the native WorktreeCreate tool, so bro spawns swe
# NON-isolated (edits the main checkout) and swe self-creates a mis-named
# worktree the verification gate can't find. This hook closes that gap: at
# swe-spawn time it creates the worktree via `git worktree add` at the CANONICAL
# slug path, so the path matches the slug the verification gate derives.
#
# This step ACTS, it does NOT gate. It is NON-BLOCKING and fail-open: any error
# (sqlite/git absent, add fails, no task row) logs to stderr and exits 0 — it
# never denies the spawn (the non-isolated fallback still works).
#
# Scope: only `subagent_type` resolving to `swe` with a `task_id=<N>` in the
# prompt. Other spawns (pr-reviewer, consultants) → no-op.
#
# Bypass: TMB_DISABLE_ENSURE_SWE_WORKTREE=1.
set -uo pipefail

if [ "${TMB_DISABLE_ENSURE_SWE_WORKTREE:-0}" = "1" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')")
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

# Only act for swe spawns.
[ "$AGENT_TYPE" = "swe" ] || exit 0

# Require a task_id in the prompt (require-task-spec already enforces presence).
TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id[=:][[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$SAFE_TASK_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  echo "ensure-swe-worktree: no trajectory.db or sqlite3 — skipping (non-isolated fallback)" >&2
  exit 0
fi

ROW=$(tmb_sqlite_ro "$DB" "SELECT branch_id, repo FROM tasks WHERE id=${SAFE_TASK_ID};")
if [ -z "$ROW" ]; then
  echo "ensure-swe-worktree: no tasks row for task_id=${SAFE_TASK_ID} — skipping" >&2
  exit 0
fi

BRANCH=$(echo "$ROW" | cut -d'|' -f1)
REPO=$(echo "$ROW" | cut -d'|' -f2)
if [ -z "$BRANCH" ]; then
  echo "ensure-swe-worktree: task_id=${SAFE_TASK_ID} has empty branch_id — skipping" >&2
  exit 0
fi

# slug = branch's last path component (fix/foo-bar → foo-bar).
SLUG="${BRANCH##*/}"

# Resolve the repo root via the path-keyed model:
#   tasks.repo → repos.path, else single-repo fallback, else workspace root.
WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB")")")"
if [ -n "$REPO" ]; then
  REPO_ROOT=$(tmb_repo_path_by_name "$DB" "$REPO")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="$WORKSPACE_ROOT/$REPO"
else
  REPO_ROOT=$(tmb_repo_single_path "$DB")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="$WORKSPACE_ROOT"
fi

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "ensure-swe-worktree: repo root '$REPO_ROOT' is not a git repo — skipping" >&2
  exit 0
fi

WT_REL=".claude/worktrees/$SLUG"
WT_ABS="$REPO_ROOT/$WT_REL"

# Idempotent: if the canonical path is already a registered worktree, no-op.
# git reports worktree paths in canonicalized form (e.g. macOS resolves
# /var → /private/var), so compare against the basename rather than the full
# REPO_ROOT-relative prefix — the slug is unique under .claude/worktrees/.
if git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null \
    | grep -qE "^worktree .*/\.claude/worktrees/${SLUG}$"; then
  exit 0
fi

# A directory at the path that is NOT a registered worktree: leave it alone
# (git worktree add would fail) — fail-open.
if [ -e "$WT_ABS" ]; then
  echo "ensure-swe-worktree: '$WT_ABS' exists but is not a registered worktree — skipping" >&2
  exit 0
fi

if git -C "$REPO_ROOT" worktree add "$WT_REL" "$BRANCH" >/dev/null 2>&1; then
  echo "ensure-swe-worktree: created worktree $WT_ABS for branch $BRANCH" >&2
else
  echo "ensure-swe-worktree: 'git worktree add $WT_REL $BRANCH' failed — skipping (non-isolated fallback)" >&2
fi

exit 0
