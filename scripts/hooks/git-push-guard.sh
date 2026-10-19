#!/usr/bin/env bash
# Hook: Block `git push` when the commits being pushed include closed tasks
# that lack a passing pr-reviewer verdict in the trajectory DB.
#
# Doctrine: bro is the task gate (closes tasks atomically after SWE).
# pr-reviewer is the push gate — runs only when commits are about to ship.
# This hook enforces that doctrine at the Bash boundary.
#
# A push is a `git [-C <p>] push` statement of the command's executable
# skeleton (lib/cmd-analysis.sh): pushes named inside heredocs, quoted text,
# grep patterns or commit messages are data. Each push is judged in its
# effective dir (git -C, else a preceding cd, else the payload cwd when it
# belongs to one checkout); a push whose dir is ambiguous or unresolvable is
# denied with ambiguous_git_target. The role comes from the agent identity
# only (tmb_agent_role).
#
# Rebased task commits (GH 1518): a pushed commit that is no task's
# commit_sha but has the `git patch-id --stable` of a task's commit in this
# repo is that task's work rebased, so the review of the original does not
# cover it. When the task has no pass verdict it is denied outright. When it
# has one it is denied unless a verification_runs row with exit_code 0 names
# that exact SHA; skills/tmb_planning/scripts/integrate.sh rebases a reviewed
# task in a temporary worktree, re-runs verification[] and records that row.
# A commit matching several tasks is judged against a reviewed one if any.
# Commits are paired by changed-path set before any patch-id is computed.
#
# Skips:
#   - `git push --force` / `-f` (handled by git-guards.sh — destructive ops)
#   - commits matching no task's commit_sha and no task commit's patch-id
#     (pre-TMB or non-tracked work)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
printf '%s' "$CMD" | grep -E 'push' >/dev/null || exit 0

CWD=$(tmb_payload_cwd "$INPUT")
PUSHES=""
while IFS="$(printf '\t')" read -r dir stmt; do
  sub=$(tmb_git_subcommand "$stmt")
  case "$sub" in push|"push "*) ;; *) continue ;; esac
  case " ${sub} " in
    *" --force "*|*" -f "*|*" --force-with-lease "*|*" --force-with-lease="*) continue ;;
  esac
  PUSHES="${PUSHES}${dir}$(printf '\t')${stmt}
"
done < <(tmb_cmd_statements "$CMD" "$CWD")
[ -n "$PUSHES" ] || exit 0

