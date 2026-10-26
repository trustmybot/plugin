#!/usr/bin/env bash
# PreToolUse hook — containment guard: an agent writes only under its run's root.
#
# Fires on: PreToolUse — matcher: Write|Edit|MultiEdit|NotebookEdit|Bash
#
# Root, by the caller's identity (never its cwd — GH 1550):
#   swe — its task's worktree, tmb_agent_context in lib/agent-context.sh:
#     task_id=<N> from its spawn transcript (else the agent_runs row bound to
#     its agent_id) → tasks.repo → repos.path → <repos.path>/.claude/worktrees/
#     <branch slug>. A piece missing → every write is denied (devices aside)
#     with a message naming that piece, audited with content.reason
#     `unbound_caller`; Bash with no write runs. The root never widens to the
#     project.
#   code-reviewer — the project root (a read-only reviewer; its row opens only
#     at SubagentStop).
#   bro (no agent_type, or bro) — the project root.
# The project root is the project holding the resolved trajectory DB, else
# CLAUDE_PROJECT_DIR. The payload cwd is only the base a relative path joins.
#
#   Write/Edit/MultiEdit/NotebookEdit — deny when the canonical file_path
#     (symlinks followed before `..` applies, as the kernel does; /tmp ≡
#     /private/tmp) is outside the root.
#   Bash — deny when the payload cwd is outside the root (not judged for a
#     swe, whose shell is shared with the session), or when a path the
#     command writes (tmb_cmd_write_paths in lib/cmd-analysis.sh: redirect
#     targets, tee, cp/mv/rsync/install, mkdir, rm, touch, links, sed -i,
#     git worktree add, git clone, the tar/make/env -C and npm --prefix dir,
#     the tree a mutating git subcommand writes (its -C dir or own dir), the
#     write calls' path arguments of interpreter one-liners and programs fed
#     to an interpreter through a heredoc, each in its statement's own cd dir)
#     is outside the root. Data heredocs and quoted text are data, not syntax.
#     Variables set earlier in the same command are resolved; ~, $HOME,
#     $TMPDIR and $TMB_MODEL_CACHE_DIR are expanded; $OLDPWD is the dir before
#     the command's last cd. A for / while-read loop variable fed by a glob or
#     by find / ls / git ls-files / git diff --name-only / rg --files / fd
#     listing only paths inside the root is judged where its files lie; a
#     target with .. after a glob component is denied. A target behind a
#     variable the command does not set is allowed only when the literal
#     directory before the variable is inside the root; otherwise denied with
#     the variable named. Reads are never judged.
#   Always allowed, mirroring the Claude Code sandbox: the model cache
#     (TMB_MODEL_CACHE_DIR, default ${HF_HOME:-~/.cache/huggingface}), the
#     host's own temp dir ($TMPDIR when the host sets it, e.g. /tmp/claude-501,
#     and its realpath) and /dev/null, /dev/stdout, /dev/stderr, /dev/tty,
#     /dev/fd/*.
#   Main session only (bro: no agent_type, or bro):
#     Claude Code's own host-owned state — its per-project dir
#     (${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<slug>, the slug being the
#     path with every non-alphanumeric character turned into `-`; Claude Code
#     names it after CLAUDE_PROJECT_DIR, so in a session nested below the
#     project both that slug and the root's slug are allowed) and its plans
#     dir (.../plans). swe and code-reviewer never get these.
#
# Every denial writes one containment_denied audit row (from_node
# hook:containment-guard, content {tool, path, root, task_id}, plus reason for
# an unbound swe, whose root is null) and names the
# root and the offending path. No trajectory DB (project not onboarded) →
# allow; a DB that resolves but cannot be read → deny (fail closed).
set -uo pipefail

# One audit write; keeps the hooks.json wrapper (5 s) above the write budget.
export TMB_DB_WRITE_RUN_BUDGET_MS=2500

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh"
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh disable=SC1091
. "$SCRIPT_DIR/lib/cmd-analysis.sh"
# shellcheck source=scripts/hooks/lib/agent-context.sh disable=SC1091
. "$SCRIPT_DIR/lib/agent-context.sh"

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || { echo "containment-guard: jq not found" >&2; exit 1; }

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

