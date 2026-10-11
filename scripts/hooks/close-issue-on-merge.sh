#!/usr/bin/env bash
# PostToolUse hook on Bash — after a SUCCESSFUL `gh pr merge` / `glab mr merge`
# (anywhere in a compound command; heredoc bodies and quoted text never match),
# record what the merge finished:
#   - tasks on the merged head branch that are still live → closed, their open
#     agent_runs closed exit_reason='completed';
#   - every task on that branch with no passing pr-reviewer verdict for its
#     current commit (and no recorded bypass/waiver) → one review_gate_bypassed
#     audit row: the merge happened, the trajectory says the gate was skipped;
#   - each issue the PR resolves through an EXPLICIT closing-ref
#     (`gh pr view --json closingIssuesReferences,body,headRefName` plus a
#     `Closes|Fixes (GH )?#<n>` body parse; a GH number maps to issues.gh_iid,
#     else to issues.id) closes locally when none of its other tasks is live,
#     with an issue_auto_closed_on_merge audit row; otherwise it stays open and
#     an issue_auto_close_deferred row names the blocking task ids.
# All local writes land in one tmb_db_write transaction. Afterwards the remote
# twin of each locally closed issue is closed, only while the sync gate is on
# (plugin_config.issue_sync set and not 'off', TMB_DISABLE_REMOTE_SYNC unset);
# with the gate off an issue_auto_close_remote_skipped row is written instead.
#
# Non-load-bearing: every path exits 0. Fail OPEN / no-op when sqlite/DB absent,
# no closing-ref, the link is ambiguous, or already closed. gh calls are bounded
# with `timeout`. Bypass: TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"
# shellcheck source=lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

_CIM_FROM="hook:close-issue-on-merge"
_CIM_LIVE="'pending','running','needs_validation','completed'"

# The review rule lifecycle.ts applies (HAS_PASS_SQL): a pass verdict recorded
# at or after the newest bro_verification_pass naming the task's current
# commit, else after the task's completed_at. `t` is the task alias.
_CIM_HAS_PASS="EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= COALESCE(
    (SELECT MAX(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '\$.task_id') = t.id
        AND json_extract(a.content_json, '\$.commit_sha') = t.commit_sha),
    t.completed_at, ''))"
_CIM_SKIP_RECORDED="EXISTS (SELECT 1 FROM audit g
  WHERE g.event_type IN ('review_gate_bypassed', 'review_gate_waived') AND json_valid(g.content_json)
    AND json_extract(g.content_json, '\$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '\$.commit_sha'), '') = COALESCE(t.commit_sha, ''))"

# _cim_gh <args...> — run gh bounded; never hangs the hook.
_cim_gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 gh "$@" 2>/dev/null
  else
    gh "$@" 2>/dev/null
  fi
}

# _cim_merge_args <command> — when one statement of <command> runs
# `gh pr merge` / `glab mr merge` (after VAR=value assignments and
# env/command/time/nohup/sudo wrappers), print that statement's words after
# `merge`, one per line, and return 0. Heredoc bodies, quoted text and comments
# are neutralized first, so they never match. Returns 1 when nothing matches.
_cim_merge_args() {
  local stripped stmt
  local -a words
  stripped=$(tmb_cmd_strip_literals "${1:-}")
  while IFS= read -r stmt; do
    read -r -a words <<<"$stmt" || true
    local i=0 n=${#words[@]}
    while [ "$i" -lt "$n" ]; do
      case "${words[$i]}" in
        sudo|env|command|nohup|time) i=$((i + 1)) ;;
        [A-Za-z_]*=*) i=$((i + 1)) ;;
        *) break ;;
      esac
    done
    [ $((n - i)) -ge 3 ] || continue
    if { [ "${words[$i]}" = gh ] && [ "${words[$((i + 1))]}" = pr ]; } \
      || { [ "${words[$i]}" = glab ] && [ "${words[$((i + 1))]}" = mr ]; }; then
      if [ "${words[$((i + 2))]}" = merge ]; then
        local j
        for ((j = i + 3; j < n; j++)); do
          printf '%s\n' "${words[$j]}"
        done
        return 0
      fi
    fi
  done < <(printf '%s\n' "$stripped" | awk '{ gsub(/&&|\|\||[;|&()]/, "\n"); print }')
  return 1
}

