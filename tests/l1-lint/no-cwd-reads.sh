#!/usr/bin/env bash
# Lint: nothing finds the project, a repo or an agent from the working
# directory (GH 1550, GH 1553).
#
# Claude Code gives bro and every subagent one working directory, and the MCP
# server inherits whatever directory it was started in, so the cwd says
# nothing about which project, repo or worktree a call is for. The project
# comes from the trajectory DB (tmb_project_root, the server's DB path), a
# repo from its repos row, an agent from its spawn transcript and the DB.
#
# Scope: scripts/ (scripts/hooks/ included), skills/*/scripts/,
# mcp/trajectory-server/src/ (src/test/ excluded) and tests/lib/; *.sh are
# read as shell, *.ts / *.mjs / *.js as TypeScript. Comment lines are skipped.
#
# Hits:
#   shell — $PWD, ${PWD…}, a bare `pwd`, the payload `.cwd`, tmb_payload_cwd,
#     tmb_cmd_cwd; a `git` command with no `-C` on its line (git named inside
#     quoted text, such as a deny message, is not a command).
#   TypeScript — process.cwd(); a spawn( / spawnSync( / execFile( /
#     execFileSync( call whose line and next 3 lines carry no `cwd`,
#     projectSpawnOptions( or git's `'-C',`.
# Exempt without an entry: canonicalizing a named dir (`(cd <dir> … && pwd)`,
# `&& pwd -P)`, `&& pwd -P || <fallback>)`, which covers the self-location
# `cd "$(dirname …)" && pwd`), and the payload cwd as the join base of a
# command's relative paths (the <cwd> argument of tmb_cmd_statements /
# tmb_cmd_write_paths / tmb_stmt_repo_root, or
# `"$(tmb_payload_cwd "$IN")/<relative>"`).
#
# Any other hit needs a cwd-allowlist.tsv entry
#   <path from the root>	<substring of the line>	<category>	<reason>
# tab-separated, category one of self-location, canonicalize, join-base,
# anchored-cd, fallback, test-harness, not-location (a command that reads no
# location, such as `gh auth status`, or the cwd recorded as data). An entry
# with an unknown category, no reason, or one no hit matches any more fails
# too.
#
# Usage: no-cwd-reads.sh [<root>] [<allowlist>]

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$HERE/../.." && pwd)}"
ALLOWLIST="${2:-$HERE/cwd-allowlist.tsv}"

SH_CWD_RE='\$PWD|\$\{PWD|(^|[^A-Za-z0-9_./-])pwd([^A-Za-z0-9_-]|$)|\.cwd([^A-Za-z0-9_]|$)|tmb_payload_cwd|tmb_cmd_cwd'
SH_GIT_RE='(^|[;&|({!]|\$\(|(then|do|else|if|while|until|exec|command|time|env)[[:space:]])[[:space:]]*git[[:space:]]'
SH_GIT_C_RE='git[[:space:]]+-C[[:space:]]'
DQ_TEXT_RE='"([^"$\\]|\\.|\$[^(])*"'
SQ_TEXT_RE="'[^']*'"
JOIN_RE='(tmb_cmd_statements|tmb_cmd_write_paths|tmb_stmt_repo_root) "[^"]*" "\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)"'
CONCAT_RE='"\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)/'
CANON_RE='&& pwd( -P)?( \|\| [^)]*)?\)'
TS_CWD_RE='process\.cwd\(\)'
TS_ANCHOR_RE="cwd|projectSpawnOptions[(]|'-C',"
CATEGORIES=" self-location canonicalize join-base anchored-cd fallback test-harness not-location "

[ -d "$ROOT" ] || { echo "no-cwd-reads: no root $ROOT" >&2; exit 2; }

entries=()
failed=0
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    IFS=$'\t' read -r file sub category reason <<< "$line"
    if [ -z "$file" ] || [ -z "$sub" ] || [ -z "${reason// /}" ]; then
      echo "  ✗ $ALLOWLIST: entry '$line' needs <path>	<substring>	<category>	<reason>" >&2
      failed=1
      continue
    fi
    case "$CATEGORIES" in
      *" $category "*) ;;
      *)
        echo "  ✗ $ALLOWLIST: entry '$file	$sub' has category '$category', not one of$CATEGORIES" >&2
        failed=1
        continue
        ;;
    esac
    entries+=("$file	$sub")
  done < "$ALLOWLIST"
fi
used=()

# is_comment <line> <kind> — a shell `#` line, or a TypeScript `//`, `/*` or ` *` line.
is_comment() {
  local trimmed="${1#"${1%%[![:space:]]*}"}"
  case "$2:$trimmed" in
    sh:'#'*|ts:'//'*|ts:'/*'*|ts:'*'*) return 0 ;;
  esac
  return 1
}