case "$(tmb_db_state)" in
  unresolved) exit 0 ;;
  error) tmb_deny_db_unavailable "containment-guard"; exit 0 ;;
esac
DB=$(tmb_db_path)

CWD=$(tmb_payload_cwd "$INPUT")

AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null || true)")
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
PROJECT_ROOT=$(tmb_project_root)
TASK_ID=""
ROOT=""
UNBOUND=""
BOUND=""
MISSING=""
if [ "$(tmb_swe_context "$AGENT_TYPE")" = "yes" ]; then
  CTX_RC=0
  tmb_agent_context "$INPUT" "$DB" || CTX_RC=$?
  TASK_ID="$TMB_CTX_TASK_ID"
  case "$CTX_RC" in
    0) ROOT="$TMB_CTX_WORKTREE"; BOUND="yes" ;;
    2) tmb_deny_db_unavailable "containment-guard"; exit 0 ;;
    *) UNBOUND="yes"; MISSING="$TMB_CTX_MISSING" ;;
  esac
fi
[ -n "$ROOT" ] || [ -n "$UNBOUND" ] || ROOT="$PROJECT_ROOT"
ROOT_C=""
[ -z "$ROOT" ] || ROOT_C=$(tmb_path_canonical "$ROOT")

CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-}}"
[ -n "$CACHE_DIR" ] || CACHE_DIR="$HOME/.cache/huggingface"
CACHE_C=$(tmb_path_canonical "$CACHE_DIR")
HOST_TMP_C=""
case "${TMPDIR:-}" in
  /?*) HOST_TMP_C=$(tmb_path_canonical "$TMPDIR") ;;
esac
# Claude Code's per-user temp root. /tmp is shared, so an existing one counts
# only when it is a real dir this user owns, never a link planted by another.
HARNESS_TMP="/tmp/claude-$(id -u)"
HARNESS_TMP_C=""
if [ ! -e "$HARNESS_TMP" ] && [ ! -L "$HARNESS_TMP" ]; then
  HARNESS_TMP_C=$(tmb_path_canonical "$HARNESS_TMP")
elif [ -d "$HARNESS_TMP" ] && [ ! -L "$HARNESS_TMP" ] && [ -O "$HARNESS_TMP" ]; then
  HARNESS_TMP_C=$(tmb_path_canonical "$HARNESS_TMP")
fi

# cc_project_dir <dir> — Claude Code's canonical projects/<slug> dir for <dir>.
cc_project_dir() {
  local slug
  slug=$(printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g')
  case "$slug" in
    *[A-Za-z0-9]*) tmb_path_canonical "$CC_HOME/projects/$slug" ;;
  esac
}

CC_PROJECT_C=""
CC_SESSION_C=""
CC_PLANS_C=""
case "$AGENT_TYPE" in
  ''|bro)
    if [ "$(tmb_swe_context "$AGENT_TYPE")" = "no" ]; then
      CC_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
      CC_PROJECT_C=$(cc_project_dir "$ROOT")
      [ -z "${CLAUDE_PROJECT_DIR:-}" ] || CC_SESSION_C=$(cc_project_dir "$CLAUDE_PROJECT_DIR")
      CC_PLANS_C=$(tmb_path_canonical "$CC_HOME/plans")
    fi
    ;;
esac