# _cim_ref_from_args — read merge args on stdin, print the explicit PR/MR ref
# (number, URL or branch): the first token that is neither a flag, a flag's
# value, nor a redirection.
_cim_ref_from_args() {
  local tok skip=0
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$tok" in
      -t|--subject|-b|--body|-F|--body-file|-A|--author-email|--match-head-commit|-m|--message|--sha|-R|--repo)
        skip=1; continue ;;
      -*) continue ;;
      *[\<\>]*) continue ;;
    esac
    printf '%s' "$tok"
    return 0
  done
}

# _cim_pr_json <ref> — the PR's closing refs, body and head branch.
_cim_pr_json() {
  _cim_gh pr view "$1" --json closingIssuesReferences,body,headRefName || true
}

# _cim_closing_refs <pr-json> — print one closing-ref number per line.
# Authoritative source is closingIssuesReferences; the body is parsed for
# `Closes|Fixes (GH )?#<n>` as a fallback.
_cim_closing_refs() {
  local json="$1" refs body body_refs
  [ -n "$json" ] || return 0
  refs=$(printf '%s' "$json" | jq -r '.closingIssuesReferences[]?.number // empty' 2>/dev/null || true)
  body=$(printf '%s' "$json" | jq -r '.body // ""' 2>/dev/null || true)
  body_refs=$(printf '%s' "$body" \
    | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+(GH[[:space:]]+)?#[0-9]+' \
    | grep -oE '#[0-9]+' | tr -d '#' || true)
  printf '%s\n%s\n' "$refs" "$body_refs" | grep -E '^[0-9]+$' | sort -un
}

# _cim_local_issue <db> <n> — map a closing-ref <n> to a local issues.id.
# A GH issue number (issues.gh_iid=<n>) wins; otherwise <n> as a direct local id
# if such a row exists. Prints the local id, or empty when ambiguous/unmapped.
_cim_local_issue() {
  local db="$1" n="$2" by_gh by_id
  n=$(tmb_sql_int "$n")
  [ -n "$n" ] || return 0
  by_gh=$(tmb_sqlite_ro "$db" "SELECT id FROM issues WHERE gh_iid = ${n};")
  by_gh=$(tmb_sql_int "$by_gh")
  if [ -n "$by_gh" ]; then
    printf '%s' "$by_gh"
    return 0
  fi
  by_id=$(tmb_sqlite_ro "$db" "SELECT id FROM issues WHERE id = ${n};")
  by_id=$(tmb_sql_int "$by_id")
  [ -n "$by_id" ] && printf '%s' "$by_id"
}

# _cim_sync_on <db> — the remote sync gate the server applies.
_cim_sync_on() {
  case "${TMB_DISABLE_REMOTE_SYNC:-}" in
    ''|0|false|FALSE|False) ;;
    *) return 1 ;;
  esac
  local mode
  mode=$(tmb_config_get issue_sync "$1")
  case "$mode" in
    ''|off) return 1 ;;
  esac
  return 0
}

# _cim_tasks_sql <db> <branch> — SQL that closes the live tasks of the merged
# branch (review bypass rows first, while completed_at still anchors the rule)
# and closes their open runs as completed.
_cim_tasks_sql() {
  local db="$1" SAFE_BRANCH SAFE_NOW rows row SAFE_TID SAFE_ISSUE sha sha_json audit
  SAFE_BRANCH=$(tmb_sql_quote "$2")
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  rows=$(tmb_sqlite_ro "$db" "SELECT t.id || '|' || t.issue_id || '|' || COALESCE(t.commit_sha, '') FROM tasks t
     WHERE t.branch_id = '${SAFE_BRANCH}' AND t.status IN (${_CIM_LIVE}, 'closed')
       AND NOT ${_CIM_HAS_PASS} AND NOT ${_CIM_SKIP_RECORDED} ORDER BY t.id;")
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    SAFE_TID=$(tmb_sql_int "${row%%|*}")
    row="${row#*|}"
    SAFE_ISSUE=$(tmb_sql_int "${row%%|*}")
    sha="${row#*|}"
    case "$sha" in ''|*[!0-9a-f]*) sha_json=null ;; *) sha_json="\"$sha\"" ;; esac
    [ -n "$SAFE_TID" ] && [ -n "$SAFE_ISSUE" ] || continue
    audit=$(tmb_audit_sql "$SAFE_ISSUE" "$2" "$_CIM_FROM" "review_gate_bypassed" \
      "Task ${SAFE_TID} merged without a passing review" \
      "{\"task_id\":${SAFE_TID},\"commit_sha\":${sha_json},\"closed_by\":\"close-issue-on-merge\"}") || continue
    printf '%s\n' "$audit"
  done <<EOF
