#!/usr/bin/env bash
# PostToolUse hook on Bash — auto-close the issue a merged PR resolved (#122/#836).
#
# The #89 clean-merged-branch hook removes the merged branch + worktree, but the
# resolved issue still lingers open. This closes it — both the local trajectory
# row and its remote twin — after a SUCCESSFUL `gh pr merge` / `glab mr merge`:
#   - resolve the PR's RESOLVED issue from an EXPLICIT closing-ref ONLY
#     (`gh pr view <pr-or-branch> --json closingIssuesReferences,body`, plus a
#     `Closes|Fixes (GH )?#<n>` body parse). Never guess.
#   - map <n> to the local issue: a GH number → issues.gh_iid; a local id →
#     issues.id directly.
#   - close BOTH idempotently: remote `gh issue close <gh_iid>` (skip if already
#     closed), local `UPDATE issues SET status='closed' WHERE id=<local> AND
#     status!='closed'`, and emit an issue_auto_closed_on_merge audit row.
#
# Non-load-bearing: every path exits 0. Fail OPEN / no-op when sqlite/DB absent,
# no closing-ref, the link is ambiguous, or already closed. gh calls are bounded
# with `timeout`. Bypass: TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

# _gh_timeout <args...> — run gh bounded; never hangs the hook.
_cim_gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 gh "$@" 2>/dev/null
  else
    gh "$@" 2>/dev/null
  fi
}

# _cim_closing_refs <pr-or-branch> — print one closing-ref number per line.
# Authoritative source is GitHub's closingIssuesReferences; the body is parsed
# for `Closes|Fixes (GH )?#<n>` as a fallback / belt-and-suspenders.
_cim_closing_refs() {
  local ref="$1" json refs body
  json=$(_cim_gh pr view "$ref" --json closingIssuesReferences,body || true)
  [ -n "$json" ] || return 0
  refs=$(printf '%s' "$json" | jq -r '.closingIssuesReferences[]?.number // empty' 2>/dev/null || true)
  body=$(printf '%s' "$json" | jq -r '.body // ""' 2>/dev/null || true)
  local body_refs
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

_close_issue_on_merge_main() {
  if [ "${TMB_DISABLE_CLOSE_ISSUE_ON_MERGE:-0}" = "1" ]; then
    exit 0
  fi

  command -v jq >/dev/null 2>&1 || exit 0

  local input tool_name cmd resp
  input=$(cat 2>/dev/null) || exit 0
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
  [ "$tool_name" = "Bash" ] || exit 0

  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
  resp=$(printf '%s' "$input" | jq -r '.tool_response | if type == "string" then . else tojson end' 2>/dev/null)
  [ -n "$cmd" ] || exit 0

  # Act only on a PR/MR merge command (word-boundary match; gh/glab parity).
  if ! printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])(gh[[:space:]]+pr[[:space:]]+merge|glab[[:space:]]+mr[[:space:]]+merge)([^[:alnum:]_-]|$)'; then
    exit 0
  fi

  # The merge must have succeeded. A failed merge must never close an issue.
  if printf '%s' "$resp" | grep -qiE '(is_error|"error"|failed to merge|not mergeable|merge conflict|GraphQL: |pull request is not mergeable)'; then
    exit 0
  fi

  command -v gh >/dev/null 2>&1 || exit 0

  # Resolve the DB; fail open when absent.
  local db
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] || exit 0
  [ -f "$db" ] || exit 0
  tmb_have_sqlite || exit 0

  # Derive the PR/branch ref the merge targeted: an explicit token on the merge
  # command line (number, URL, or branch), else the current branch.
  local ref
  ref=$(_cim_ref_from_cmd "$cmd")
  if [ -z "$ref" ]; then
    local cwd
    cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
    [ -n "$cwd" ] || cwd="$PWD"
    ref=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  fi
  [ -n "$ref" ] || exit 0
  [ "$ref" != "HEAD" ] || exit 0

  # Explicit closing-refs only. No ref → no-op.
  local refs
  refs=$(_cim_closing_refs "$ref")
  [ -n "$refs" ] || exit 0

  local n local_id
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    local_id=$(_cim_local_issue "$db" "$n")
    [ -n "$local_id" ] || continue
    _cim_close_one "$db" "$local_id"
  done <<EOF
$refs
EOF

  exit 0
}

# _cim_ref_from_cmd <cmd> — print the explicit PR/MR ref named on the merge
# command line (a number, URL, or non-flag token), or empty.
_cim_ref_from_cmd() {
  local cmd="$1" merge_args tok
  merge_args=$(printf '%s' "$cmd" | sed -E 's/^.*(gh[[:space:]]+pr|glab[[:space:]]+mr)[[:space:]]+merge//')
  for tok in $merge_args; do
    case "$tok" in
      -*) continue ;;
      '') continue ;;
    esac
    printf '%s' "$tok"
    return 0
  done
}

# _cim_close_one <db> <local_id> — idempotently close one local issue + its
# remote twin, and emit an audit row. No-op when already closed.
_cim_close_one() {
  local db="$1" local_id="$2"
  local status gh_iid
  status=$(tmb_sqlite_ro "$db" "SELECT status FROM issues WHERE id = ${local_id};")
  [ "$status" = "closed" ] && return 0
  gh_iid=$(tmb_sqlite_ro "$db" "SELECT gh_iid FROM issues WHERE id = ${local_id};")
  gh_iid=$(tmb_sql_int "$gh_iid")

  # Remote: close the GH twin, skipping if it is already closed.
  if [ -n "$gh_iid" ]; then
    local rstate
    rstate=$(_cim_gh issue view "$gh_iid" --json state -q '.state' || true)
    if [ "$rstate" != "CLOSED" ]; then
      _cim_gh issue close "$gh_iid" >/dev/null 2>&1 || true
    fi
  fi

  # Local: close idempotently and record the audit row in one transaction.
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sqlite3 -cmd '.timeout 1000' "$db" "
    UPDATE issues
       SET status = 'closed', closed_at = '${now}', updated_at = '${now}'
     WHERE id = ${local_id} AND status != 'closed';
    INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
    SELECT ${local_id}, 'executor', 'issue_auto_closed_on_merge',
           'Auto-closed on PR merge', json_object('gh_iid', ${gh_iid:-null}), '${now}'
     WHERE (SELECT changes()) > 0;
  " >/dev/null 2>&1 || true

  printf 'tmb: auto-closed issue %s on merge%s\n' "$local_id" \
    "${gh_iid:+ (gh #$gh_iid)}" >&2
}

# Execute only when run directly; when sourced, expose helpers for tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _close_issue_on_merge_main
fi
