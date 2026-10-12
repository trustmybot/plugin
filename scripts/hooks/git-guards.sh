#!/usr/bin/env bash
# Hook: Enforce git workflow rules driven by the repo's branching model.
# 1. PR must target pr_target
# 2. No direct commits/merges/rebases to any shared workflow base
# 3. No force push to protected_branches
# 4. New branches must be based on latest pr_target
#
# Every rule judges one executable statement of the command at a time
# (lib/cmd-analysis.sh: heredoc bodies and quoted text are data, never
# statements) against the repo and branch of that statement's effective dir —
# its `git -C <path>`, else a preceding `cd <path>`, else the payload cwd when
# that cwd belongs to a single checkout. A rule that needs the branch of a
# statement whose dir is ambiguous (the repo has linked worktrees and the
# statement names no dir, or names it through a variable) denies with
# ambiguous_git_target and its remedy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

# Early-exit: skip all analysis and DB work when no git/gh/glab word appears.
_cmd_needs_git_guard() {
  printf '%s' "$1" | grep -E '(^|[^[:alnum:]_./-])(git|gh|glab)([[:space:]]|$)' >/dev/null
}
_cmd_needs_git_guard "$CMD" || exit 0

CWD=$(tmb_payload_cwd "$INPUT")
STMTS=$(tmb_cmd_statements "$CMD" "$CWD")
[ -n "$STMTS" ] || exit 0
_DB=$(tmb_db_path 2>/dev/null || true)

deny() {
  jq -nc --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# load_policy <git_root>
# Sets _GIT_ROOT, PR_TARGET, BRANCHING_MODEL and PROTECTED_BRANCHES from the
# repos row of <git_root> — the sole source of truth (#980). Returns 1 when the
# repo is unresolved or unregistered: in a multi-repo workspace only a
# registered product repo is guarded (#693); siblings no-op. A registered repo
# without policy gets safe defaults (github-flow, main, [main,dev]) so
# protected-branch ops still deny.
load_policy() {
  local root="$1" row raw=""
  [ -n "$root" ] || return 1
  _GIT_ROOT="$root"
  PR_TARGET=""
  BRANCHING_MODEL=""
  if [ -n "$_DB" ] && [ -f "$_DB" ] && tmb_have_sqlite; then
    tmb_repo_is_registered "$_DB" "$root" || return 1
    row=$(tmb_repo_resolve "$_DB" "$root")
    PR_TARGET=$(printf '%s' "$row" | cut -d'|' -f1)
    BRANCHING_MODEL=$(printf '%s' "$row" | cut -d'|' -f2)
    raw=$(printf '%s' "$row" | cut -d'|' -f3)
  fi
  [ -n "$BRANCHING_MODEL" ] || BRANCHING_MODEL="github-flow"
  [ -n "$PR_TARGET" ] || PR_TARGET="main"
  [ -n "$raw" ] || raw='["main","dev"]'
  if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    deny "BLOCKED: this repo's protected_branches is malformed JSON. Fix the repos row or re-run bro onboarding."
  fi
  PROTECTED_BRANCHES=$(printf '%s' "$raw" | jq -r '.[]' 2>/dev/null || true)
  return 0
}

branch_is_protected() {
  local branch="$1" protected_branch
  while IFS= read -r protected_branch; do
    [ "$branch" = "$protected_branch" ] && return 0
  done <<< "$PROTECTED_BRANCHES"
  return 1
}

# dir_branch <dir>
# The branch checked out in <dir>. On a detached HEAD (SWE worktree pattern)
# the branch comes from the DB: the newest task whose branch_id ends in
# /<basename of dir> (tmb_task_by_slug); empty when nothing matches.
dir_branch() {
  local wd="$1" result
  result=$(git -C "$wd" branch --show-current 2>/dev/null || true)
  if [ -n "$result" ]; then
    printf '%s' "$result"
    return 0
  fi
  if [ -n "$_DB" ] && [ -f "$_DB" ] && tmb_have_sqlite; then
    tmb_task_by_slug "$_DB" "$(basename "$wd")" branch_id | tr -d '\n'
  fi
}

# dir_in_worktree <dir> — exit 0 when <dir> is inside a LINKED worktree.
dir_in_worktree() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" != "$(cd "$_GIT_ROOT" && pwd -P)" ]
}

# need_dir <dir> <statement> — deny ambiguous_git_target when the statement's
# dir is ambiguous; return 1 when it is unknown or does not exist yet (a clone
# the same command creates) — there is no branch to judge.
need_dir() {
  case "$1" in
    '?') tmb_deny_ambiguous_git_target "$2"; exit 0 ;;
    -|'') return 1 ;;
  esac
  [ -d "$1" ]
}

