#!/usr/bin/env bash
# Library: shell-command analysis for TMB hooks.
# Sourced (not exec'd). No set -e/-euo/-euo pipefail here — libs must not
# mutate caller shell options.
#
# tmb_cmd_strip_literals <command> [keep]
#   Prints <command> with the parts that are data rather than shell syntax
#   neutralized, so a scanner never mistakes them for operators:
#     - heredoc bodies are dropped (the `<<WORD` operator stays);
#     - quotes are removed, and inside a quoted string every blank and every
#       operator character (< > | ; & ( ) `) becomes `_`, so `echo "> /tmp/z"`
#       is one word while `echo hi > "/tmp/z"` keeps its redirect target;
#     - `# comments` are dropped.
#   A quoted string spanning lines joins them with `_`. With `keep`, those
#   characters (and backslash-escaped ones) become reversible control bytes
#   instead of `_` (see tmb_cmd_decode), so a quoted word can be recovered.
#
# tmb_cmd_write_targets <stripped-command>
#   Prints one path per line for every write position in a command already
#   passed through tmb_cmd_strip_literals: `>`, `>>`, `>|`, `&>`, `&>>`
#   targets (fd duplications like 2>&1 are not paths), every non-option
#   argument of tee, mkdir, rm, touch, the destination of cp, mv, install and
#   rsync (last argument, or -t/--target-directory), every path of a link
#   (ln, ln -s, link, cp -s, cp -l: the destination and each source, a
#   relative ln -s source also read against the link's directory), the path of
#   `git worktree add` and the directory of `git clone`. Leading VAR=value
#   assignments and sudo/env/command/nohup/time wrappers are skipped. Paths
#   are printed as written (no expansion).
#
# tmb_cmd_decode <encoded-text>
#   Reverses the `keep` encoding of tmb_cmd_strip_literals.
#
# tmb_cmd_statements <command> [<cwd>]
#   Prints one line per executable statement of the stripped skeleton:
#   `<effective_dir><TAB><statement>`. Statements split on && || | ; & newline,
#   ( ) $( ) and backticks; leading `{ ! if then else elif do while until`,
#   VAR=value assignments and sudo/env/command/nohup/exec/time wrappers are
#   dropped, so the statement starts at its real argv0, words single-spaced,
#   quoted words carrying `_` for their blanks. `bash|sh|zsh|dash|ksh -c <s>`
#   and `eval <s>` are analyzed recursively. <effective_dir> is, in order:
#     - the statement's own `git -C <path>` (chained -C compose);
#     - the dir set by a preceding `cd|pushd <path>` in the same command
#       (relative paths join the dir before them — <cwd> when that dir
#       exists; a `( … )` subshell restores the outer dir when it closes);
#     - <cwd> (default $PWD) when the command never changes dir and <cwd>
#       belongs to at most one checkout: not a git repo, or a repo without
#       linked worktrees;
#     - `?` (ambiguous) when <cwd> is a repo with linked worktrees — the
#       statement may run in any of them, so a guard that needs its branch
#       must deny with tmb_deny_ambiguous_git_target;
#     - `-` (unknown) when the path is behind a variable, `cd -`, or popd.
#
# tmb_git_commit_message <command>
#   Prints the message of the first `git commit` statement as its real argv
#   carries it (-m <msg>, -m<msg>, --message[=]<msg>, -am <msg>); nothing when
#   there is none or the message is built by $( ) or backticks. Heredoc bodies
#   and quoted text elsewhere in the command are never read.
#
# tmb_git_subcommand <statement>
#   For a `git …` statement prints the subcommand followed by its arguments
#   (global options such as -C <p>, -c <k=v>, --no-pager dropped); prints
#   nothing for any other statement.
#
# tmb_stmt_repo_root <effective_dir> [<cwd>]
#   Prints the main checkout root of the repo a statement runs in: for a path,
#   that path's repo; for `?`, the repo of <cwd> (every linked worktree shares
#   it). Empty for `-`, a missing dir, or a dir outside any repo.
#
# tmb_payload_cwd <hook-input-json>
#   Prints the payload `.cwd`, else $PWD.
#
# tmb_deny_ambiguous_git_target <statement>
#   Prints the PreToolUse deny for a statement whose dir is `?`.
#
# tmb_agent_role <hook-input-json>
#   The role of the agent making the tool call, from its identity alone: the
#   payload agent_type (subagent_type for older payloads), normalized by
#   normalize-role.sh; `bro` when absent — the main thread. A path never
#   decides a role.
#
# tmb_is_harness_turn <prompt>
#   Exit 0 when a UserPromptSubmit prompt was produced by the harness, not
#   typed by the Human: task notifications, system notifications, subagent
#   hand-backs, agent and cross-session messages.
#
# tmb_strip_quoted_spans <text>
#   Prints <text> with backticked, single- and double-quoted spans replaced by
#   a blank. A quote opens only at a word start and closes only at a word end,
#   so apostrophes (let's, users') stay; an unclosed quote stays as text.
#
# tmb_path_canonical <absolute-path>
#   Prints the path the kernel would reach (realpath -m semantics): components
#   are walked left to right, every existing symlink is followed before a
#   later `..` applies (so <root>/link/../x lands where link points), and `..`
#   collapses textually only inside the missing tail. /tmp and /private/tmp
#   compare equal on macOS; the path need not exist.

# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/normalize-role.sh"

tmb_cmd_strip_literals() {
  local keep=0
  [ "${2:-}" = "keep" ] && keep=1
  printf '%s\n' "${1:-}" | awk -v sq="'" -v keep="$keep" '
    function neutral(c,   k) {
      if (keep) { k = index(" \t<>|;&()`", c); return k ? enc[k] : c }
      return (c ~ /[ \t<>|;&()`]/) ? "_" : c
    }
    function joiner() { return keep ? enc[12] : "_" }
    BEGIN {
      state = ""; nh = 0; cur = 0; inbody = 0
      for (k = 1; k <= 12; k++) enc[k] = sprintf("%c", k < 7 ? k : k + 7)
    }
    {
      line = $0
      if (inbody) {
        t = line
        if (tabs[cur]) sub(/^\t+/, "", t)
        if (t == delim[cur]) {
          cur++
          if (cur > nh) { inbody = 0; nh = 0; cur = 0 }
        }
        next
      }
      out = ""; i = 1; n = length(line)
      while (i <= n) {
        c = substr(line, i, 1)
        if (state == "s") {
          if (c == sq) { state = "" } else { out = out neutral(c) }
          i++; continue
        }
        if (state == "d") {
          if (c == "\\") { out = out neutral(substr(line, i + 1, 1)); i += 2; continue }
          if (c == "\"") { state = "" } else { out = out neutral(c) }
          i++; continue
        }
        if (c == "\\") { out = out (keep ? neutral(substr(line, i + 1, 1)) : substr(line, i + 1, 1)); i += 2; continue }
        if (c == sq) { state = "s"; i++; continue }
        if (c == "\"") { state = "d"; i++; continue }
        if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t;&|(]/)) break
        if (substr(line, i, 2) == "<<" && substr(line, i, 3) != "<<<") {
          j = i + 2; strip = 0
          if (substr(line, j, 1) == "-") { strip = 1; j++ }
          while (j <= n && substr(line, j, 1) ~ /[ \t]/) j++
          w = ""
          while (j <= n) {
            d = substr(line, j, 1)
            if (d ~ /[ \t;&|<>()]/) break
            if (d != sq && d != "\"" && d != "\\") w = w d
            j++
          }
          if (w != "") { nh++; delim[nh] = w; tabs[nh] = strip }
          out = out "<<" w
          i = j; continue
        }
        out = out c; i++
      }
      if (state != "") { printf "%s%s", out, joiner() } else { print out }
      if (nh > 0 && state == "") { inbody = 1; cur = 1 }
    }
  '
}

tmb_cmd_write_targets() {
  printf '%s\n' "${1:-}" | awk '
    function flush(   k, first, cmd, nonopt, nn, a, sub_i, pos, skipnext, val, sym, tdir, last, linkcopy, installdir) {
      first = 1
      while (first <= nw && (w[first] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || w[first] ~ /^(sudo|env|command|nohup|time)$/)) first++
      if (first > nw) { nw = 0; return }
      cmd = w[first]; sub(/.*\//, "", cmd)
      nn = 0
      if (cmd == "tee" || cmd == "mkdir" || cmd == "rm" || cmd == "touch" || cmd == "rmdir") {
        for (k = first + 1; k <= nw; k++) if (w[k] !~ /^-/) print w[k]
      } else if (cmd == "ln" || cmd == "link") {
        sym = 0; tdir = ""
        for (k = first + 1; k <= nw; k++) {
          a = w[k]
          if (a == "-t" || a == "--target-directory") { if (k < nw) tdir = w[k + 1]; k++; continue }
          if (a ~ /^--target-directory=/) { tdir = a; sub(/^--target-directory=/, "", tdir); continue }
          if (a == "--symbolic") { sym = 1; continue }
          if (a ~ /^--/) continue
          if (a ~ /^-/) { if (a ~ /s/) sym = 1; continue }
          nonopt[++nn] = a
        }
        last = nn
        if (tdir != "") print tdir
        else if (nn >= 2) { print nonopt[nn]; last = nn - 1 }
        for (k = 1; k <= last; k++) {
          a = nonopt[k]
          if (!sym || a ~ /^\//) { print a; continue }
          if (tdir != "") { print tdir "/" a; continue }
          if (nn < 2) { print a; continue }
          val = nonopt[nn]
          if (val ~ /\//) { sub(/\/[^\/]*\/?$/, "", val); if (val == "") val = "/" } else val = "."
          print val "/" a
          print nonopt[nn] "/" a
        }
      } else if (cmd == "cp" || cmd == "mv" || cmd == "install" || cmd == "rsync") {
        installdir = 0; linkcopy = 0
        for (k = first + 1; k <= nw; k++) {
          a = w[k]
          if (a == "-t" || a == "--target-directory") { if (k < nw) print w[k + 1]; k++; continue }
          if (a ~ /^--target-directory=/) { val = a; sub(/^--target-directory=/, "", val); print val; continue }
          if (cmd == "install" && a == "-d") { installdir = 1; continue }
          if (cmd == "cp" && (a == "--symbolic-link" || a == "--link" || a ~ /^-[A-Za-z]*[sl]/)) { linkcopy = 1; continue }
          if (a ~ /^-/) continue
          nonopt[++nn] = a
        }
        if (installdir) { for (k = 1; k <= nn; k++) print nonopt[k] }
        else if (linkcopy) { for (k = 1; k <= nn; k++) print nonopt[k] }
        else if (nn >= 2 && nonopt[nn] !~ /^[^\/]*:/) print nonopt[nn]
      } else if (cmd == "git") {
        k = first + 1
        while (k <= nw && w[k] ~ /^-/) { if (w[k] == "-C" || w[k] == "-c") k++; k++ }
        if (k <= nw && w[k] == "worktree" && k + 1 <= nw && w[k + 1] == "add") {
          for (sub_i = k + 2; sub_i <= nw; sub_i++) {
            if (w[sub_i] == "-b" || w[sub_i] == "-B" || w[sub_i] == "--reason") { sub_i++; continue }
            if (w[sub_i] ~ /^-/) continue
            print w[sub_i]; break
          }
        } else if (k <= nw && w[k] == "clone") {
          pos = 0
          for (sub_i = k + 1; sub_i <= nw; sub_i++) {
            if (w[sub_i] ~ /^(-b|-o|-c|-u|-j|--depth|--branch|--origin|--config|--reference|--jobs|--upload-pack|--template|--separate-git-dir)$/) { sub_i++; continue }
            if (w[sub_i] ~ /^-/) continue
            pos++
            if (pos == 2) { print w[sub_i]; break }
          }
        }
      }
      nw = 0
    }
    BEGIN { nw = 0; want = 0 }
    {
      line = $0; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        if (c ~ /[ \t]/) { i++; continue }
        if (c == ";" || c == "|" || c == "(" || c == ")") { flush(); want = 0; i++; continue }
        if (c == "&" && substr(line, i + 1, 1) == ">") {
          i += 2; if (substr(line, i, 1) == ">") i++
          want = 1; continue
        }
        if (c == "&") { flush(); want = 0; i++; continue }
        if (c == "<") {
          i++; while (substr(line, i, 1) == "<") i++
          want = 2; continue
        }
        if (c == ">") {
          i++
          if (substr(line, i, 1) == ">" || substr(line, i, 1) == "|") i++
          if (substr(line, i, 1) == "&") {
            i++; while (substr(line, i, 1) ~ /[0-9-]/) i++
            continue
          }
          want = 1; continue
        }
        word = ""
        while (i <= n) {
          c = substr(line, i, 1)
          if (c ~ /[ \t;|&()<]/) break
          if (c == ">") {
            if (word ~ /^[0-9]+$/) word = ""
            break
          }
          word = word c; i++
        }
        if (word == "") continue
        if (want == 1) { print word; want = 0; continue }
        if (want == 2) { want = 0; continue }
        w[++nw] = word
      }
      flush(); want = 0
    }
  '
}

tmb_path_canonical() {
  local path="${1:-}" cur="" tail="" rest part link hops=0
  case "$path" in /*) ;; *) printf '%s\n' "$path"; return 0 ;; esac
  rest="$path"
  while [ -n "$rest" ]; do
    rest="${rest#/}"
    part="${rest%%/*}"
    if [ "$part" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    case "$part" in ''|.) continue ;; esac
    if [ -n "$tail" ]; then
      if [ "$part" = ".." ]; then tail="${tail%/*}"; else tail="$tail/$part"; fi
      continue
    fi
    if [ "$part" = ".." ]; then cur="${cur%/*}"; continue; fi
    if [ -L "$cur/$part" ] && [ "$hops" -lt 40 ]; then
      hops=$((hops + 1))
      link=$(readlink "$cur/$part")
      case "$link" in /*) cur="" ;; esac
      rest="$link/$rest"
      continue
    fi
    if [ -e "$cur/$part" ]; then cur="$cur/$part"; else tail="/$part"; fi
  done
  [ -n "$cur$tail" ] || cur=/
  printf '%s%s\n' "$cur" "$tail"
}

tmb_cmd_decode() {
  printf '%s' "${1:-}" | tr '\001\002\003\004\005\006\016\017\020\021\023' ' \t<>|;&()`\n'
}

# _tmb_cmd_statements_enc <command> <base-dir-token> <depth>
# Prints `<dir-token><TAB><encoded statement>` lines. A dir token is an
# absolute path, `@` (the caller's cwd), `@/<rel>` (relative to it) or `-`.
_tmb_cmd_statements_enc() {
  local cmd="${1:-}" base="${2:-@}" depth="${3:-0}"
  local dir stmt argv0 inner w rest i
  local -a words
  tmb_cmd_strip_literals "$cmd" keep | awk -v base="$base" -v home="${HOME:-}" '
    function norm(p,   n, parts, out, k, m, lead) {
      lead = ""
      if (substr(p, 1, 1) == "@") { lead = "@"; p = substr(p, 2) }
      n = split(p, parts, "/")
      m = 0
      for (k = 1; k <= n; k++) {
        if (parts[k] == "" || parts[k] == ".") continue
        if (parts[k] == ".." && m > 0 && out[m] != "..") { m--; continue }
        out[++m] = parts[k]
      }
      p = ""
      for (k = 1; k <= m; k++) p = p "/" out[k]
      if (lead == "@") return "@" p
      return (p == "") ? "/" : p
    }
    function resolve(d, p) {
      if (p == "" || p ~ /[$`\001-\006\016-\023]/) return "-"
      if (p == "~") p = home
      else if (substr(p, 1, 2) == "~/") p = home substr(p, 2)
      if (substr(p, 1, 1) == "/") return norm(p)
      if (d == "-") return "-"
      return norm(d "/" p)
    }
    function flush(   n, w, k, first, a0, d, p, out) {
      n = split(stmt, w, /[ \t]+/)
      stmt = ""
      first = 1
      while (first <= n) {
        if (w[first] == "") { first++; continue }
        if (w[first] ~ /^(\{|\}|!|if|then|else|elif|do|while|until|time|exec|command|nohup|sudo|env|fi|done|esac)$/) { first++; continue }
        if (w[first] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { first++; continue }
        break
      }
      if (first > n) return
      a0 = w[first]
      out = a0
      for (k = first + 1; k <= n; k++) if (w[k] != "") out = out " " w[k]
      d = cur
      if (a0 == "cd" || a0 == "pushd") {
        p = ""
        for (k = first + 1; k <= n; k++) {
          if (w[k] == "") continue
          if (w[k] ~ /^-[LPe@]+$/) continue
          p = w[k]; break
        }
        if (p == "" || p == "-") cur = "-"
        else cur = resolve(cur, p)
      } else if (a0 == "popd") {
        cur = "-"
      } else if (a0 == "git") {
        for (k = first + 1; k <= n; k++) {
          if (w[k] == "") continue
          if (w[k] == "-C") { d = resolve(d, w[k + 1]); k++; continue }
          if (w[k] == "-c") { k++; continue }
          if (w[k] ~ /^-/) continue
          break
        }
      }
      printf "%s\t%s\n", d, out
    }
    BEGIN { cur = base; sp = 0; bt = 0; stmt = "" }
    { buf = (NR == 1) ? $0 : buf "\n" $0 }
    END {
      n = length(buf)
      for (i = 1; i <= n; i++) {
        c = substr(buf, i, 1)
        nx = substr(buf, i + 1, 1)
        if (c == "\n" || c == ";") { flush(); continue }
        if (c == "&") {
          if (nx == ">" || substr(buf, i - 1, 1) == ">") { stmt = stmt c; continue }
          if (nx == "&") i++
          flush(); continue
        }
        if (c == "|") {
          if (substr(buf, i - 1, 1) == ">") { stmt = stmt c; continue }
          if (nx == "|" || nx == "&") i++
          flush(); continue
        }
        if (c == "(") {
          if (substr(stmt, length(stmt), 1) ~ /[$<>]/) stmt = substr(stmt, 1, length(stmt) - 1)
          flush(); stack[++sp] = cur; continue
        }
        if (c == ")") { flush(); if (sp > 0) cur = stack[sp--]; continue }
        if (c == "`") {
          flush()
          if (bt) { bt = 0; if (sp > 0) cur = stack[sp--] } else { bt = 1; stack[++sp] = cur }
          continue
        }
        stmt = stmt c
      }
      flush()
    }
  ' | while IFS="$(printf '\t')" read -r dir stmt; do
    [ -n "$stmt" ] || continue
    read -r -a words <<< "$stmt"
    argv0="${words[0]:-}"
    inner=""
    if [ "$depth" -lt 3 ]; then
      case "$argv0" in
        bash|sh|zsh|dash|ksh|*/bash|*/sh|*/zsh|*/dash|*/ksh)
          for ((i = 1; i < ${#words[@]}; i++)); do
            w="${words[$i]}"
            case "$w" in
              -c|-[a-zA-Z]*c|-c[a-zA-Z]*) inner="${words[$((i + 1))]:-}"; break ;;
              -*) ;;
              *) break ;;
            esac
          done
          ;;
        eval)
          rest="${stmt#eval}"
          inner="${rest# }"
          ;;
      esac
    fi
    if [ -n "$inner" ]; then
      _tmb_cmd_statements_enc "$(tmb_cmd_decode "$inner")" "$dir" $((depth + 1))
    else
      printf '%s\t%s\n' "$dir" "$stmt"
    fi
  done
}

# _tmb_cwd_state <cwd> — `?` when <cwd> is in a repo with linked worktrees,
# `-` when it is not a directory, else <cwd>.
_tmb_cwd_state() {
  local cwd="${1:-}" n
  [ -n "$cwd" ] && [ -d "$cwd" ] || { printf -- '-'; return 0; }
  if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
    n=$(git -C "$cwd" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
    if [ "${n:-0}" -gt 1 ]; then printf '?'; return 0; fi
  fi
  printf '%s' "$cwd"
}

tmb_cmd_statements() {
  local cmd="${1:-}" cwd="${2:-$PWD}" state="" dir stmt
  _tmb_cmd_statements_enc "$cmd" "@" 0 | while IFS="$(printf '\t')" read -r dir stmt; do
    case "$dir" in
      @/*)
        if [ -d "${cwd%/}${dir#@}" ]; then
          dir="${cwd%/}${dir#@}"
        else
          [ -n "$state" ] || state=$(_tmb_cwd_state "$cwd")
          case "$state" in
            '?'|-) dir="$state" ;;
            *) dir="${state%/}${dir#@}" ;;
          esac
        fi
        ;;
      @)
        [ -n "$state" ] || state=$(_tmb_cwd_state "$cwd")
        dir="$state"
        ;;
    esac
    printf '%s\t%s\n' "$dir" "$(printf '%s' "$stmt" | tr '\001\002\003\004\005\006\016\017\020\021\023' '___________')"
  done
}

tmb_git_subcommand() {
  local -a w
  local k=1
  read -r -a w <<< "${1:-}"
  [ "${w[0]:-}" = "git" ] || return 0
  while [ "$k" -lt "${#w[@]}" ]; do
    case "${w[$k]}" in
      -C|-c|--git-dir|--work-tree|--namespace) k=$((k + 2)) ;;
      -*) k=$((k + 1)) ;;
      *) break ;;
    esac
  done
  [ "$k" -lt "${#w[@]}" ] || return 0
  printf '%s\n' "${w[*]:$k}"
}

tmb_git_commit_message() {
  local dir stmt sub w msg="" next=0
  local -a words
  while IFS="$(printf '\t')" read -r dir stmt; do
    sub=$(tmb_git_subcommand "$stmt")
    case "$sub" in commit|"commit "*) ;; *) continue ;; esac
    read -r -a words <<< "$sub"
    for w in "${words[@]:1}"; do
      if [ "$next" = 1 ]; then msg="$w"; break; fi
      case "$w" in
        -m|--message) next=1 ;;
        --message=*) msg="${w#--message=}"; break ;;
        -m*) msg="${w#-m}"; break ;;
        -[a-zA-Z]*m) next=1 ;;
      esac
    done
    break
  done < <(_tmb_cmd_statements_enc "${1:-}" "-" 0)
  msg=$(tmb_cmd_decode "$msg")
  case "$msg" in *'$('*|*'`'*) return 0 ;; esac
  printf '%s' "$msg"
}

tmb_stmt_repo_root() {
  local dir="${1:-}" cwd="${2:-$PWD}" common
  case "$dir" in
    '?') dir="$cwd" ;;
    -|'') return 0 ;;
  esac
  [ -d "$dir" ] || return 0
  common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  [ -n "$common" ] || return 0
  case "$common" in
    */.git) (cd "${common%/.git}" && pwd) 2>/dev/null || true ;;
    *) git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true ;;
  esac
}