# code_only <line> — <line> with its quoted text (a double-quoted span with no
# $(…) inside, a single-quoted span) replaced by Q, so a message naming a git
# command is not a git command.
code_only() {
  local s="$1"
  while [[ "$s" =~ $DQ_TEXT_RE ]]; do s="${s/"${BASH_REMATCH[0]}"/Q}"; done
  while [[ "$s" =~ $SQ_TEXT_RE ]]; do s="${s/"${BASH_REMATCH[0]}"/Q}"; done
  printf '%s' "$s"
}

# shell_hits <file> — `<n><TAB><what><TAB><line>` per hit.
shell_hits() {
  local n n_line line rest code
  while IFS= read -r n_line; do
    n="${n_line%%:*}"
    line="${n_line#*:}"
    is_comment "$line" sh && continue
    if [[ "$line" =~ $SH_CWD_RE ]]; then
      rest=$(printf '%s\n' "$line" | sed -E "s#$CANON_RE##g; s#$JOIN_RE##g; s#$CONCAT_RE##g") \
        || { echo "no-cwd-reads: sed failed on $1:$n" >&2; exit 2; }
      if [[ "$rest" =~ $SH_CWD_RE ]]; then
        printf '%s\treads the cwd\t%s\n' "$n" "$line"
        continue
      fi
    fi
    [[ "$line" =~ $SH_GIT_RE ]] || continue
    code=$(code_only "$line")
    if [[ "$code" =~ $SH_GIT_RE ]] && ! [[ "$code" =~ $SH_GIT_C_RE ]]; then
      printf '%s\truns git with no -C\t%s\n' "$n" "$line"
    fi
  done < <(grep -nE "$SH_CWD_RE|(^|[^A-Za-z0-9_-])git[[:space:]]" "$1")
}

# ts_hits <file> — `<n><TAB><what><TAB><line>` per hit.
ts_hits() {
  awk -v cwd_re="$TS_CWD_RE" -v anchor_re="$TS_ANCHOR_RE" '
    { text[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        t = text[i]
        s = t; sub(/^[ \t]+/, "", s)
        if (s ~ /^(\/\/|\/\*|\*)/) continue
        if (t ~ cwd_re) { printf "%d\treads process.cwd()\t%s\n", i, t; continue }
        if (t ~ /(^|[^A-Za-z0-9_.])(spawn|spawnSync|execFile|execFileSync)\(/) {
          found = 0
          for (j = i; j <= i + 3 && j <= NR; j++) if (text[j] ~ anchor_re) { found = 1; break }
          if (!found) printf "%d\tspawns with no cwd\t%s\n", i, t
        }
      }
    }' "$1"
}

files() {
  local d
  for d in "$ROOT/scripts" "$ROOT"/skills/*/scripts "$ROOT/mcp/trajectory-server/src" "$ROOT/tests/lib"; do
    [ -d "$d" ] || continue
    find "$d" -type f \( -name '*.sh' -o -name '*.ts' -o -name '*.mjs' -o -name '*.js' \) \
      -not -path "$ROOT/mcp/trajectory-server/src/test/*" -not -path '*/node_modules/*'
  done | sort -u
}

hits=0
while IFS= read -r path; do
  rel="${path#"$ROOT"/}"
  case "$path" in
    *.sh) out=$(shell_hits "$path") ;;
    *) out=$(ts_hits "$path") ;;
  esac || { echo "no-cwd-reads: could not read $rel" >&2; exit 2; }
  [ -n "$out" ] || continue
  while IFS=$'\t' read -r n what line; do
    ok=""
    for i in "${!entries[@]}"; do
      e="${entries[$i]}"
      [ "${e%%	*}" = "$rel" ] || continue
      case "$line" in *"${e#*	}"*) ok=1; used[$i]=1 ;; esac
    done
    [ -n "$ok" ] && continue
    trimmed="${line#"${line%%[![:space:]]*}"}"
    echo "  ✗ $rel:$n $what: $trimmed" >&2
    hits=$((hits + 1))
  done <<< "$out"
done < <(files)

for i in "${!entries[@]}"; do
  [ -n "${used[$i]:-}" ] && continue
  echo "  ✗ $ALLOWLIST: stale entry '${entries[$i]}' matches no hit" >&2
  failed=1
done

if [ "$hits" -gt 0 ] || [ "$failed" -ne 0 ]; then
  echo "no-cwd-reads: FAIL — find the project from the trajectory DB (tmb_project_root), a repo from its repos row (git -C <path>, spawn with cwd), an agent from its spawn transcript (lib/agent-context.sh); the cwd only joins a command's relative paths (GH 1553). A legitimate read takes a cwd-allowlist.tsv entry with its category and reason." >&2
  exit 1
fi
echo "no-cwd-reads: OK"