# rule2_protected_bases
# Print (one per line, deduped) every workflow base that must not accept a direct
# commit/merge/rebase: protected_branches ∪ target_branch (PR_TARGET) ∪ pr_target
# (when the column exists) ∪ DISTINCT tasks.parent_branch_id (this repo, plus
# NULL-repo tasks for single-repo installs). DB rows are added only when the DB is
# reachable; the protected_branches/target_branch fallbacks keep the set non-empty.
rule2_protected_bases() {
  {
    printf '%s\n' "$PROTECTED_BRANCHES"
    [ -n "$PR_TARGET" ] && printf '%s\n' "$PR_TARGET"
    if [ -n "$_DB" ] && [ -f "$_DB" ] && tmb_have_sqlite; then
      local root_sql repo_name repo_filter
      root_sql=$(tmb_sql_quote "$_GIT_ROOT")
      if [ -n "$(tmb_sqlite_ro "$_DB" "SELECT 1 FROM pragma_table_info('repos') WHERE name='pr_target' LIMIT 1;")" ]; then
        tmb_sqlite_ro "$_DB" "SELECT pr_target FROM repos WHERE path = '${root_sql}' AND pr_target IS NOT NULL AND pr_target != '';"
      fi
      repo_name=$(tmb_sqlite_ro "$_DB" "SELECT name FROM repos WHERE path = '${root_sql}' LIMIT 1;")
      if [ -n "$repo_name" ]; then
        repo_filter="(repo = '$(tmb_sql_quote "$repo_name")' OR repo IS NULL)"
      else
        repo_filter="repo IS NULL"
      fi
      tmb_sqlite_ro "$_DB" "SELECT DISTINCT parent_branch_id FROM tasks WHERE parent_branch_id IS NOT NULL AND parent_branch_id != '' AND ${repo_filter};"
    fi
  } | grep -v '^[[:space:]]*$' | sort -u
}

# rule2_recovery <dir>
# Recovery text for a Rule-2 deny: PR-into-pr_target when the statement's repo
# has a remote (read with `git -C <dir> remote -v`), the leave-unmerged route
# when it has none, nothing when the dir is unknown.
rule2_recovery() {
  local dir="$1"
  case "$dir" in -|'?'|'') return 0 ;; esac
  [ -d "$dir" ] || return 0
  if [ -n "$(git -C "$dir" remote -v 2>/dev/null || true)" ]; then
    printf ' Push your feature branch and open a PR into %s: git push origin <branch> && gh pr create --base %s --head <branch>.' "$PR_TARGET" "$PR_TARGET"
  else
    printf ' This repo has no remote — leave the branch unmerged and surface it to the Human for integration.'
  fi
}

# _rule2_inline_landings <statements>
# Print every commit's provable landing branch, one per line, or nothing to
# disable the override. A fresh-clone remedy like `git clone <url> x && cd x &&
# git checkout -b feat && git commit` has no clone dir at PreToolUse time, so
# the commit's dir cannot name its branch; walk the statements tracking the
# branch the command has switched to (`checkout -b|switch -c <name>` and plain
# `checkout|switch <name>`). Every commit must land on a known branch, else the
# override is disabled (empty) and the per-statement dir decides. A statement
# scoped with `git -C` also disables it (#54/#58).
_rule2_inline_landings() {
  printf '%s\n' "$1" | awk '
    {
      s = $0
      if (s ~ /^git[[:space:]]+-C([[:space:]]|$)/ && s ~ /(commit|checkout|switch)/) { bad = 1; exit }
      if (s ~ /^git[[:space:]]+commit([[:space:]]|$)/) {
        saw = 1
        if (!known) { bad = 1; exit }
        landings = landings current "\n"
      } else if (s ~ /^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]/ || s ~ /^git[[:space:]]+switch[[:space:]]+-c[[:space:]]/) {
        m = split(s, tok, /[[:space:]]+/)
        name = ""
        for (j = 1; j <= m; j++) if (tok[j] == "-b" || tok[j] == "-c") { if (j < m) name = tok[j + 1]; break }
        if (name == "") { bad = 1; exit }
        current = name; known = 1
      } else if (s ~ /^git[[:space:]]+(checkout|switch)([[:space:]]|$)/) {
        m = split(s, tok, /[[:space:]]+/)
        name = (m >= 3 ? tok[3] : "")
        if (name == "" || name ~ /^-/) { bad = 1; exit }
        current = name; known = 1
      }
    }
    END { if (!bad && saw) printf "%s", landings }
  '
}

INLINE_LANDINGS=$(_rule2_inline_landings "$(printf '%s\n' "$STMTS" | cut -f2-)")

