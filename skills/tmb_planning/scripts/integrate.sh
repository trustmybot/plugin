#!/usr/bin/env bash
# bro's post-review rebase of a task's branch onto a moved base (GH 1518).
#
#   bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/integrate.sh" <task_id> <base>
#
# Run by bro from the main checkout, after bro's own verify and the pr-reviewer
# pass. The task's repo, branch_id, commit_sha and verification[] come from
# the trajectory DB (TRAJECTORY_DB_PATH, else CLAUDE_PROJECT_DIR, else a walk
# up from cwd).
#   1. No passing review for the task's commit_sha (a pass verdict at or after
#      the first bro_verification_pass naming the task and that commit) → exit 3.
#   2. <base> already an ancestor of commit_sha → print commit_sha, exit 0;
#      nothing is recorded.
#   3. A temporary worktree <repo>/.claude/worktrees/integrate-<task_id>.XXXXXX,
#      detached at commit_sha, runs `git rebase <base>`. A conflict is aborted
#      → exit 2, branch and DB unchanged.
#   4. The `git patch-id --stable` list of <base>..commit_sha and of
#      <base>..<rebased> must match, else exit 2.
#   5. Each untracked node_modules of the main checkout beside a tracked
#      package.json is symlinked into the worktree (GH 1541).
#      verification[] runs in the temporary worktree and is recorded as a
#      verification_runs row (source manual, commit_sha = the rebased SHA).
#      A failure → exit 1, branch unmoved. A pass moves refs/heads/<branch_id>
#      to the rebased SHA and prints it.
#   6. The temporary worktree is removed on every exit.
# The branch is moved only when no worktree has it checked out and it still
# points at commit_sha, or at a rebase of it with a passing recorded run.
# git-push-guard.sh denies a push of a rebased task commit without such a run.
#
# Each command is bounded by what is left of the budget,
# plugin_config.verification_timeout_s (default 900 s; TMB_VERIFICATION_TIMEOUT_S
# overrides it), capped at 1800 s, when `timeout` or `gtimeout` is installed.
# stdout carries only the SHA; progress and failures go to stderr.
# Exit 0 = integrated, 1 = verification failed, 2 = conflict or patch drift,
# 3 = no passing review, 4 = usage error or a precondition not met.
set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/hooks/lib" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$LIB/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$LIB/db-write.sh"
# shellcheck source=scripts/hooks/lib/verification-runs.sh
. "$LIB/verification-runs.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$LIB/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/resolve-workspace.sh
. "$LIB/resolve-workspace.sh"
# shellcheck source=scripts/hooks/lib/resolve-toolchain-path.sh
. "$LIB/resolve-toolchain-path.sh"

VERIFICATION_DEFAULT_S=900
VERIFICATION_MAX_S=1800
FINISH_ATTEMPTS=3
TAIL_LINES=20

# Byte-identical copy of lifecycle.ts HAS_PASS_SQL (lifecycle.test.ts pins
# them equal): a pass verdict counts only at or after the earliest
# bro_verification_pass naming the task and its current commit. `t` is the
# task alias.
_INT_HAS_PASS="EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= (
    SELECT MIN(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '\$.task_id') = t.id
        AND json_extract(a.content_json, '\$.commit_sha') = t.commit_sha))"

say() { printf 'integrate: %s\n' "$*" >&2; }
die() { say "$2"; exit "$1"; }

[ "$#" -eq 2 ] || die 4 "usage: integrate.sh <task_id> <base>"
TASK_ID=$(tmb_sql_int "$1")
BASE="$2"
[ -n "$TASK_ID" ] || die 4 "task_id must be a number, got '$1'"
[ -n "$BASE" ] || die 4 "base is empty"
command -v jq >/dev/null 2>&1 || die 4 "jq not found"
tmb_have_sqlite || die 4 "sqlite3 not found"
DB=$(tmb_db_path) || die 4 "no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)"