$rows
EOF
  printf "UPDATE agent_runs
       SET completed_at = '%s',
           duration_ms = CASE WHEN duration_ms = 0
             THEN COALESCE(CAST(ROUND((julianday('%s') - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)
             ELSE duration_ms END,
           exit_reason = 'completed'
     WHERE completed_at IS NULL
       AND task_id IN (SELECT id FROM tasks WHERE branch_id = '%s' AND status IN (%s, 'closed'));
    UPDATE tasks
       SET status = 'closed', completed_at = COALESCE(completed_at, '%s'), updated_at = '%s'
     WHERE branch_id = '%s' AND status IN (%s);\n" \
    "$SAFE_NOW" "$SAFE_NOW" "$SAFE_BRANCH" "$_CIM_LIVE" "$SAFE_NOW" "$SAFE_NOW" "$SAFE_BRANCH" "$_CIM_LIVE"
}

# _cim_issue_sql <db> <local_id> <branch> <sync_on> — SQL for one resolved
# issue: close it (or defer it over live tasks off the merged branch) and
# record the remote-skip when the sync gate is off. Prints nothing for an
# already-closed issue. Sets _CIM_CLOSED_IDS for the post-commit remote close.
_cim_issue_sql() {
  local db="$1" SAFE_ID SAFE_BRANCH SAFE_NOW status gh_iid blocking ids
  SAFE_ID=$(tmb_sql_int "$2")
  [ -n "$SAFE_ID" ] || return 0
  SAFE_BRANCH=$(tmb_sql_quote "$3")
  status=$(tmb_sqlite_ro "$db" "SELECT status FROM issues WHERE id = ${SAFE_ID};")
  [ "$status" = "open" ] || return 0
  gh_iid=$(tmb_sql_int "$(tmb_sqlite_ro "$db" "SELECT gh_iid FROM issues WHERE id = ${SAFE_ID};")")
  blocking=$(tmb_sqlite_ro "$db" "SELECT id FROM tasks WHERE issue_id = ${SAFE_ID}
      AND status IN (${_CIM_LIVE}) AND branch_id != '${SAFE_BRANCH}' ORDER BY id;")
  if [ -n "$blocking" ]; then
    ids=$(printf '%s\n' "$blocking" | grep -E '^[0-9]+$' | paste -sd, -)
    tmb_audit_sql "$SAFE_ID" "" "$_CIM_FROM" "issue_auto_close_deferred" \
      "Merge left issue ${SAFE_ID} open: tasks ${ids} still live" \
      "{\"blocking_task_ids\":[${ids}],\"gh_iid\":${gh_iid:-null}}" || return 0
    return 0
  fi
  SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
  printf "UPDATE issues SET status = 'closed', closed_at = COALESCE(closed_at, '%s'), updated_at = '%s'
     WHERE id = %s AND status != 'closed';\n" "$SAFE_NOW" "$SAFE_NOW" "$SAFE_ID"
  tmb_audit_sql "$SAFE_ID" "" "$_CIM_FROM" "issue_auto_closed_on_merge" \
    "Auto-closed on PR merge" "{\"gh_iid\":${gh_iid:-null}}" || return 0
  if [ -n "$gh_iid" ] && [ "$4" != 1 ]; then
    tmb_audit_sql "$SAFE_ID" "" "$_CIM_FROM" "issue_auto_close_remote_skipped" \
      "Remote close of gh #${gh_iid} skipped: issue sync is off" \
      "{\"gh_iid\":${gh_iid},\"reason\":\"sync_gate_off\"}" || return 0
  fi
}

_close_issue_on_merge_main() {
  if [ "${TMB_DISABLE_CLOSE_ISSUE_ON_MERGE:-0}" = "1" ]; then
    exit 0
  fi

  command -v jq >/dev/null 2>&1 || exit 0

  local input tool_name cmd resp merge_args
  input=$(cat 2>/dev/null) || exit 0
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
  [ "$tool_name" = "Bash" ] || exit 0

  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
  resp=$(printf '%s' "$input" | jq -r '.tool_response | if type == "string" then . else tojson end' 2>/dev/null)
  [ -n "$cmd" ] || exit 0

  merge_args=$(_cim_merge_args "$cmd") || exit 0

  # The merge must have succeeded. A failed merge must never close anything.
  if printf '%s' "$resp" | grep -qiE '(is_error|"error"|failed to merge|not mergeable|merge conflict|GraphQL: |pull request is not mergeable)'; then
    exit 0
  fi

  command -v gh >/dev/null 2>&1 || exit 0

  local db
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] || exit 0
  [ -f "$db" ] || exit 0
  tmb_have_sqlite || exit 0

  # The PR/branch ref the merge targeted: an explicit token on the merge
  # statement (number, URL, or branch), else the current branch.
  local ref
  ref=$(printf '%s\n' "$merge_args" | _cim_ref_from_args)
  if [ -z "$ref" ]; then
    local cwd
    cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
    [ -n "$cwd" ] || cwd="$PWD"
    ref=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  fi
  [ -n "$ref" ] || exit 0
  [ "$ref" != "HEAD" ] || exit 0

  local pr_json head
  pr_json=$(_cim_pr_json "$ref")
  head=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || true)
  if [ -z "$head" ]; then
    case "$ref" in
      *[!0-9]*) case "$ref" in *://*) ;; *) head="$ref" ;; esac ;;
    esac
  fi

  local sync_on=0
  _cim_sync_on "$db" && sync_on=1

  # Every fragment below quotes or int-sanitizes its values.
  local SAFE_SQL="" n local_id issue_sql closed_ids=""
  [ -n "$head" ] && SAFE_SQL=$(_cim_tasks_sql "$db" "$head")

  local refs
  refs=$(_cim_closing_refs "$pr_json")
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    local_id=$(_cim_local_issue "$db" "$n")
    [ -n "$local_id" ] || continue
    issue_sql=$(_cim_issue_sql "$db" "$local_id" "$head" "$sync_on")
    [ -n "$issue_sql" ] || continue
    SAFE_SQL="${SAFE_SQL}
${issue_sql}"
    case "$issue_sql" in
      *issue_auto_closed_on_merge*) closed_ids="${closed_ids} ${local_id}" ;;
    esac
  done <<EOF
$refs
EOF

  [ -n "$SAFE_SQL" ] || exit 0
  tmb_db_write "$db" "$SAFE_SQL" >/dev/null || exit 0

  local SAFE_ID gh_iid rstate
  for SAFE_ID in $closed_ids; do
    SAFE_ID=$(tmb_sql_int "$SAFE_ID")
    [ -n "$SAFE_ID" ] || continue
    printf 'tmb: auto-closed issue %s on merge\n' "$SAFE_ID" >&2
    [ "$sync_on" = 1 ] || continue
    gh_iid=$(tmb_sql_int "$(tmb_sqlite_ro "$db" "SELECT gh_iid FROM issues WHERE id = ${SAFE_ID};")")
    [ -n "$gh_iid" ] || continue
    rstate=$(_cim_gh issue view "$gh_iid" --json state -q '.state' || true)
    if [ "$rstate" != "CLOSED" ]; then
      _cim_gh issue close "$gh_iid" >/dev/null 2>&1 || true
    fi
  done

  exit 0
}

# Execute only when run directly; when sourced, expose helpers for tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _close_issue_on_merge_main
fi