# under <canonical-path> <canonical-dir>
under() {
  [ "$1" = "$2" ] && return 0
  case "$1" in "${2%/}"/*) return 0 ;; esac
  return 1
}

# allowed <absolute-path> — inside the root, the model cache, the host temp
# dir, Claude Code's /tmp/claude-<uid>, a device, or (main session only)
# Claude Code's project and plans dirs.
allowed() {
  local c
  case "$1" in
    /dev/null|/dev/stdout|/dev/stderr|/dev/tty|/dev/fd/*) return 0 ;;
  esac
  [ -z "$UNBOUND" ] || return 1
  c=$(tmb_path_canonical "$1")
  under "$c" "$ROOT_C" && return 0
  under "$c" "$CACHE_C" && return 0
  [ -n "$HOST_TMP_C" ] && [ "$HOST_TMP_C" != "/" ] && under "$c" "$HOST_TMP_C" && return 0
  [ -n "$HARNESS_TMP_C" ] && under "$c" "$HARNESS_TMP_C" && return 0
  [ -n "$CC_PROJECT_C" ] && under "$c" "$CC_PROJECT_C" && return 0
  [ -n "$CC_SESSION_C" ] && under "$c" "$CC_SESSION_C" && return 0
  [ -n "$CC_PLANS_C" ] && under "$c" "$CC_PLANS_C"
}

# deny <path> [<reason>]
deny() {
  local path="$1" reason="${2:-}" content issue why=""
  if [ -n "$UNBOUND" ]; then
    why="unbound_caller: ${AGENT_ID:+swe agent_id ${AGENT_ID}: }${MISSING}"
    reason="BLOCKED: containment — this swe${AGENT_ID:+ (agent_id ${AGENT_ID})} has no root to write under: ${MISSING}. An swe writes under <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt. Target: ${path}. Report this to bro."
  fi
  content=$(jq -cn --arg tool "$TOOL_NAME" --arg path "$path" --arg root "$ROOT" --arg tid "$TASK_ID" --arg why "$why" \
    '{tool:$tool, path:$path, root:(if $root == "" then null else $root end), task_id:(if $tid == "" then null else ($tid | tonumber) end)}
     + (if $why == "" then {} else {reason:$why} end)')
  issue=-1
  if [ -n "$TASK_ID" ]; then
    issue=$(tmb_sql_int "$(tmb_sqlite_ro "$DB" "SELECT issue_id FROM tasks WHERE id = ${TASK_ID};")")
    [ -n "$issue" ] || issue=-1
  fi
  tmb_audit_append "$DB" "$issue" '' "hook:containment-guard" "containment_denied" \
    "${TOOL_NAME} denied: ${path} is outside ${ROOT:-any root (unbound swe ${AGENT_ID})}" "$content" || true
  [ -n "$reason" ] || reason="BLOCKED: containment — ${path} is outside this run's root ${ROOT}. TMB agents write only under their root (the task worktree for swe, the project for bro); put scratch files in ${ROOT%/}/.claude/tmb/scratch/ (or /tmp/claude-$(id -u))."
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# expand <word> — the absolute path a write-position word names; non-zero
# when it hides behind a variable or command the hook cannot resolve.
expand() {
  local p="$1" home_dir="$HOME"
  case "$p" in
    \~) p="$home_dir" ;;
    \~/*) p="$home_dir/${p#\~/}" ;;
  esac
  p="${p//\$\{HOME\}/$home_dir}"
  p="${p//\$HOME/$home_dir}"
  p="${p//\$\{TMB_MODEL_CACHE_DIR\}/$CACHE_DIR}"
  p="${p//\$TMB_MODEL_CACHE_DIR/$CACHE_DIR}"
  case "$p" in *'$'*|*'`'*|'~'*) return 1 ;; esac
  case "$p" in
    *'*'*|*'?'*|*'['*)
      p="${p%%[*?[]*}"
      case "$p" in */) ;; *) p=$(dirname "$p") ;; esac
      ;;
  esac
  case "$p" in /*) ;; *) p="$CWD/$p" ;; esac
  printf '%s\n' "$p"
}

if [ "$TOOL_NAME" != "Bash" ]; then
  TARGET=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || true)
  [ -n "$TARGET" ] || exit 0
  case "$TARGET" in /*) ;; *) TARGET="$CWD/$TARGET" ;; esac
  allowed "$TARGET" || deny "$TARGET"
  exit 0
fi

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
WRITES=""
[ -z "$COMMAND" ] || WRITES=$(tmb_cmd_write_paths "$COMMAND" "$CWD" raw "$ROOT")

# A command that writes nothing (git -C <project> status from another repo's
# cwd) is not judged by where it runs.
[ -z "$WRITES" ] || [ -n "$UNBOUND" ] || [ -n "$BOUND" ] || allowed "$CWD" || deny "$CWD"
[ -n "$WRITES" ] || exit 0

# unresolved <target> <var> — a write target behind a variable this command
# does not set: allowed only when the literal directory before the variable
# is inside the root. The deny names what hides the path: <var>, a dir from a
# cd / pushd / popd the guard cannot follow (PWD), a command substitution
# ($()), an inline program's process call ($(proc)), or its write builtin
# or module-qualified write callable held or aliased ($(alias-write)).
unresolved() {
  local raw="$1" var="${2:-}" lit dir why
  lit="${raw%%[\$\`]*}"
  case "$lit" in
    */*) dir="${lit%/*}"; [ -n "$dir" ] || dir=/ ;;
    *) dir="" ;;
  esac
  if [ -n "$dir" ] && dir=$(expand "$dir") && allowed "$dir"; then return 0; fi
  case "$var" in
    '$(proc)') why="comes from a process call in an inline program (subprocess, os.system, exec, spawn, …) whose command, arguments or cwd are not all plain literals, so the guard cannot tell what it writes; pass literal arguments, or run the command from the shell" ;;
    '$(alias-write)') why="is written through an aliased or stored write builtin the guard can't resolve; call open() (or the write method) directly with a literal path" ;;
    '$()') why="is built by a command substitution or backticks the guard cannot evaluate; inline the path" ;;
    PWD) why="is relative to a directory from a cd, pushd or popd the guard cannot resolve (cd -, popd, or a cd through a variable); cd to a literal path" ;;
    '') why="depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command" ;;
    *) why="depends on a variable the guard cannot resolve in this command: \$${var} is not set to a literal earlier in it; inline the path or set ${var}=<path> in the same command" ;;
  esac
  deny "$raw" "BLOCKED: write target \"$raw\" cannot be judged: ${why}."
}

