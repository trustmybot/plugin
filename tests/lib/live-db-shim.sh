#!/usr/bin/env bash
# live-db-shim.sh — a refusing sqlite3 on PATH for test runners, so no test can
# open the real project's trajectory DB.
#
# The real project is the TMB workspace that holds the checkout: the protected
# set is <dir>/.claude/tmb for the checkout, its main checkout (git
# --git-common-dir) and every ancestor of both, plus the toplevel of the
# checkout's parent when that is a git repo. The shim logs every invocation and
# refuses (exit 1 + stderr) any argument under a protected dir (a path, a
# file: URI, a relative path against the caller's cwd, or a quoted path inside
# SQL such as ATTACH); every other invocation is exec'd to the real sqlite3
# unchanged. After the suite, live_db_shim_check fails with the refusal list.
#
# Usage:
#   . tests/lib/live-db-shim.sh
#   live_db_shim_start <checkout> <state dir>   # prepends the shim to PATH
#   ...run the suite...
#   live_db_shim_check "<suite name>" || fail=1

_live_db_shim_ancestors() {
  local dir="$1"
  while [ -n "$dir" ]; do
    printf '%s\n' "$dir"
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done
}

live_db_shim_protected() {
  local checkout common main parent_top
  checkout="$(cd "$1" && pwd -P)"
  common="$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  main=""
  [ -n "$common" ] && main="$(cd "$(dirname "$common")" 2>/dev/null && pwd -P || true)"
  parent_top="$(git -C "$(dirname "$checkout")" rev-parse --show-toplevel 2>/dev/null || true)"
  {
    _live_db_shim_ancestors "$checkout"
    [ -n "$main" ] && _live_db_shim_ancestors "$main"
    [ -n "$parent_top" ] && printf '%s\n' "$parent_top"
  } | awk '!seen[$0]++' | while IFS= read -r dir; do
    [ "$dir" = "/" ] && dir=""
    printf '%s/.claude/tmb\n' "$dir"
  done
}

live_db_shim_start() {
  local checkout="$1" state="$2" real
  real="$(command -v sqlite3 2>/dev/null || true)"
  LIVE_DB_SHIM_LOG="$state/sqlite3-calls.log"
  LIVE_DB_SHIM_REFUSALS="$state/sqlite3-refusals.log"
  export LIVE_DB_SHIM_LOG LIVE_DB_SHIM_REFUSALS
  [ -n "$real" ] || return 0
  mkdir -p "$state/bin"
  : > "$LIVE_DB_SHIM_LOG"
  : > "$LIVE_DB_SHIM_REFUSALS"
  live_db_shim_protected "$checkout" > "$state/protected"
  cat > "$state/bin/sqlite3" <<SHIM
#!/usr/bin/env bash
printf '%s\t%s\n' "\$PWD" "\$*" >> '$LIVE_DB_SHIM_LOG'
for arg in "\$@"; do
  case "\$arg" in
    file://*) abs="\${arg#file://}"; abs="\${abs%%\?*}" ;;
    file:*) abs="\${arg#file:}"; abs="\${abs%%\?*}" ;;
    /*) abs="\$arg" ;;
    -*) abs="" ;;
    *) abs="\$PWD/\$arg" ;;
  esac
  while IFS= read -r protected; do
    case "\$abs" in "\$protected"|"\$protected"/*) ;; *)
      case "\$arg" in *[\'\"\ =]"\$protected"|*[\'\"\ =]"\$protected"/*) ;; *) continue ;; esac ;;
    esac
    printf '%s\t%s\n' "\$PWD" "\$*" >> '$LIVE_DB_SHIM_REFUSALS'
    printf 'sqlite3-shim: refused %s (under the real project DB dir %s)\n' "\$arg" "\$protected" >&2
    exit 1
  done < '$state/protected'
done
exec '$real' "\$@"
SHIM
  chmod +x "$state/bin/sqlite3"
  PATH="$state/bin:$PATH"
  export PATH
}

live_db_shim_check() {
  local suite="$1"
  if [ -s "${LIVE_DB_SHIM_REFUSALS:-}" ]; then
    printf '\nFAIL live DB: %s ran sqlite3 against the real project DB (%s refusals; cwd<TAB>args):\n' "$suite" "$(wc -l < "$LIVE_DB_SHIM_REFUSALS" | tr -d ' ')"
    cat "$LIVE_DB_SHIM_REFUSALS"
    return 1
  fi
  printf 'live DB: 0 sqlite3 refusals from %s (%s calls checked)\n' "$suite" "$(wc -l < "${LIVE_DB_SHIM_LOG:-/dev/null}" | tr -d ' ')"
}