ROLE=$(tmb_agent_role "$INPUT")
if [ "$ROLE" = "swe" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: SWE must never push. Bro handles the push gate after pr-reviewer passes. Commit in your worktree and call task_update_status(completed)."}}'
  exit 0
fi
# pr-reviewer renders a verdict row; the push decision belongs to bro after
# that verdict — pr-reviewer itself must never initiate a push.
if [ "$ROLE" = "pr-reviewer" ]; then
  jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: pr-reviewer must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed."}}'
  exit 0
fi

DB=$(tmb_db_path || true)

# paths_sig <dir> — reads commit SHAs on stdin, prints "<changed paths>\t<sha>"
# per non-merge commit that changes something. Equal patch-ids imply equal
# changed-path sets, so this pairs candidates before any patch-id is computed.
paths_sig() {
  git -C "$1" diff-tree --stdin -r --root --name-only --format='commit %H' 2>/dev/null | awk '
    function flush() { if (sha != "" && files != "") print files "\t" sha; sha = ""; files = "" }
    /^commit [0-9a-f]+$/ { flush(); sha = $2; next }
    NF { files = files "\037" $0 }
    END { flush() }'
}

# unchecked_rebases <dir> <push_shas>
# Prints "<sha>|<task_id>|<branch_id>|<reviewed 0/1>" for each pushed commit
# that is no task's commit_sha, has the patch-id of a task's commit in this
# repo, and either that task has no pass verdict or the commit has no
# verification_runs row with exit_code 0 for itself. Prints __ERR__ when a DB
# read fails.
unchecked_rebases() {
  local dir="$1" pushed="$2" values="" task_commits fresh root name safe_name repo_filter=""
  local tasks full pairs ids matches in_list sha reviewed ok
  while IFS= read -r sha; do
    case "$sha" in ''|*[!0-9a-f]*) continue ;; esac
    values="${values:+$values,}('$sha')"
  done <<< "$pushed"
  case "$values" in ''|*[!0-9a-f\'\(\),]*) return 0 ;; esac
  task_commits=$(tmb_gate_read "$DB" "WITH p(sha) AS (VALUES ${values})
    SELECT p.sha FROM p WHERE EXISTS (SELECT 1 FROM tasks t
      WHERE length(t.commit_sha) >= 7 AND substr(p.sha, 1, length(t.commit_sha)) = t.commit_sha);")
  [ "$task_commits" != "__ERR__" ] || { printf '__ERR__'; return 0; }
  fresh=$(printf '%s\n' "$pushed" | grep -vxF -f <(printf '%s\n' "$task_commits") || true)
  [ -n "$fresh" ] || return 0

  root=$(tmb_repo_git_root "$dir")
  name=$(tmb_repo_name_for_root "$DB" "$root")
  if [ -n "$name" ]; then
    safe_name=$(tmb_sql_quote "$name")
    repo_filter="AND (t.repo IS NULL OR t.repo = '${safe_name}')"
  fi
  tasks=$(tmb_gate_read "$DB" "SELECT t.commit_sha || '|' || t.id || '|' || COALESCE(t.branch_id, '') || '|'
       || EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'pass') FROM tasks t
     WHERE length(t.commit_sha) >= 7 AND t.commit_sha NOT GLOB '*[^0-9a-f]*' ${repo_filter}
     ORDER BY t.id;")
  [ "$tasks" != "__ERR__" ] || { printf '__ERR__'; return 0; }
  [ -n "$tasks" ] || return 0

  full=$(paste -d'|' \
      <(printf '%s\n' "$tasks" | cut -d'|' -f1 | git -C "$dir" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null) \
      <(printf '%s\n' "$tasks" | cut -d'|' -f2-) \
    | awk '{ split($0, o, /[ |]/); if (o[2] == "commit") print o[1] substr($0, index($0, "|")) }')
  [ -n "$full" ] || return 0

  pairs=$(awk -F'\t' 'FILENAME == ARGV[1] { r[$1] = r[$1] " " $2; next } ($1 in r) { print $2 r[$1] }' \
    <(printf '%s\n' "$full" | cut -d'|' -f1 | paths_sig "$dir") \
    <(printf '%s\n' "$fresh" | paths_sig "$dir"))
  [ -n "$pairs" ] || return 0

  ids=$(printf '%s\n' "$pairs" | tr ' ' '\n' | sort -u \
    | git -C "$dir" diff-tree --stdin -p -r --root 2>/dev/null | git -C "$dir" patch-id --stable 2>/dev/null)
  [ -n "$ids" ] || return 0
  matches=$(awk 'FILENAME == ARGV[1] { pid[$2] = $1; next }
    FILENAME == ARGV[2] { task[substr($0, 1, index($0, "|") - 1)] = substr($0, index($0, "|")); next }
    !($1 in pid) || seen[$1]++ { next }
    { m = ""
      for (i = 2; i <= NF; i++) if (pid[$i] == pid[$1] && ($i in task)) {
        if (m == "" || task[$i] ~ /[|]1$/) m = task[$i]
        if (m ~ /[|]1$/) break
      }
      if (m != "") print $1 m }' \
    <(printf '%s\n' "$ids") <(printf '%s\n' "$full") <(printf '%s\n' "$pairs"))
  [ -n "$matches" ] || return 0

  in_list=""
  while IFS='|' read -r sha _ _ reviewed; do
    [ "$reviewed" = 1 ] || continue
    case "$sha" in ''|*[!0-9a-f]*) continue ;; esac
    in_list="${in_list:+$in_list,}'$sha'"
  done <<< "$matches"
  ok=""
  if [ -n "$in_list" ]; then
    ok=$(tmb_gate_read "$DB" "SELECT DISTINCT commit_sha FROM verification_runs
       WHERE commit_sha IN (${in_list}) AND exit_code = 0 AND timed_out = 0;")
    [ "$ok" != "__ERR__" ] || { printf '__ERR__'; return 0; }
  fi
  awk -F'|' 'FILENAME == ARGV[1] { ok[$1] = 1; next } $4 != 1 || !($1 in ok)' \
    <(printf '%s\n' "$ok") <(printf '%s\n' "$matches")
}

while IFS="$(printf '\t')" read -r DIR STMT <&3; do
  [ -n "$STMT" ] || continue
  case "$DIR" in
    '?'|-) tmb_deny_ambiguous_git_target "$STMT"; exit 0 ;;
  esac
  # Pushes happen from the main checkout, where bro reaped the task commits;
  # a push run in .claude/worktrees/ is a direct push of unreviewed work.
  case "$DIR" in
    */.claude/worktrees/*)
      jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`."}}'
      exit 0
      ;;
  esac
  # No DB or no sqlite3 — TMB isn't tracking anything in this project.
  if [ -z "$DB" ] || ! tmb_have_sqlite; then
    continue
  fi

  # Commits about to be pushed: upstream tracking when available.
  PUSH_SHAS=$(git -C "$DIR" log '@{u}..HEAD' --pretty=%H 2>/dev/null || true)
  if [ -z "$PUSH_SHAS" ]; then
    # No upstream — first push of a new branch: commits unique to this branch
    # vs the target branch: this repo's repos row, else the sole registered
    # repo's row, else the remote's default branch, else main.
    _PUSH_REPO_ROW=$(tmb_repo_resolve "$DB" "$(tmb_stmt_repo_root "$DIR" "$CWD")")
    PR_TARGET=$(printf '%s' "$_PUSH_REPO_ROW" | cut -d'|' -f1)
    if [ -z "$PR_TARGET" ]; then
      _PUSH_SOLE_PATH=$(tmb_repo_single_path "$DB")
      [ -n "$_PUSH_SOLE_PATH" ] && PR_TARGET=$(tmb_repo_resolve "$DB" "$_PUSH_SOLE_PATH" | cut -d'|' -f1)
    fi
    if [ -z "$PR_TARGET" ]; then
      PR_TARGET=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
    fi
    PR_TARGET="${PR_TARGET:-main}"
    # H4: resolve a base ref that ACTUALLY EXISTS — origin/<target>, <target>,
    # then the remote's default; none → FAIL CLOSED by gating all of HEAD so
    # unsigned commits never bypass the gate on a main-only repo.
    _BASE_REF=""
    for _cand in "origin/${PR_TARGET}" "${PR_TARGET}"; do
      if git -C "$DIR" rev-parse --verify --quiet "$_cand" >/dev/null 2>&1; then
        _BASE_REF="$_cand"
        break
      fi
    done
    if [ -z "$_BASE_REF" ]; then
      _PUSH_DEFAULT=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
      if [ -n "$_PUSH_DEFAULT" ]; then
        for _cand in "origin/${_PUSH_DEFAULT}" "${_PUSH_DEFAULT}"; do
          if git -C "$DIR" rev-parse --verify --quiet "$_cand" >/dev/null 2>&1; then
            _BASE_REF="$_cand"
            break
          fi
        done
      fi
    fi
    if [ -n "$_BASE_REF" ]; then
      PUSH_SHAS=$(git -C "$DIR" log "${_BASE_REF}..HEAD" --pretty=%H 2>/dev/null || true)
    else
      PUSH_SHAS=$(git -C "$DIR" log HEAD --pretty=%H 2>/dev/null || true)
    fi
  fi
  [ -n "$PUSH_SHAS" ] || continue

  SHA_LIST=""
  while IFS= read -r sha; do
    case "$sha" in ''|*[!0-9a-f]*) continue ;; esac
    if [ -z "$SHA_LIST" ]; then SHA_LIST="'$sha'"; else SHA_LIST="$SHA_LIST,'$sha'"; fi
  done <<< "$PUSH_SHAS"
  [ -n "$SHA_LIST" ] || continue

  # Tasks whose commit_sha is in the push set AND lack a passing validation row.
  UNSIGNED=$(tmb_gate_read "$DB" "
    SELECT t.id || '|' || t.branch_id || '|' || substr(t.title, 1, 60)
      FROM tasks t
     WHERE t.commit_sha IN ($SHA_LIST)
       AND NOT EXISTS (
         SELECT 1 FROM validation_attempts v
          WHERE v.task_id = t.id
            AND v.verdict = 'pass'
       );
  ")

  if [ "$UNSIGNED" = "__ERR__" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB and retry the push."}}'
    exit 0
  fi
  if [ -n "$UNSIGNED" ]; then
    COUNT=$(printf '%s\n' "$UNSIGNED" | wc -l | tr -d ' ')
    LIST=$(printf '%s\n' "$UNSIGNED" | awk -F'|' '{ printf "  - task_id=%s  %s  (%s)\n", $1, $2, $3 }')
    DENY_REASON="BLOCKED: pushing ${COUNT} unsigned commit(s). The following tasks lack a pr-reviewer pass verdict:

${LIST}
Run: @bro review before push

bro will spawn pr-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing."
    jq -nc --arg reason "$DENY_REASON" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
    exit 0
  fi

  UNCHECKED=$(unchecked_rebases "$DIR" "$PUSH_SHAS")
  if [ "$UNCHECKED" = "__ERR__" ]; then
    jq -nc '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB and retry the push."}}'
    exit 0
  fi
  [ -n "$UNCHECKED" ] || continue

  COUNT=$(printf '%s\n' "$UNCHECKED" | wc -l | tr -d ' ')
  LIST=$(printf '%s\n' "$UNCHECKED" | awk -F'|' '{
    why = ($4 == 1) ? "no passing verification run for this commit" : "the task has no passing review"
    printf "  - %s  rebase of task_id=%s  %s  (%s)\n", $1, $2, $3, why }')
  DENY_REASON="BLOCKED: pushing ${COUNT} rebased task commit(s) not covered by a review and a verification run. Each has the patch-id of a task commit but is not that commit:

${LIST}
A task with no passing review needs @bro review before push first. Then rebase it with integrate.sh, which re-runs verification[] on the rebased commit, records the run and only then moves the branch:
  bash \"\${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/integrate.sh\" <task_id> <base>"
  jq -nc --arg reason "$DENY_REASON" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
done 3<<< "$PUSHES"

exit 0