while IFS="$(printf '\t')" read -r DIR STMT <&3; do
  [ -n "$STMT" ] || continue
  SUB=$(tmb_git_subcommand "$STMT")
  FORGE=""
  case "$STMT" in
    "gh pr create"|"gh pr create "*) FORGE="gh" ;;
    "glab mr create"|"glab mr create "*) FORGE="glab" ;;
  esac
  case "$SUB" in
    commit|"commit "*|merge|"merge "*|rebase|"rebase "*|cherry-pick|"cherry-pick "*|push|"push "*|"checkout -b "*|"switch -c "*) ;;
    *) [ -n "$FORGE" ] || continue ;;
  esac

  # A dir behind a variable, `cd -` or popd is judged like a statement that
  # names none: ambiguous when the payload cwd's repo has linked worktrees
  # (as git-push-guard), else the payload cwd.
  [ "$DIR" != - ] || DIR=$(tmb_cwd_state "$CWD")

  # H8: no resolvable repo (the multi-repo workspace root, a dir outside any repo) →
  # no guessed policy. An ambiguous dir still names its repo.
  load_policy "$(tmb_stmt_repo_root "$DIR" "$CWD")" || continue

  # --- Rule 1: PR must target pr_target, with the dev → main release-merge exception ---
  # Feature branches PR to PR_TARGET. When PR_TARGET == dev, `dev → main` is
  # the release merge: allowed only when the head is dev (explicit --head /
  # --source-branch, else the branch of the statement's dir).
  if [ "$FORGE" = "gh" ]; then
    BASE_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '--base[= ][^[:space:]]+' | head -1 | sed -E 's/--base[= ]+//' || true)
    if [ -n "$BASE_BRANCH" ] && [ "$BASE_BRANCH" = "$PR_TARGET" ]; then
      :
    elif [ "$PR_TARGET" = "dev" ] && [ "$BASE_BRANCH" = "main" ]; then
      HEAD_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '--head[= ][^[:space:]]+' | head -1 | sed -E 's/--head[= ]+//' || true)
      if [ -z "$HEAD_BRANCH" ] && need_dir "$DIR" "$STMT"; then
        HEAD_BRANCH=$(git -C "$DIR" branch --show-current 2>/dev/null || true)
      fi
      if [ "$HEAD_BRANCH" != "dev" ]; then
        deny "BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must PR to ${PR_TARGET}: gh pr create --base ${PR_TARGET} --head <branch>. Got --head=${HEAD_BRANCH}."
      fi
    else
      deny "BLOCKED: PRs must target ${PR_TARGET} branch. Use: gh pr create --base ${PR_TARGET} --head <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)"
    fi
    continue
  fi
  if [ "$FORGE" = "glab" ]; then
    TARGET_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '--target-branch[= ][^[:space:]]+' | head -1 | sed -E 's/--target-branch[= ]+//' || true)
    [ -n "$TARGET_BRANCH" ] || TARGET_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '(^|[[:space:]])-b[= ][^[:space:]]+' | head -1 | sed -E 's/^[[:space:]]*-b[= ]+//' || true)
    SOURCE_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '--source-branch[= ][^[:space:]]+' | head -1 | sed -E 's/--source-branch[= ]+//' || true)
    [ -n "$SOURCE_BRANCH" ] || SOURCE_BRANCH=$(printf '%s' "$STMT" | grep -oE -- '(^|[[:space:]])-s[= ][^[:space:]]+' | head -1 | sed -E 's/^[[:space:]]*-s[= ]+//' || true)
    if [ "$TARGET_BRANCH" = "$PR_TARGET" ]; then
      :
    elif [ "$PR_TARGET" = "dev" ] && [ "$TARGET_BRANCH" = "main" ]; then
      if [ -z "$SOURCE_BRANCH" ] && need_dir "$DIR" "$STMT"; then
        SOURCE_BRANCH=$(git -C "$DIR" branch --show-current 2>/dev/null || true)
      fi
      if [ "$SOURCE_BRANCH" != "dev" ]; then
        deny "BLOCKED: only 'dev → main' is permitted as a release merge. Feature branches must MR to ${PR_TARGET}: glab mr create --target-branch ${PR_TARGET} --source-branch <branch>. Got --source-branch=${SOURCE_BRANCH}."
      fi
    else
      deny "BLOCKED: MRs must target ${PR_TARGET} branch. Use: glab mr create --target-branch ${PR_TARGET} --source-branch <branch>. (Dev → main release merges are allowed when PR_TARGET=dev.)"
    fi
    continue
  fi

  case "$SUB" in
    # --- Rule 2a: local integration is PR-only in the main checkout ---
    # merge / rebase / cherry-pick are SWE mechanics inside a task worktree and
    # denied in the main checkout whatever the target (a data-derived protected
    # set can always miss a base the agent believes in).
    merge|"merge "*|rebase|"rebase "*|cherry-pick|"cherry-pick "*)
      need_dir "$DIR" "$STMT" || continue
      if ! dir_in_worktree "$DIR"; then
        deny "BLOCKED: local merge/rebase/cherry-pick in the main checkout is not allowed — integration is PR-only.$(rule2_recovery "$DIR")"
      fi
      ;;

    # --- Rule 2b: commits stay off shared bases ---
    # Protected set: repos.protected_branches ∪ target_branch ∪ repos.pr_target
    # ∪ every task's parent_branch_id. A commit's branch is its provable inline
    # landing (fresh-clone remedy) when every commit has one, else the branch of
    # its dir.
    commit|"commit "*)
      RULE2_PROTECTED=$(rule2_protected_bases || true)
      if [ -n "$INLINE_LANDINGS" ]; then
        BRANCH=$(printf '%s\n' "$INLINE_LANDINGS" | grep -Fxf <(printf '%s\n' "$RULE2_PROTECTED") | head -1 || true)
      else
        need_dir "$DIR" "$STMT" || continue
        BRANCH=$(dir_branch "$DIR")
        printf '%s\n' "$RULE2_PROTECTED" | grep -xF "$BRANCH" >/dev/null || BRANCH=""
      fi
      if [ -n "$BRANCH" ]; then
        deny "BLOCKED: ${BRANCH} is a shared workflow base — no direct commits/merges/rebases.$(rule2_recovery "$DIR")"
      fi
      ;;

    # --- Rule 3: no force push to protected_branches ---
    push|"push "*)
      read -r -a PUSH_ARGS <<< "${SUB#push}"
      IS_FORCE=""
      PUSH_POS=()
      for a in ${PUSH_ARGS[@]+"${PUSH_ARGS[@]}"}; do
        case "$a" in
          --force|--force-with-lease|--force-with-lease=*|-f) IS_FORCE=1 ;;
          -*) ;;
          *) PUSH_POS+=("$a") ;;
        esac
      done
      [ -n "$IS_FORCE" ] || continue
      PUSH_TARGET=""
      case "${PUSH_POS[0]:-}" in
        origin|upstream) PUSH_TARGET="${PUSH_POS[1]:-}" ;;
      esac
      if [ -z "$PUSH_TARGET" ]; then
        need_dir "$DIR" "$STMT" || continue
        PUSH_TARGET=$(git -C "$DIR" branch --show-current 2>/dev/null || true)
      fi
      if [ -n "$PUSH_TARGET" ] && branch_is_protected "$PUSH_TARGET"; then
        deny "BLOCKED: Force push to ${PUSH_TARGET} is forbidden. This is destructive and irreversible."
      fi
      ;;

    # --- Rule 4: new branches start from the latest pr_target ---
    # H3: a configured PR_TARGET that does not exist in the repo falls back to
    # the repo's real default branch. The remote freshness check is skipped
    # when the repo has no origin or origin/<target> is missing.
    "checkout -b "*|"switch -c "*)
      need_dir "$DIR" "$STMT" || continue
      BRANCH=$(dir_branch "$DIR")
      RULE4_TARGET="$PR_TARGET"
      if ! git -C "$DIR" rev-parse --verify --quiet "$PR_TARGET" >/dev/null 2>&1 \
         && ! git -C "$DIR" rev-parse --verify --quiet "origin/$PR_TARGET" >/dev/null 2>&1; then
        DEFAULT_BRANCH=$(tmb_repo_default_branch "$_GIT_ROOT")
        [ -n "$DEFAULT_BRANCH" ] && RULE4_TARGET="$DEFAULT_BRANCH"
      fi
      if [ -n "$BRANCH" ] && [ "$BRANCH" != "$RULE4_TARGET" ]; then
        deny "BLOCKED: New branches must be created from ${RULE4_TARGET}. Currently on '${BRANCH}'. Run: git checkout ${RULE4_TARGET} && git pull origin ${RULE4_TARGET} first."
      fi
      if [ -z "$BRANCH" ]; then
        deny "BLOCKED: Detached HEAD detected. Run: git checkout -B ${RULE4_TARGET} origin/${RULE4_TARGET} to reattach, then create your feature branch."
      fi
      [ -n "$(git -C "$DIR" remote get-url origin 2>/dev/null || true)" ] || continue
      git -C "$DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 fetch origin "$RULE4_TARGET" --quiet 2>/dev/null || true
      LOCAL=$(git -C "$DIR" rev-parse --verify "${RULE4_TARGET}" 2>/dev/null || true)
      REMOTE=$(git -C "$DIR" rev-parse --verify "origin/${RULE4_TARGET}" 2>/dev/null || true)
      if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
        deny "BLOCKED: Local ${RULE4_TARGET} is behind origin/${RULE4_TARGET}. Run: git pull origin ${RULE4_TARGET} first."
      fi
      ;;
  esac
done 3<<< "$STMTS"

exit 0
