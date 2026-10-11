#!/usr/bin/env bash
# Library: shell-command analysis for TMB hooks.
# Sourced (not exec'd). No set -e/-euo/-euo pipefail here — libs must not
# mutate caller shell options.
#
# tmb_cmd_strip_literals <command>
#   Prints <command> with the parts that are data rather than shell syntax
#   neutralized, so a scanner never mistakes them for operators:
#     - heredoc bodies are dropped (the `<<WORD` operator stays);
#     - quotes are removed, and inside a quoted string every blank and every
#       operator character (< > | ; & ( )) becomes `_`, so `echo "> /tmp/z"`
#       is one word while `echo hi > "/tmp/z"` keeps its redirect target;
#     - `# comments` are dropped.
#   A quoted string spanning lines joins them with `_`.
#
# tmb_cmd_write_targets <stripped-command>
#   Prints one path per line for every write position in a command already
#   passed through tmb_cmd_strip_literals: `>`, `>>`, `>|`, `&>`, `&>>`
#   targets (fd duplications like 2>&1 are not paths), every non-option
#   argument of tee, mkdir, rm, touch, the destination of cp, mv, install and
#   rsync (last argument, or -t/--target-directory), the path of
#   `git worktree add` and the directory of `git clone`. Leading VAR=value
#   assignments and sudo/env/command/nohup/time wrappers are skipped. Paths
#   are printed as written (no expansion).
#
# tmb_path_canonical <absolute-path>
#   Prints the path with `.`/`..` resolved and symlinks resolved through its
#   longest existing ancestor (so /tmp and /private/tmp compare equal on
#   macOS); the path need not exist.

tmb_cmd_strip_literals() {
  printf '%s\n' "${1:-}" | awk -v sq="'" '
    function neutral(c) { return (c ~ /[ \t<>|;&()]/) ? "_" : c }
    BEGIN { state = ""; nh = 0; cur = 0; inbody = 0 }
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
        if (c == "\\") { out = out substr(line, i + 1, 1); i += 2; continue }
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
      if (state != "") { printf "%s_", out } else { print out }
      if (nh > 0 && state == "") { inbody = 1; cur = 1 }
    }
  '
}

tmb_cmd_write_targets() {
  printf '%s\n' "${1:-}" | awk '
    function flush(   k, first, cmd, nonopt, nn, a, sub_i, pos, skipnext, val) {
      first = 1
      while (first <= nw && (w[first] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || w[first] ~ /^(sudo|env|command|nohup|time)$/)) first++
      if (first > nw) { nw = 0; return }
      cmd = w[first]; sub(/.*\//, "", cmd)
      nn = 0
      if (cmd == "tee" || cmd == "mkdir" || cmd == "rm" || cmd == "touch" || cmd == "rmdir") {
        for (k = first + 1; k <= nw; k++) if (w[k] !~ /^-/) print w[k]
      } else if (cmd == "cp" || cmd == "mv" || cmd == "install" || cmd == "rsync") {
        installdir = 0
        for (k = first + 1; k <= nw; k++) {
          a = w[k]
          if (a == "-t" || a == "--target-directory") { if (k < nw) print w[k + 1]; k++; continue }
          if (a ~ /^--target-directory=/) { val = a; sub(/^--target-directory=/, "", val); print val; continue }
          if (cmd == "install" && a == "-d") { installdir = 1; continue }
          if (a ~ /^-/) continue
          nonopt[++nn] = a
        }
        if (installdir) { for (k = 1; k <= nn; k++) print nonopt[k] }
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
  local path="${1:-}" part out="" head tail="" real
  case "$path" in /*) ;; *) printf '%s\n' "$path"; return 0 ;; esac
  local IFS=/
  for part in $path; do
    case "$part" in
      ''|.) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$part" ;;
    esac
  done
  [ -n "$out" ] || out=/
  head="$out"
  while [ "$head" != "/" ] && [ ! -e "$head" ]; do
    tail="/${head##*/}$tail"
    head="${head%/*}"
    [ -n "$head" ] || head=/
  done
  if [ -d "$head" ]; then
    real=$(cd -P "$head" 2>/dev/null && pwd -P) || real="$head"
  else
    real=$(cd -P "$(dirname "$head")" 2>/dev/null && pwd -P)/$(basename "$head") || real="$head"
  fi
  [ "$real" = "/" ] && [ -n "$tail" ] && real=""
  printf '%s%s\n' "$real" "$tail"
}