ROW=$(tmb_gate_read "$DB" "SELECT 'task' || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || ${_INT_HAS_PASS}
  FROM tasks t WHERE t.id = ${TASK_ID};")
[ "$ROW" != "__ERR__" ] || die 4 "trajectory DB read failed: $DB"
[ -n "$ROW" ] || die 4 "no task $TASK_ID"
{ read -r _; read -r TASK_REPO; read -r BRANCH; read -r COMMIT_SHA; read -r HAS_PASS; } <<< "$ROW"
[ -n "$BRANCH" ] || die 4 "task $TASK_ID has no branch_id"
[ -n "$COMMIT_SHA" ] || die 3 "task $TASK_ID has no commit_sha, so no reviewed commit"
[ "$HAS_PASS" = 1 ] || die 3 "task $TASK_ID has no passing pr-reviewer verdict for commit $COMMIT_SHA"

WS_ROOT=$(tmb_workspace_root "$DB")
if [ -n "$TASK_REPO" ]; then
  REPO_DIR=$(tmb_repo_path_by_name "$DB" "$TASK_REPO")
  [ -n "$REPO_DIR" ] || REPO_DIR="${WS_ROOT}/${TASK_REPO}"
else
  REPO_DIR=$(tmb_repo_single_path "$DB")
  [ -n "$REPO_DIR" ] || REPO_DIR="$WS_ROOT"
fi
REPO_ROOT=$(tmb_repo_git_root "$REPO_DIR")
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_DIR" ]; then
  die 4 "task $TASK_ID's repo is not a git checkout: ${REPO_DIR:-<unresolved>}"
fi

g() { git -C "$REPO_ROOT" "$@"; }

COMMIT_SHA=$(g rev-parse --verify -q "${COMMIT_SHA}^{commit}") || die 4 "commit_sha of task $TASK_ID is not a commit in $REPO_ROOT"
BASE_SHA=$(g rev-parse --verify -q "${BASE}^{commit}") || die 4 "base '$BASE' is not a commit in $REPO_ROOT"

if g merge-base --is-ancestor "$BASE_SHA" "$COMMIT_SHA"; then
  say "$BASE is already an ancestor of task $TASK_ID's commit; nothing to rebase"
  printf '%s\n' "$COMMIT_SHA"
  exit 0
fi

VERIFICATION=$(tmb_gate_read "$DB" "SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${TASK_ID};")
[ "$VERIFICATION" != "__ERR__" ] || die 4 "trajectory DB read failed: $DB"
COMMANDS=$(printf '%s' "$VERIFICATION" | jq -r '.[]? | select(type == "string" and length > 0)' 2>/dev/null) \
  || die 4 "task $TASK_ID's verification[] is not a JSON array"
[ -n "$COMMANDS" ] || die 4 "task $TASK_ID has no verification[]; there is nothing to re-verify the rebased commit with"

checked_out_at() {
  g worktree list --porcelain | awk -v want="branch refs/heads/$BRANCH" '
    /^worktree / { wt = substr($0, 10) }
    $0 == want { print wt; exit }'
}

verified_run_for() {
  local sha
  sha=$(tmb_sql_quote "$1")
  tmb_gate_read "$DB" "SELECT COUNT(*) FROM verification_runs
    WHERE task_id = ${TASK_ID} AND commit_sha = '${sha}' AND exit_code = 0 AND timed_out = 0;"
}

# branch_movable — 0 when no worktree holds the branch and its tip is
# commit_sha, a verified rebase of it, or absent; sets TIP.
branch_movable() {
  local holder
  holder=$(checked_out_at)
  if [ -n "$holder" ]; then
    say "$BRANCH is checked out at $holder; remove that worktree (or switch it off the branch) and run integrate.sh again"
    return 1
  fi
  TIP=$(g rev-parse --verify -q "refs/heads/${BRANCH}^{commit}" || true)
  if [ -z "$TIP" ] || [ "$TIP" = "$COMMIT_SHA" ]; then
    return 0
  fi
  local runs
  runs=$(verified_run_for "$TIP")
  case "$runs" in
    ''|__ERR__|0)
      say "$BRANCH is at $TIP, which is neither task $TASK_ID's reviewed commit nor a verified integration of it; refusing to move it"
      return 1
      ;;
  esac
}

