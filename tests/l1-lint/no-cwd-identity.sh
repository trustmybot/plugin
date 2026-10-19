#!/usr/bin/env bash
# Lint: no hook reads its agent's identity or location from the cwd (GH 1550).
#
# Claude Code gives bro and every subagent one working directory, so the hook
# process's $PWD, `pwd` and the payload `.cwd` say nothing about who calls or
# which worktree it owns. Identity and location come from the spawn transcript
# and the trajectory DB (scripts/hooks/lib/agent-context.sh); the project root
# from CLAUDE_PROJECT_DIR (tmb_project_root).
#
# Every line of a scripts/hooks/**.sh file that reads $PWD, ${PWD…}, `pwd`,
# `.cwd`, tmb_payload_cwd or tmb_cmd_cwd is a hit, except:
#   - canonicalizing a named dir: `(cd <dir> … && pwd)` / `&& pwd -P)`;
#   - the payload cwd as the join base of a command's relative paths: the
#     <cwd> argument of tmb_cmd_statements / tmb_cmd_write_paths /
#     tmb_stmt_repo_root, or `"$(tmb_payload_cwd "$IN")/<relative>"`.
# Any other hit needs a no-cwd-identity.allowlist entry
# `<file under scripts/hooks>|<substring of the line>|<reason>`; an entry with
# no reason, or one no hit matches any more, fails too.
#
# Usage: no-cwd-identity.sh [<hooks_dir>] [<allowlist>]

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
HOOKS_DIR="${1:-$REPO_ROOT/scripts/hooks}"
ALLOWLIST="${2:-$HERE/no-cwd-identity.allowlist}"

HIT_RE='\$PWD|\$\{PWD|(^|[^A-Za-z0-9_./-])pwd([^A-Za-z0-9_-]|$)|\.cwd([^A-Za-z0-9_]|$)|tmb_payload_cwd|tmb_cmd_cwd'
JOIN_RE='(tmb_cmd_statements|tmb_cmd_write_paths|tmb_stmt_repo_root) "[^"]*" "\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)"'
CONCAT_RE='"\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)/'
CANON_RE='&& pwd( -P)?\)'

[ -d "$HOOKS_DIR" ] || { echo "no-cwd-identity: no hooks dir $HOOKS_DIR" >&2; exit 2; }

entries=()
failed=0
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    IFS='|' read -r file sub reason <<< "$line"
    if [ -z "$file" ] || [ -z "$sub" ] || [ -z "${reason// /}" ]; then
      echo "  ✗ $ALLOWLIST: entry '$line' needs <file>|<substring>|<reason>" >&2
      failed=1
      continue
    fi
    entries+=("$file|$sub")
  done < "$ALLOWLIST"
fi
used=()

hits=0
while IFS= read -r path; do
  rel="${path#"$HOOKS_DIR"/}"
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in *[![:space:]]*) ;; *) continue ;; esac
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in '#'*) continue ;; esac
    [[ "$line" =~ $HIT_RE ]] || continue
    rest=$(printf '%s\n' "$line" | sed -E "s#$CANON_RE##g; s#$JOIN_RE##g; s#$CONCAT_RE##g") \
      || { echo "no-cwd-identity: sed failed on $rel:$n" >&2; exit 2; }
    [[ "$rest" =~ $HIT_RE ]] || continue
    ok=""
    for i in "${!entries[@]}"; do
      e="${entries[$i]}"
      [ "${e%%|*}" = "$rel" ] || continue
      case "$line" in *"${e#*|}"*) ok=1; used[$i]=1 ;; esac
    done
    [ -n "$ok" ] && continue
    echo "  ✗ $rel:$n reads the cwd outside a relative-path join: $trimmed" >&2
    hits=$((hits + 1))
  done < "$path"
done < <(find "$HOOKS_DIR" -type f -name '*.sh' | sort)

for i in "${!entries[@]}"; do
  [ -n "${used[$i]:-}" ] && continue
  echo "  ✗ $ALLOWLIST: stale entry '${entries[$i]}' matches no line" >&2
  failed=1
done

if [ "$hits" -gt 0 ] || [ "$failed" -ne 0 ]; then
  echo "no-cwd-identity: FAIL — hooks resolve identity and location from the spawn transcript and the DB (lib/agent-context.sh), the project from CLAUDE_PROJECT_DIR; the cwd only joins a command's relative paths (GH 1550)" >&2
  exit 1
fi
echo "no-cwd-identity: OK"