tmb_payload_cwd() {
  local c
  c=$(printf '%s' "${1:-}" | jq -r '.cwd // empty' 2>/dev/null || true)
  [ -n "$c" ] || c="$PWD"
  printf '%s' "$c"
}

tmb_deny_ambiguous_git_target() {
  jq -nc --arg r "BLOCKED: ambiguous_git_target: \`${1:-git}\` names no directory and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Run with git -C <path> or cd <path> && …" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
}

tmb_agent_role() {
  local raw
  raw=$(printf '%s' "${1:-}" | jq -r '.agent_type // .subagent_type // empty' 2>/dev/null || true)
  raw=$(tmb_normalize_role "$raw")
  [ -n "$raw" ] || raw="bro"
  printf '%s' "$raw"
}

tmb_is_harness_turn() {
  case "${1:-}" in
    *"<task-notification>"*|*"[SYSTEM NOTIFICATION"*|*"Another Claude session sent a message"*|*"[Subagent hand-back]"*|*"<agent-message"*|*"<cross-session-message"*) return 0 ;;
  esac
  return 1
}

tmb_strip_quoted_spans() {
  printf '%s\n' "${1:-}" | awk -v sq="'" '
    function closes(q, from,   k, m) {
      m = length(buf)
      for (k = from + 1; k <= m; k++) {
        if (substr(buf, k, 1) == q && (k == m || substr(buf, k + 1, 1) !~ /[[:alnum:]]/)) return k
      }
      return 0
    }
    { buf = (NR == 1) ? $0 : buf "\n" $0 }
    END {
      n = length(buf); out = ""; i = 1
      while (i <= n) {
        c = substr(buf, i, 1)
        j = 0
        if (c == "`") {
          j = index(substr(buf, i + 1), "`")
          if (j > 0) j += i
        } else if ((c == sq || c == "\"") && (i == 1 || substr(buf, i - 1, 1) !~ /[[:alnum:]]/) && substr(buf, i + 1, 1) ~ /[^[:space:]]/) {
          j = closes(c, i + 1)
        }
        if (j > 0) { out = out " "; i = j + 1; continue }
        out = out c; i++
      }
      print out
    }
  '
}