TIP=""
branch_movable || exit 4

WT=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  [ -n "$WT" ] || return 0
  g worktree remove --force "$WT" >/dev/null 2>&1 || { rm -rf "$WT"; g worktree prune >/dev/null 2>&1; }
  WT=""
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$REPO_ROOT/.claude/worktrees" || die 4 "cannot create $REPO_ROOT/.claude/worktrees"
WT=$(mktemp -d "$REPO_ROOT/.claude/worktrees/integrate-${TASK_ID}.XXXXXX") || die 4 "cannot create a temporary worktree dir"
if ! g worktree add -q --detach "$WT" "$COMMIT_SHA" >&2; then
  rmdir "$WT" 2>/dev/null
  WT=""
  die 4 "git worktree add failed"
fi

say "rebasing task $TASK_ID ($COMMIT_SHA) onto $BASE ($BASE_SHA) in $WT"
if ! (cd "$WT" && GIT_EDITOR=true git rebase -q "$BASE_SHA") >&2; then
  (cd "$WT" && git rebase --abort) >/dev/null 2>&1
  die 2 "rebase of task $TASK_ID onto $BASE conflicted; aborted, $BRANCH and the DB are unchanged"
fi
NEW_SHA=$(git -C "$WT" rev-parse --verify HEAD) || die 4 "cannot read the rebased HEAD"

patch_ids() {
  g rev-list --reverse --no-merges "$1" | g diff-tree --stdin -p -r --root | g patch-id --stable | cut -d' ' -f1
}
REVIEWED_IDS=$(patch_ids "${BASE_SHA}..${COMMIT_SHA}")
REBASED_IDS=$(patch_ids "${BASE_SHA}..${NEW_SHA}")
if [ "$REVIEWED_IDS" != "$REBASED_IDS" ]; then
  die 2 "the rebase changed task $TASK_ID's patches (patch-id of ${BASE}..reviewed differs from ${BASE}..rebased); $BRANCH and the DB are unchanged"
fi

# Untracked node_modules never reach a fresh worktree; link the main
# checkout's install beside each tracked package.json (GH 1541).
while IFS= read -r -d '' PKG; do
  PKG_DIR=$(dirname "$PKG")
  SRC="$REPO_ROOT/$PKG_DIR/node_modules"
  DEST="$WT/$PKG_DIR/node_modules"
  if [ -d "$SRC" ] && [ ! -e "$DEST" ] && [ ! -L "$DEST" ]; then
    ln -s "$SRC" "$DEST" || say "could not link $SRC into the worktree"
  fi
done < <(git -C "$WT" ls-files -z -- 'package.json' '*/package.json')

