#!/usr/bin/env bash
# PreToolUse hook — containment guard: an agent writes only under its run's root.
#
# Fires on: PreToolUse — matcher: Write|Edit|MultiEdit|NotebookEdit|Bash
#
# Root: in a swe / pr-reviewer context, the open agent_runs.root_dir of the
# active task (resolved by tmb_resolve_task_id_for_target from the payload
# cwd); otherwise, and when that row carries no root, CLAUDE_PROJECT_DIR (else
# the project holding the trajectory DB).
#
#   Write/Edit/MultiEdit/NotebookEdit — deny when the canonical file_path
#     (symlinks resolved, /tmp ≡ /private/tmp) is outside the root.
#   Bash — deny when the payload cwd is outside the root, or when a write
#     position (redirect target, tee, cp/mv/rsync/install destination, mkdir,
#     rm, touch, git worktree add, git clone; see lib/cmd-analysis.sh) names a
#     path outside the root. Heredoc bodies and quoted text are data, not
#     syntax. ~, $HOME, ${HOME} and $TMB_MODEL_CACHE_DIR are expanded; a path
#     behind any other variable is not judged. Reads are never judged.
#   Always allowed, mirroring the Claude Code sandbox: the model cache
#     (TMB_MODEL_CACHE_DIR, default ${HF_HOME:-~/.cache/huggingface}), the
#     host's own temp dir ($TMPDIR when the host sets it, e.g. /tmp/claude-501,
#     and its realpath) and /dev/null, /dev/stdout, /dev/stderr, /dev/tty,
#     /dev/fd/*.
#
# Every denial writes one containment_denied audit row (from_node
# hook:containment-guard, content {tool, path, root, task_id}) and names the
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

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

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

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || true)
[ -n "$CWD" ] || CWD="$PWD"

AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null || true)")
TASK_ID=""
ROOT=""
if [ "$AGENT_TYPE" = "pr-reviewer" ] || [ "$(tmb_swe_context "$AGENT_TYPE")" = "yes" ]; then
  TASK_ID=$(tmb_sql_int "$(tmb_resolve_task_id_for_target "$CWD/" "$INPUT" "$DB")")
  if [ -n "$TASK_ID" ]; then
    ROOT=$(tmb_gate_read "$DB" "SELECT root_dir FROM agent_runs
                                 WHERE task_id = ${TASK_ID} AND completed_at IS NULL AND root_dir IS NOT NULL
                                   AND agent_type IN ('swe','pr-reviewer')
                                 ORDER BY id DESC LIMIT 1;")
    if [ "$ROOT" = "__ERR__" ]; then
      tmb_deny_db_unavailable "containment-guard"
      exit 0
    fi
  fi
fi
if [ -z "$ROOT" ]; then
  ROOT="${CLAUDE_PROJECT_DIR:-}"
  [ -n "$ROOT" ] || ROOT=$(dirname "$(dirname "$(dirname "$DB")")")
fi
ROOT_C=$(tmb_path_canonical "$ROOT")

CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-}}"
[ -n "$CACHE_DIR" ] || CACHE_DIR="$HOME/.cache/huggingface"
CACHE_C=$(tmb_path_canonical "$CACHE_DIR")
HOST_TMP_C=""
case "${TMPDIR:-}" in
  /?*) HOST_TMP_C=$(tmb_path_canonical "$TMPDIR") ;;
esac

# under <canonical-path> <canonical-dir>
under() {
  [ "$1" = "$2" ] && return 0
  case "$1" in "${2%/}"/*) return 0 ;; esac
  return 1
}

# allowed <absolute-path> — inside the root, the model cache, the host temp
# dir, or a device.
allowed() {
  local c
  case "$1" in
    /dev/null|/dev/stdout|/dev/stderr|/dev/tty|/dev/fd/*) return 0 ;;
  esac
  c=$(tmb_path_canonical "$1")
  under "$c" "$ROOT_C" || under "$c" "$CACHE_C" && return 0
  [ -n "$HOST_TMP_C" ] && [ "$HOST_TMP_C" != "/" ] && under "$c" "$HOST_TMP_C"
}

deny() {
  local path="$1" content issue
  content=$(jq -cn --arg tool "$TOOL_NAME" --arg path "$path" --arg root "$ROOT" --arg tid "$TASK_ID" \
    '{tool:$tool, path:$path, root:$root, task_id:(if $tid == "" then null else ($tid | tonumber) end)}')
  issue=-1
  if [ -n "$TASK_ID" ]; then
    issue=$(tmb_sql_int "$(tmb_sqlite_ro "$DB" "SELECT issue_id FROM tasks WHERE id = ${TASK_ID};")")
    [ -n "$issue" ] || issue=-1
  fi
  tmb_audit_append "$DB" "$issue" '' "hook:containment-guard" "containment_denied" \
    "${TOOL_NAME} denied: ${path} is outside ${ROOT}" "$content" || true
  jq -nc --arg r "BLOCKED: containment — ${path} is outside this run's root ${ROOT}. TMB agents write only under their root (the task worktree for swe, the project for bro); keep scratch files inside it." \
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

allowed "$CWD" || deny "$CWD"

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
[ -n "$COMMAND" ] || exit 0
while IFS= read -r word; do
  [ -n "$word" ] || continue
  path=$(expand "$word") || continue
  allowed "$path" || deny "$path"
done < <(tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$COMMAND")")

exit 0