# glob_climbs <target> — a `..` after a glob component: the glob may match a
# symlink, so where the `..` lands is unknown.
glob_climbs() {
  local tail
  case "$1" in *'*'*|*'?'*|*'['*) ;; *) return 1 ;; esac
  tail="${1#*[*?[]}"
  case "/$tail/" in */../*) return 0 ;; esac
  return 1
}

# climbs_back <absolute-path> — a .. leaves the root and a later name enters
# it again (cd .. && rm -rf <root-name>): the write lands on the root from
# outside it.
climbs_back() {
  local acc="" part left=0 inside=0
  local -a parts
  case "/$1/" in */../*) ;; *) return 1 ;; esac
  [ -n "$ROOT" ] || return 1
  IFS=/ read -r -a parts <<< "${1#/}"
  for part in ${parts[@]+"${parts[@]}"}; do
    case "$part" in
      ''|.) continue ;;
      ..) acc="${acc%/*}" ;;
      *) acc="$acc/$part" ;;
    esac
    if under "${acc:-/}" "${ROOT%/}" || under "${acc:-/}" "${ROOT_C%/}"; then
      inside=1
    else
      [ "$inside" = 1 ] && left=1
      inside=0
    fi
  done
  [ "$left" = 1 ] && [ "$inside" = 1 ]
}

# judge <absolute-path>
judge() {
  if climbs_back "$1"; then
    deny "$1" "BLOCKED: containment — write target \"$1\" leaves this run's root ${ROOT} with .. and comes back into it, so it lands on the root from outside. Name the path from inside the root."
  fi
  allowed "$1" || deny "$1"
}

SEEN=$'\n'
while IFS= read -r word; do
  [ -n "$word" ] || continue
  case "$SEEN" in *$'\n'"$word"$'\n'*) continue ;; esac
  SEEN="$SEEN$word"$'\n'
  if glob_climbs "${word#UNRESOLVED:*:}"; then
    deny "${word#UNRESOLVED:*:}" "BLOCKED: containment — write target \"${word#UNRESOLVED:*:}\" climbs with .. after a glob; the guard cannot tell where that lands. Name the directory without .. after a glob."
  fi
  case "$word" in
    UNRESOLVED:*)
      var="${word#UNRESOLVED:}"
      var="${var%%:*}"
      word="${word#UNRESOLVED:*:}"
      if path=$(expand "$word"); then judge "$path"; else unresolved "$word" "$var"; fi
      continue
      ;;
  esac
  path=$(expand "$word") || continue
  judge "$path"
done <<< "$WRITES"

exit 0