TIMEOUT_RAW="${TMB_VERIFICATION_TIMEOUT_S:-}"
[ -n "$TIMEOUT_RAW" ] || TIMEOUT_RAW=$(tmb_config_get verification_timeout_s "$DB" 2>/dev/null || true)
case "$TIMEOUT_RAW" in
  ''|*[!0-9]*) TIMEOUT_S="$VERIFICATION_DEFAULT_S" ;;
  *)
    if [ "${#TIMEOUT_RAW}" -gt 9 ]; then TIMEOUT_S="$VERIFICATION_MAX_S"
    else TIMEOUT_S=$(( 10#$TIMEOUT_RAW )); fi
    ;;
esac
[ "$TIMEOUT_S" -ge 1 ] || TIMEOUT_S="$VERIFICATION_DEFAULT_S"
[ "$TIMEOUT_S" -le "$VERIFICATION_MAX_S" ] || TIMEOUT_S="$VERIFICATION_MAX_S"

TIMEOUT_BIN=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)
[ -n "$TIMEOUT_BIN" ] || say "no timeout/gtimeout installed; commands run without the ${TIMEOUT_S}s bound"
TOOLCHAIN_PATH=$(tmb_resolve_toolchain_path "$PATH" 2>/dev/null || printf '%s' "$PATH")

export TMB_DB_WRITE_TIMEOUT_MS=5000
export TMB_DB_WRITE_RUN_BUDGET_MS=10000
# record <writer> <args...> — one verification-runs write with its own budget.
record() { _TMB_DB_WRITE_SPENT_MS=0; "$@"; }

RUN_ID=$(record tmb_verification_run_start "$DB" "$TASK_ID" "$NEW_SHA" manual "$TIMEOUT_S") && [ -n "$RUN_ID" ] \
  || die 4 "could not record a verification run for $NEW_SHA; $BRANCH unmoved"

finish() {
  local attempt
  for attempt in $(seq 1 "$FINISH_ATTEMPTS"); do
    record tmb_verification_run_finish "$DB" "$RUN_ID" "$1" "$2" && return 0
    sleep "$attempt"
  done
  return 1
}

now_s() { date +%s; }
START_S=$(now_s)
ORDINAL=0
TOTAL=$(printf '%s\n' "$COMMANDS" | grep -c .)
while IFS= read -r CMD; do
  ORDINAL=$(( ORDINAL + 1 ))
  REMAINING=$(( TIMEOUT_S - ($(now_s) - START_S) ))
  if [ "$REMAINING" -le 0 ]; then
    record tmb_verification_run_command "$DB" "$RUN_ID" "$ORDINAL" "$CMD" 124 0 "budget spent before the command started" || true
    finish 124 1 || say "run #$RUN_ID finish write failed"
    die 1 "verification budget (${TIMEOUT_S}s) spent before command $ORDINAL/$TOTAL: $CMD; recorded as run #$RUN_ID; $BRANCH unmoved"
  fi
  CMD_START=$(now_s)
  RC=0
  if [ -n "$TIMEOUT_BIN" ]; then
    OUT=$(cd "$WT" && PATH="$TOOLCHAIN_PATH" "$TIMEOUT_BIN" "$REMAINING" bash -c "$CMD" </dev/null 2>&1) || RC=$?
  else
    OUT=$(cd "$WT" && PATH="$TOOLCHAIN_PATH" bash -c "$CMD" </dev/null 2>&1) || RC=$?
  fi
  ELAPSED=$(( $(now_s) - CMD_START ))
  TAIL=$(tail -n "$TAIL_LINES" <<< "$OUT")
  TIMED_OUT=0
  if [ "$RC" -eq 124 ] && [ -n "$TIMEOUT_BIN" ] && [ "$ELAPSED" -ge "$REMAINING" ]; then TIMED_OUT=1; fi
  record tmb_verification_run_command "$DB" "$RUN_ID" "$ORDINAL" "$CMD" "$RC" "$ELAPSED" "$TAIL" \
    || say "run #$RUN_ID: command $ORDINAL row not recorded"
  if [ "$RC" -ne 0 ]; then
    finish "$RC" "$TIMED_OUT" || say "run #$RUN_ID finish write failed"
    say "verification failed on $NEW_SHA: command $ORDINAL/$TOTAL exited $RC after ${ELAPSED}s: $CMD"
    printf '%s\n' "$TAIL" >&2
    die 1 "recorded as run #$RUN_ID; $BRANCH unmoved"
  fi
done <<< "$COMMANDS"

finish 0 0 || die 4 "run #$RUN_ID passed but its finish write failed, so the push guard will not count it; $BRANCH unmoved"

OLD_TIP="$TIP"
branch_movable || die 4 "verification passed (run #$RUN_ID) but $BRANCH cannot be moved; the rebased commit is $NEW_SHA"
[ "$TIP" = "$OLD_TIP" ] || die 4 "$BRANCH moved during integration ($OLD_TIP -> $TIP); left as is"
g update-ref -m "integrate.sh: task $TASK_ID onto $BASE" "refs/heads/$BRANCH" "$NEW_SHA" "$TIP" \
  || die 4 "git update-ref of $BRANCH failed; the rebased commit is $NEW_SHA (run #$RUN_ID)"
say "$BRANCH -> $NEW_SHA (verification run #$RUN_ID passed)"
printf '%s\n' "$NEW_SHA"
exit 0
