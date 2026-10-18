#!/usr/bin/env bash
# Library: shell-command analysis for TMB hooks.
# Sourced (not exec'd). No set -e/-euo/-euo pipefail here — libs must not
# mutate caller shell options.
#
# tmb_cmd_strip_literals <command> [keep|bodies]
#   Prints <command> with the parts that are data rather than shell syntax
#   neutralized, so a scanner never mistakes them for operators:
#     - heredoc bodies are dropped (the `<<WORD` operator stays), every form:
#       <<WORD, <<-WORD, <<'WORD', <<"WORD", several on one line, inside $( );
#     - quotes ('…', "…", $'…') are removed, and inside a quoted string every
#       blank and every operator character (< > | ; & ( ) `) becomes `_`, so
#       `echo "> /tmp/z"` is one word while `echo hi > "/tmp/z"` keeps its
#       redirect target;
#     - a $( ) or backtick inside double quotes runs, so its body is shell
#       syntax again (written as $( ) — with `keep`, as the bytes \007 … \010
#       that _tmb_cmd_statements_enc reads as a word of the outer statement);
#     - `# comments` are dropped.
#   A quoted string spanning lines joins them with `_`. With `keep`, those
#   characters (and backslash-escaped ones) become reversible control bytes
#   instead of `_` (see tmb_cmd_decode), so a quoted word can be recovered.
#   With `bodies`, prints instead each heredoc body the same scan drops, in
#   order: `<delimiter><TAB><body>`, its lines joined by \037.
#
# tmb_cmd_heredoc_bodies <command>
#   Every heredoc body of <command> in order, with the statement that carries
#   it: `<statement><TAB><delimiter><TAB><body>`, <statement> the 1-based
#   index among the command's top-level statements (as tmb_cmd_statements
#   lists them, bash -c / eval bodies not expanded), body lines joined by \037.
#
# tmb_cmd_write_targets <stripped-command>
#   Prints one path per line for every write position in a command already
#   passed through tmb_cmd_strip_literals: `>`, `>>`, `>|`, `&>`, `&>>`
#   targets (fd duplications like 2>&1 are not paths), every non-option
#   argument of tee, mkdir, rm, touch, the destination of cp, mv, install and
#   rsync (last argument, or -t/--target-directory), the `of=` of dd, every
#   file of truncate, the destination of `git mv`, every path of a link
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
#   quoted words carrying `_` for their blanks. A $( ) or backtick inside
#   double quotes yields its own statements and stays one word of the outer
#   statement, so the words after it still count. `bash|sh|zsh|dash|ksh -c <s>`
#   and `eval <s>` are analyzed recursively. <effective_dir> is, in order:
#     - the statement's own `git -C <path>` (chained -C compose);
#     - the dir set by a preceding `cd|pushd <path>` in the same command
#       (a relative path joins the dir before it, <cwd> for the first one;
#       a `( … )` subshell restores the outer dir when it closes);
#     - <cwd> (default $PWD) when the command never changes dir and <cwd>
#       belongs to at most one checkout: not a git repo, or a repo without
#       linked worktrees;
#     - `?` (ambiguous) when <cwd> is a repo with linked worktrees — the
#       statement may run in any of them, so a guard that needs its branch
#       must deny with tmb_deny_ambiguous_git_target;
#     - `-` (unknown) when the path is behind a variable, or after popd;
#       `cd -` returns to the dir before the preceding cd (unknown without one).
#
# tmb_cmd_write_paths <command> [<cwd>] [raw] [<root>]
#   Every path the command writes, one per line, statement by statement
#   (bash -c / eval bodies included): tmb_cmd_write_targets of the statement,
#   every file of an in-place `sed -i` / `perl -i`, the sources a mv / git mv
#   removes, and for an interpreter one-liner (python -c, node -e/-p,
#   perl -e/-E, ruby -e) whose program carries a write (open(…, 'w'|'a'|'x'
#   |'+'), perl open '>', write_text, fs.writeFile* / appendFile* / mkdir* /
#   rename* / rm*, File.write, IO.write, …) every path-like string literal of
#   the program that is not only read, plus every operand after the program.
#   A program an interpreter reads from stdin through a heredoc or here-string
#   (python/python3 with `-` or no script, node, perl, ruby, sh/bash/zsh/dash
#   with -s or no script) is analysed the same way; an sh program is a command
#   of its own, run in its statement's dir. A data heredoc (cat > f <<EOF,
#   python3 script.py <<EOF) is never read.
#   What find, fd and xargs run is a statement of its own: the command of
#   find -exec / -execdir / -ok / -okdir, fd -x / -X and xargs, with find's {}
#   (fd: {}, {.}, {//}; xargs: its -I string, else an appended argument) bound
#   to the paths find or fd lists as a loop variable is (below), so `rm {}`,
#   `sed -i … {}`, `mv {} {}.bak` and the rest write them; find -delete writes
#   them too, and -fprint / -fprint0 / -fprintf / -fls write their file. The
#   placeholder prints as `${find_path}` / `${fd_path}` / `${xargs_arg}`, and is
#   unresolvable when the paths cannot be bound (xargs: unless piped from one
#   find or fd); -print, -ls, -printf and the like write nothing.
#   $VAR, ${VAR} and ${VAR:-def} in a path resolve from assignments earlier in
#   the same command (VAR=value and export VAR=value statements, for loops,
#   one level of nesting; every value a variable may hold is printed), else
#   the default, else $PWD as the statement's own dir (cwd or a preceding cd),
#   $OLDPWD, within the && chain of a cd, as the dir before that cd (`cd -`
#   swaps the two; unresolvable elsewhere, since a failed cd leaves the
#   shell's own $OLDPWD) and the host's HOME / TMPDIR /
#   CLAUDE_PROJECT_DIR / TMB_MODEL_CACHE_DIR; ${VAR%suffix} strips a literal
#   suffix. A loop variable (`for VAR in $(…)`, `src | while read VAR`,
#   `while read VAR; do …; done < <(src)`) fed by one find, ls, git ls-files,
#   git diff --name-only, rg --files or fd whose every listed-from path (its
#   literal path arguments, else the dir it runs in; git -C composes) is
#   inside <root> holds each listed path and `<path>/*` (`*` for names
#   printed relative to the dir they are used in; `<path>/<pattern>` for a
#   -name / --glob pattern that can name a root prompt file; `<path>/*.md` under a prompt-surface dir, and
#   `<path>/<dir>/*.md` / `<path>/CLAUDE.md` when a recursive lister starts
#   above a prompt-surface dir of <root> it does not exclude), so
#   "$VAR", "$VAR.bak", "${VAR%.sh}.out" and "$VAR/x" are judged where the
#   listed files lie; any other source, or no <root>, leaves it unresolvable.
#   A VAR=value prefix does not reach its own command's words, as in the
#   shell: `HOME=/x cat > "$HOME/f"` is judged on the host's $HOME/f. A path that still holds a variable (one never set
#   here, set by read, or built by $( ) / backticks) prints
#   `UNRESOLVED:<var>:<path>` (<var> is `$()` for a command substitution);
#   every caller handles that form. A relative path is joined to its
#   statement's own dir (a preceding cd / pushd, a subshell restoring it,
#   git -C for git mv) and normalized: absolute when <cwd> is given, else
#   relative to the caller's dir; with `raw`, joined without collapsing `..`
#   (for a caller that canonicalizes symlinks itself). A relative path after
#   `cd $X` is printed as written. The write guards (swe-boundary.sh,
#   no-source-edit-from-main.sh, containment-guard.sh) take their written
#   paths from here and nowhere else.
#
# TMB_CMD_WRITE_SHAPES / tmb_cmd_write_shapes
#   The write shapes tmb_cmd_write_paths recognizes, for deny texts
#   (tmb_cmd_write_shapes prints them comma-joined).
#
# tmb_is_prompt_surface_path <path> [root]
#   Exit 0 when <path> is on the prompt surface: CLAUDE.md / CODEX.md / CURSOR.md /
#   GEMINI.md anywhere, or a .md whose root-relative path starts with agents/,
#   skills/, commands/, templates/, rules/ or .claude/{agents,skills,commands,rules}/
#   (src/agents/x.md and myskills/x.md are not surface). A relative <path> is already
#   root-relative; an absolute one is cut at [root], else at its enclosing
#   .claude/worktrees/<name> worktree or main git root. When no root resolves
#   the match is unanchored (a directory name at any depth), so nothing is lost
#   outside a repo.
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
# tmb_gh_mutation <statement>
#   For a statement that runs `gh …` / `glab …` prints the first write to the
#   forge it makes. gh/glab is judged at command position: argv0 (after
#   VAR=value prefixes), or any later word when argv0 is a wrapper or any
#   command that is not a data command, so /usr/bin/gh and every wrapper
#   (timeout, nice, xargs, stdbuf, sudo -u x, …) count. When argv0 is a data
#   command (echo, printf, grep, cat, sed, jq, …) its words never count. A
#   statement that starts with an option left by a removed wrapper
#   (`sudo -u git gh …` becomes `-u git gh …`) has no argv0 to judge, so
#   every word counts. For git only the commands it runs count: after
#   `bisect run`, `submodule [opts] foreach`, and rebase's -x in any short
#   cluster (-x, -ix, -x<cmd>) or --exec / --exe / --ex (with or without =);
#   in such a command every gh/glab word counts, compounds included.
#   Known misses: a shell alias (`git -c alias.X='!gh …' X`), a command run
#   as an editor or pager (GIT_SEQUENCE_EDITOR='gh …' git rebase -i,
#   GIT_EDITOR, GIT_PAGER, `git -c core.pager='gh …' log`, core.editor,
#   sequence.editor). Quoted and heredoc text is
#   stripped before this point. The write is the HTTP
#   verb of an `api` call (-X <V>, -X<V>, --method <V>, --method=<V> in any
#   position, V in POST|PATCH|PUT|DELETE, case-insensitive; with no verb,
#   POST when a -f/-F/--field/--raw-field/--input parameter is present, as
#   gh and glab send it), or the
#   `<group> <action>` of a mutating subcommand (issue/pr/mr create, merge,
#   close, edit, comment, …; release and repo writes). Prints nothing for
#   read-only calls and other statements.
#   Implied POST: an `api` call with no -X/--method and at least one
#   -f/-F/--field/--raw-field/--input parameter, for any endpoint. That
#   covers every `gh api graphql -f query=…` / `-F query=@file` / `--input`
#   call — GraphQL travels as a POST whether the document is a query or a
#   mutation, so all of them are mutation candidates. An explicit -X GET
#   wins, and a bare `gh api <path>` is a GET.
#
# tmb_stmt_repo_root <effective_dir> [<cwd>]
#   Prints the main checkout root of the repo a statement runs in: for a path,
#   the repo of its nearest existing ancestor (a dir a clone in the same
#   command will create belongs to where it is created); for `?`, the repo of
#   <cwd> (every linked worktree shares it). Empty for `-` or outside any repo.
#
# tmb_cwd_state <cwd>
#   Prints `?` when <cwd> is in a repo with linked worktrees, `-` when it is
#   not a directory, else <cwd> — the effective dir of a statement that names
#   none.
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
  local keep=0 bodies=0
  [ "${2:-}" = "keep" ] && keep=1
  [ "${2:-}" = "bodies" ] && bodies=1
  printf '%s\n' "${1:-}" | awk -v sq="'" -v keep="$keep" -v bodies="$bodies" '
    function neutral(c,   k) {
      if (keep) { k = index(" \t<>|;&()`", c); return k ? enc[k] : c }
      return (c ~ /[ \t<>|;&()`]/) ? "_" : c
    }
    function joiner() { return keep ? enc[12] : "_" }
    function subopen(  ) { sp++; pd[sp] = 0; return keep ? sprintf("%c", 7) : "$(" }
    function subclose(  ) { sp--; state = "d"; return keep ? sprintf("%c", 8) : ")" }
    function emitbody(k) { printf "%s\t%s\n", delim[k], body[k]; body[k] = ""; bn[k] = 0 }
    BEGIN {
      state = ""; nh = 0; cur = 0; inbody = 0; sp = 0
      for (k = 1; k <= 12; k++) enc[k] = sprintf("%c", k < 7 ? k : k + 7)
    }
    {
      line = $0
      if (inbody) {
        t = line
        if (tabs[cur]) sub(/^\t+/, "", t)
        if (t == delim[cur]) {
          if (bodies) emitbody(cur)
          cur++
          if (cur > nh) { inbody = 0; nh = 0; cur = 0 }
        } else if (bodies) {
          body[cur] = (bn[cur]++ ? body[cur] "\037" : "") t
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
        if (state == "a") {
          if (c == "\\") { out = out neutral(substr(line, i + 1, 1)); i += 2; continue }
          if (c == sq) { state = "" } else { out = out neutral(c) }
          i++; continue
        }
        if (state == "d") {
          if (c == "\\") { out = out neutral(substr(line, i + 1, 1)); i += 2; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") { out = out subopen(); state = ""; sub_bt[sp] = 0; i += 2; continue }
          if (c == "`") { out = out subopen(); state = ""; sub_bt[sp] = 1; i++; continue }
          if (c == "\"") { state = "" } else { out = out neutral(c) }
          i++; continue
        }
        if (sp > 0) {
          if (sub_bt[sp] && c == "`") { out = out subclose(); i++; continue }
          if (!sub_bt[sp] && c == "(") pd[sp]++
          if (!sub_bt[sp] && c == ")") {
            if (pd[sp] == 0) { out = out subclose(); i++; continue }
            pd[sp]--
          }
        }
        if (c == "$" && substr(line, i + 1, 1) == sq) { state = "a"; i += 2; continue }
        if (c == "\\") { out = out (keep ? neutral(substr(line, i + 1, 1)) : substr(line, i + 1, 1)); i += 2; continue }
        if (c == sq) { state = "s"; i++; continue }
        if (c == "\"") { state = "d"; i++; continue }
        if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t;&|(]/)) break
        if (substr(line, i, 3) == "<<<") { out = out "<<<"; i += 3; continue }
        if (substr(line, i, 2) == "<<") {
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
      if (!bodies) { if (state != "") { printf "%s%s", out, joiner() } else { print out } }
      if (nh > 0 && state == "") { inbody = 1; cur = 1 }
    }
    END { if (bodies && inbody) for (k = cur; k <= nh; k++) emitbody(k) }
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
      } else if (cmd == "dd") {
        for (k = first + 1; k <= nw; k++) if (w[k] ~ /^of=./) print substr(w[k], 4)
      } else if (cmd == "truncate") {
        for (k = first + 1; k <= nw; k++) {
          if (w[k] == "-s" || w[k] == "-r" || w[k] == "--size" || w[k] == "--reference") { k++; continue }
          if (w[k] !~ /^-/) print w[k]
        }
      } else if (cmd == "git") {
        k = first + 1
        while (k <= nw && w[k] ~ /^-/) { if (w[k] == "-C" || w[k] == "-c") k++; k++ }
        if (k <= nw && w[k] == "mv") {
          for (sub_i = k + 1; sub_i <= nw; sub_i++) if (w[sub_i] !~ /^-/) nonopt[++nn] = w[sub_i]
          if (nn >= 2) print nonopt[nn]
        } else if (k <= nw && w[k] == "worktree" && k + 1 <= nw && w[k + 1] == "add") {
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

# _tmb_cmd_statements_enc <command> <base-dir-token> <depth> [assign]
# Prints `<dir-token><TAB><encoded statement>` lines. A dir token is an
# absolute path, `@` (the caller's cwd), `@/<rel>` (relative to it) or `-`.
# Depth 3 lists the top-level statements only (bash -c / eval not expanded).
# With `assign`, a statement made only of VAR=value words is printed with the
# dir token `=<dir-token>`, and an unquoted $( ) or backtick leaves `$()` (encoded) where
# it stood, so a value or path built from a command reads as unresolvable.
# Also with `assign`: every dir token carries \022<old-dir-token>, the dir
# before the most recent cd (`-` when none; the base token may carry one too),
# and a loop variable's source is attached as a word \022<dir-token>\022<word>
# \022<word>… — to `for VAR in $(cmd …)` (after its `$()`) and to the `read` of
# `src | while read VAR` / `while read VAR; do …; done < <(src)`, and to the
# `xargs` of `src | xargs …` — when that source is one simple command (see
# _tmb_cmd_loop_source).
_tmb_cmd_statements_enc() {
  local cmd="${1:-}" base="${2:-@}" depth="${3:-0}" assign="${4:-}"
  local dir stmt inner
  tmb_cmd_strip_literals "$cmd" keep | awk -v base="$base" -v home="${HOME:-}" -v assign="$assign" '
    function closepar(pos,   k, d, ch, m) {
      d = 0; m = length(buf)
      for (k = pos; k <= m; k++) {
        ch = substr(buf, k, 1)
        if (ch == "(") d++
        else if (ch == ")") { d--; if (d == 0) return k }
      }
      return 0
    }
    function srcmark(body, dir) {
      if (body ~ /[;&|()`\n]/ || index(body, qo) || index(body, qc)) return ""
      gsub(/[ \t]+/, sep, body)
      sub("^" sep, "", body); sub(sep "$", "", body)
      if (body == "") return ""
      return sep dir sep body
    }
    function forsrc(pos,   j, k) {
      if (stmt !~ /^[ \t]*(((do|then|else|elif|\{|!)[ \t]+)*)for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]+\$$/) return ""
      j = closepar(pos)
      if (!j) return ""
      k = j + 1
      while (substr(buf, k, 1) ~ /[ \t]/) k++
      if (k <= length(buf) && substr(buf, k, 1) !~ /[;\n]/) return ""
      return srcmark(substr(buf, pos + 1, j - pos - 1), cur)
    }
    function donesrc(pos,   k, ch, w, depth, atcmd, pd, m, j) {
      depth = 0; atcmd = 1; pd = 0; k = pos; m = length(buf)
      while (k <= m) {
        ch = substr(buf, k, 1)
        if (ch ~ /[ \t]/) { k++; continue }
        if (ch ~ /[;\n&|`]/ || ch == qo || ch == qc) { atcmd = 1; k++; continue }
        if (ch == "(") { pd++; atcmd = 1; k++; continue }
        if (ch == ")") { if (--pd < 0) return ""; atcmd = 0; k++; continue }
        if (ch ~ /[<>]/) { atcmd = 0; k++; continue }
        w = ""
        while (k <= m) {
          ch = substr(buf, k, 1)
          if (ch ~ /[ \t;\n&|()<>`]/ || ch == qo || ch == qc) break
          w = w ch; k++
        }
        if (atcmd && w == "do") { depth++; continue }
        if (atcmd && w == "done") {
          if (--depth < 0) return ""
          if (depth > 0) { atcmd = 0; continue }
          while (substr(buf, k, 1) ~ /[ \t]/) k++
          if (substr(buf, k, 1) != "<") return ""
          k++
          while (substr(buf, k, 1) ~ /[ \t]/) k++
          if (substr(buf, k, 2) != "<(") return "!"
          j = closepar(k + 1)
          if (!j) return "!"
          w = srcmark(substr(buf, k + 2, j - k - 2), cur)
          return (w == "") ? "!" : w
        }
        atcmd = (atcmd && w ~ /^(then|else|elif|if|while|until|!|\{|\}|time)$/) ? 1 : 0
      }
      return ""
    }
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
    function flush(   n, w, k, first, a0, d, p, out, o, t, waspiped, sawwhile, mk, chained) {
      chained = (fsep == "&&"); fsep = ""
      n = split(stmt, w, /[ \t]+/)
      stmt = ""
      first = 1; asg = ""
      waspiped = piped; piped = 0; lastout = ""; lastdir = cur; sawwhile = 0
      while (first <= n) {
        if (w[first] == "") { first++; continue }
        if (w[first] == "while") sawwhile = 1
        if (w[first] ~ /^(\{|\}|!|if|then|else|elif|do|while|until|time|exec|command|nohup|sudo|env|fi|done|esac)$/) { first++; continue }
        if (w[first] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { asg = asg (asg == "" ? "" : " ") w[first]; first++; continue }
        break
      }
      if (first > n) {
        if (assign && asg != "") { printf "=%s\t%s\n", cur (assign ? sep old : ""), asg; if (!chained) old = "-" }
        return
      }
      a0 = w[first]
      out = a0
      for (k = first + 1; k <= n; k++) if (w[k] != "") out = out " " w[k]
      lastout = out
      d = cur; o = old
      if (a0 == "cd" || a0 == "pushd") {
        p = ""
        for (k = first + 1; k <= n; k++) {
          if (w[k] == "") continue
          if (w[k] ~ /^-[LPe@]+$/) continue
          p = w[k]; break
        }
        if (p == "-" && a0 == "cd") { t = cur; cur = old; old = t }
        else if (p == "" || p == "-") { old = cur; cur = "-" }
        else { old = cur; cur = resolve(cur, p) }
      } else if (a0 == "popd") {
        old = cur; cur = "-"
      } else if (assign && a0 == "read") {
        mk = sawwhile ? donesrc(i) : ""
        if (mk == "" && waspiped) mk = pipesrc
        if (mk != "" && mk != "!") out = out " " mk
      } else if (assign && a0 == "xargs") {
        if (waspiped && pipesrc != "") out = out " " pipesrc
      } else if (a0 == "git") {
        for (k = first + 1; k <= n; k++) {
          if (w[k] == "") continue
          if (w[k] == "-C") { d = resolve(d, w[k + 1]); k++; continue }
          if (w[k] == "-c") { k++; continue }
          if (w[k] ~ /^-/) continue
          break
        }
      }
      printf "%s\t%s\n", d (assign ? sep o : ""), out
      if (!chained) old = "-"
    }
    function rawword(t,   k, m, ch, out, x) {
      out = ""; m = length(t)
      for (k = 1; k <= m; k++) {
        ch = substr(t, k, 1)
        if (ch == qo) { out = out "$" enc[8]; continue }
        if (ch == qc) { out = out enc[9]; continue }
        if (ch == "\n") { out = out enc[12]; continue }
        x = index(" \t<>|;&()`", ch)
        out = out (x ? enc[x] : ch)
      }
      return out
    }
    BEGIN {
      sep = sprintf("%c", 18); old = "-"
      if (index(base, sep)) { old = substr(base, index(base, sep) + 1); base = substr(base, 1, index(base, sep) - 1) }
      cur = base; sp = 0; bt = 0; stmt = ""; qsp = 0; piped = 0; pipesrc = ""
      qo = sprintf("%c", 7); qc = sprintf("%c", 8)
      for (k = 1; k <= 12; k++) enc[k] = sprintf("%c", k < 7 ? k : k + 7)
    }
    { buf = (NR == 1) ? $0 : buf "\n" $0 }
    END {
      n = length(buf)
      for (i = 1; i <= n; i++) {
        c = substr(buf, i, 1)
        nx = substr(buf, i + 1, 1)
        if (c == qo) {
          qsp++; qstmt[qsp] = stmt; qcur[qsp] = cur; qold[qsp] = old; qstart[qsp] = i + 1; qsps[qsp] = sp
          stmt = ""; continue
        }
        if (c == qc) {
          if (qsp == 0) continue
          flush()
          stmt = qstmt[qsp] "$" enc[8] rawword(substr(buf, qstart[qsp], i - qstart[qsp])) enc[9]
          cur = qcur[qsp]; old = qold[qsp]; sp = qsps[qsp]; qsp--
          continue
        }
        if (c == "\n" || c == ";") { flush(); continue }
        if (c == "&") {
          if (nx == ">" || substr(buf, i - 1, 1) == ">") { stmt = stmt c; continue }
          if (nx == "&") { i++; fsep = "&&" }
          flush(); continue
        }
        if (c == "|") {
          if (substr(buf, i - 1, 1) == ">") { stmt = stmt c; continue }
          p1 = (nx != "|" && nx != "&")
          if (!p1) i++
          flush()
          if (assign && p1) { piped = 1; pipesrc = (lastout != "") ? srcmark(lastout, lastdir) : "" }
          continue
        }
        if (c == "(") {
          if (substr(stmt, length(stmt), 1) ~ /[$<>]/) {
            if (assign && substr(stmt, length(stmt), 1) == "$") stmt = stmt enc[8] enc[9] forsrc(i)
            else stmt = substr(stmt, 1, length(stmt) - 1)
          }
          flush(); ostack[sp + 1] = old; stack[++sp] = cur; continue
        }
        if (c == ")") { flush(); if (sp > 0) { old = ostack[sp]; cur = stack[sp--] }; continue }
        if (c == "`") {
          if (assign && !bt) stmt = stmt "$" enc[8] enc[9]
          flush()
          if (bt) { bt = 0; if (sp > 0) { old = ostack[sp]; cur = stack[sp--] } } else { bt = 1; ostack[sp + 1] = old; stack[++sp] = cur }
          continue
        }
        stmt = stmt c
      }
      flush()
    }
  ' | while IFS="$(printf '\t')" read -r dir stmt; do
    [ -n "$stmt" ] || continue
    inner=""
    if [ "$depth" -lt 3 ] && [ "${dir#=}" = "$dir" ]; then inner=$(_tmb_cmd_inner "$stmt"); fi
    if [ -n "$inner" ]; then
      _tmb_cmd_statements_enc "$(tmb_cmd_decode "$inner")" "$dir" $((depth + 1)) "$assign"
    else
      printf '%s\t%s\n' "$dir" "$stmt"
    fi
  done
}

# _tmb_cmd_inner <encoded-statement>
# The encoded command string a statement runs as shell: the <s> of
# `bash|sh|zsh|dash|ksh -c <s>` or the rest of `eval <s>`; nothing otherwise.
_tmb_cmd_inner() {
  local stmt="${1:-}" w i
  local -a words
  read -r -a words <<< "$stmt"
  case "${words[0]:-}" in
    bash|sh|zsh|dash|ksh|*/bash|*/sh|*/zsh|*/dash|*/ksh)
      for ((i = 1; i < ${#words[@]}; i++)); do
        w="${words[$i]}"
        case "$w" in
          -c|-[a-zA-Z]*c|-c[a-zA-Z]*) printf '%s' "${words[$((i + 1))]:-}"; return 0 ;;
          -*) ;;
          *) return 0 ;;
        esac
      done
      ;;
    eval)
      w="${stmt#eval}"
      printf '%s' "${w# }"
      ;;
  esac
}

tmb_cwd_state() {
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
        if [ -d "$cwd" ]; then dir="${cwd%/}${dir#@}"; else dir=-; fi
        ;;
      @)
        [ -n "$state" ] || state=$(tmb_cwd_state "$cwd")
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

tmb_gh_mutation() {
  local -a w g
  local k=0 n a sub found
  read -r -a w <<< "${1:-}"
  n=${#w[@]}
  while [ "$k" -lt "$n" ]; do
    case "${w[$k]}" in [A-Za-z_]*=*) k=$((k + 1)) ;; *) break ;; esac
  done
  [ "$k" -lt "$n" ] || return 0
  case "${w[$k]##*/}" in
    git)
      sub=$(tmb_git_subcommand "${w[*]:$k}")
      read -r -a g <<< "$sub"
      case "${g[0]:-} ${g[1]:-}" in
        "bisect run") _tmb_gh_mutation_in "${g[@]:2}"; return 0 ;;
      esac
      if [ "${g[0]:-}" = "submodule" ]; then
        k=1
        while [ "$k" -lt "${#g[@]}" ] && [ "${g[$k]#-}" != "${g[$k]}" ]; do k=$((k + 1)); done
        [ "${g[$k]:-}" = "foreach" ] || return 0
        k=$((k + 1))
        while [ "$k" -lt "${#g[@]}" ] && [ "${g[$k]#-}" != "${g[$k]}" ]; do k=$((k + 1)); done
        _tmb_gh_mutation_in "${g[@]:$k}"
        return 0
      fi
      [ "${g[0]:-}" = "rebase" ] || return 0
      for ((k = 1; k < ${#g[@]}; k++)); do
        a="${g[$k]}"
        case "$a" in
          --ex|--exe|--exec) found=$(_tmb_gh_mutation_in "${g[$((k + 1))]:-}"); k=$((k + 1)) ;;
          --ex=*|--exe=*|--exec=*) found=$(_tmb_gh_mutation_in "${a#*=}") ;;
          --*) found="" ;;
          -*x*)
            if [ -n "${a#*x}" ]; then
              found=$(_tmb_gh_mutation_in "${a#*x}")
            else
              found=$(_tmb_gh_mutation_in "${g[$((k + 1))]:-}"); k=$((k + 1))
            fi
            ;;
          *) found="" ;;
        esac
        if [ -n "$found" ]; then printf '%s\n' "$found"; return 0; fi
      done
      return 0
      ;;
    echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|head|tail|less|more|sed|awk|gawk|jq|yq|test|'['|'[['|man|which|type|wc|sort|cut|tr) return 0 ;;
  esac
  for ((; k < n; k++)); do
    case "${w[$k]##*/}" in
      gh|glab)
        found=$(tmb_gh_mutation_from "${w[@]:$k}")
        if [ -n "$found" ]; then printf '%s\n' "$found"; return 0; fi
        ;;
    esac
  done
}

# _tmb_gh_mutation_in <words…>
# The first forge write of a command git runs from its own arguments. A quoted
# command arrives as one word with `_` for its blanks and its operators, so
# its statements cannot be told apart: every gh/glab word in it is judged.
_tmb_gh_mutation_in() {
  local cmd="$*" k found
  local -a w
  [ -n "$cmd" ] || return 0
  read -r -a w <<< "${cmd//_/ }"
  for ((k = 0; k < ${#w[@]}; k++)); do
    case "${w[$k]##*/}" in
      gh|glab)
        found=$(tmb_gh_mutation_from "${w[@]:$k}")
        if [ -n "$found" ]; then printf '%s\n' "$found"; return 0; fi
        ;;
    esac
  done
}

tmb_gh_mutation_from() {
  local -a w=("$@")
  local k=1 n=$# tool skipval=0 a verb="" group="" action="" writes="" fields=0
  tool="${w[0]##*/}"
  while [ "$k" -lt "$n" ]; do
    a="${w[$k]}"
    k=$((k + 1))
    if [ "$skipval" = 1 ]; then skipval=0; continue; fi
    case "$a" in
      -R|--repo) skipval=1; continue ;;
      -*) continue ;;
    esac
    if [ -z "$group" ]; then group="$a"; [ "$group" = "api" ] && break; continue; fi
    action="$a"
    break
  done
  if [ "$group" = "api" ]; then
    while [ "$k" -lt "$n" ]; do
      a="${w[$k]}"
      k=$((k + 1))
      case "$a" in
        -X|--method) verb="${w[$k]:-}"; k=$((k + 1)) ;;
        --method=*) verb="${a#--method=}" ;;
        -X*) verb="${a#-X}" ;;
        -f|-F|--field|--raw-field|--input) fields=1; k=$((k + 1)) ;;
        -f*|-F*|--field=*|--raw-field=*|--input=*) fields=1 ;;
      esac
    done
    verb=$(printf '%s' "$verb" | tr '[:lower:]' '[:upper:]')
    [ -n "$verb" ] || { [ "$fields" = 1 ] && verb=POST; }
    case "$verb" in
      POST|PATCH|PUT|DELETE) printf '%s\n' "$verb" ;;
    esac
    return 0
  fi
  case "$tool $group" in
    "gh issue") writes="create close edit delete comment reopen transfer lock unlock pin unpin develop" ;;
    "gh pr") writes="create merge close edit comment reopen ready review lock unlock" ;;
    "gh release") writes="create edit delete delete-asset upload" ;;
    "gh repo") writes="create delete edit fork rename archive unarchive sync" ;;
    "gh label") writes="create edit delete clone" ;;
    "glab issue") writes="create close update edit delete note reopen" ;;
    "glab mr") writes="create merge close update edit delete note reopen approve rebase" ;;
    "glab release") writes="create update delete upload" ;;
    "glab repo") writes="create delete archive fork transfer" ;;
    *) return 0 ;;
  esac
  case " $writes " in *" $action "*) ;; *) return 0 ;; esac
  [ -n "$action" ] || return 0
  printf '%s %s\n' "$group" "$action"
}

TMB_CMD_WRITE_SHAPES=(
  '>' '>>' '>|' '&>' 'exec N>' 'heredoc into a redirect' 'tee' 'tee -a'
  'sed -i' 'perl -i' 'dd of=' 'truncate' 'cp' 'mv' 'install' 'rsync' 'git mv'
  'ln' 'mkdir' 'rm' 'touch'
  'python -c / node -e / perl -e / ruby -e with a write mode'
  'a program fed to python / node / perl / ruby / sh through a heredoc'
  'find -exec / -execdir / -ok / -delete / -fprint' 'fd -x / -X' 'xargs fed by find or fd'
)

tmb_cmd_write_shapes() {
  local out="" s
  for s in "${TMB_CMD_WRITE_SHAPES[@]}"; do out="${out:+$out, }$s"; done
  printf '%s' "$out"
}

# _tmb_surface_root <absolute-path>
# Prints the repo root of an absolute path: the enclosing .claude/worktrees/<name>
# worktree, else the main git root of the nearest existing ancestor; nothing when
# neither resolves.
_tmb_surface_root() {
  local p="$1" dir
  case "$p" in
    */.claude/worktrees/*)
      printf '%s' "$p" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|'
      return 0
      ;;
  esac
  dir="${p%/*}"
  while [ -n "$dir" ] && [ ! -d "$dir" ]; do dir="${dir%/*}"; done
  [ -n "$dir" ] || dir=/
  declare -F tmb_repo_git_root >/dev/null 2>&1 || {
    # shellcheck source=scripts/hooks/lib/resolve-repo.sh disable=SC1091
    . "$(dirname "${BASH_SOURCE[0]}")/resolve-repo.sh"
  }
  tmb_repo_git_root "$dir"
}

tmb_is_prompt_surface_path() {
  local p="$1" root="${2:-}" rel="" abs
  case "${p##*/}" in CLAUDE.md|CODEX.md|CURSOR.md|GEMINI.md) return 0 ;; esac
  case "$p" in
    /*)
      abs=$(tmb_path_canonical "$p")
      [ -n "$root" ] || root=$(_tmb_surface_root "$abs")
      if [ -n "$root" ]; then
        root=$(tmb_path_canonical "$root")
        case "$abs" in "${root%/}"/*) rel="${abs#"${root%/}"/}" ;; esac
      fi
      ;;
    *) rel="${p#./}" ;;
  esac
  if [ -z "$rel" ]; then
    case "$p" in *.md) ;; *) return 1 ;; esac
    case "/${p#/}" in
      */agents/*|*/skills/*|*/commands/*|*/templates/*|*/rules/*) return 0 ;;
    esac
    return 1
  fi
  case "$rel" in
    agents/*.md|skills/*.md|commands/*.md|templates/*.md|rules/*.md) return 0 ;;
    .claude/agents/*.md|.claude/skills/*.md|.claude/commands/*.md|.claude/rules/*.md) return 0 ;;
  esac
  return 1
}

# _tmb_cmd_interp_writes <encoded-statement-words…>
# The paths an interpreter one-liner (python -c, node -e/-p, perl -e/-E,
# ruby -e) may write: the paths its program writes (_tmb_cmd_prog_writes),
# plus, when it writes any, every operand after the program.
_tmb_cmd_interp_writes() {
  local argv0="${1##*/}" flags w prog="" k=1 n=$# found
  local -a words=("$@")
  case "$argv0" in
    python|python3|python[23].*) flags="-c" ;;
    node|nodejs) flags="-e --eval -p --print" ;;
    perl) flags="-e -E" ;;
    ruby) flags="-e" ;;
    *) return 0 ;;
  esac
  while [ "$k" -lt "$n" ]; do
    w="${words[$k]}"
    k=$((k + 1))
    case " $flags " in *" $w "*) prog=$(tmb_cmd_decode "${words[$k]:-}"); k=$((k + 1)); break ;; esac
  done
  [ -n "$prog" ] || return 0
  found=$(_tmb_cmd_prog_writes "$prog" operands)
  [ -n "$found" ] || return 0
  [ "$found" = "-" ] || printf '%s\n' "$found"
  while [ "$k" -lt "$n" ]; do
    w="${words[$k]}"
    k=$((k + 1))
    case "$w" in -*) ;; *) tmb_cmd_decode "$w"; printf '\n' ;; esac
  done
}

# _tmb_cmd_prog_writes <program> [operands]
# When a python / node / perl / ruby program carries a write (open(…, 'w'|'a'
# |'x'|'+'), perl open '>', pathlib write_text / write_bytes, fs.writeFile* /
# appendFile* / createWriteStream / mkdir* / rename* / rm* / unlink*, File /
# IO .write, os / shutil writes), every path-like string literal of the
# program except those only read (open(p) / open(p, 'r'), readFileSync,
# read_text, perl '<'). With `operands`, a program that writes but names no
# literal prints `-` so the caller still judges its operands.
_tmb_cmd_prog_writes() {
  local prog="${1:-}" q="['\"]" sp="[[:space:]]*" reads writes fn out
  fn="writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|renameSync|rmSync|rmdirSync|unlinkSync|copyFileSync|cpSync|fs\.(mkdir|rename|rm|rmdir|unlink|copyFile|cp)|makedirs|rmtree|(File|IO)\.(bin)?write|os\.(remove|unlink|mkdir|rename|replace|rmdir)|shutil\.(copy|copyfile|copy2|copytree|move)"
  writes=$(printf '%s\n' "$prog" | grep -oE "open${sp}\(${sp}${q}[^'\"]+${q}${sp},${sp}(mode${sp}=${sp})?${q}[rbt]*[wax+]|(${fn})${sp}\(${sp}${q}[^'\"]+${q}|Path${sp}\(${sp}${q}[^'\"]+${q}${sp}\)${sp}\.${sp}(write_text|write_bytes|mkdir|touch|unlink|rmdir|rename)" || true)
  if [ -z "$writes" ] && ! printf '%s\n' "$prog" | grep -E "open${sp}\([^)]*,${sp}(mode${sp}=${sp})?${q}[rbt]*[wax+]|open${sp}\(?[^,;()]*,${sp}${q}[+]?>|write_text|write_bytes|createWriteStream|(${fn})${sp}\(" >/dev/null; then
    return 0
  fi
  reads=$(printf '%s\n' "$prog" | grep -oE "open${sp}\(${sp}${q}[^'\"]+${q}${sp}(,${sp}${q}r[bt]?${q}${sp})?\)|(readFileSync|readFile|createReadStream|existsSync|statSync)${sp}\(${sp}${q}[^'\"]+${q}|Path${sp}\(${sp}${q}[^'\"]+${q}${sp}\)${sp}\.${sp}(read_text|read_bytes|exists)" | grep -oE "${q}[^'\"]+${q}" || true)
  writes=$(printf '%s\n' "$writes" | grep -oE "^[^'\"]*${q}[^'\"]+${q}" | grep -oE "${q}[^'\"]+${q}\$" || true)
  out=$(_tmb_cmd_prog_literals "$prog" "$reads" "$writes")
  if [ -n "$out" ]; then printf '%s\n' "$out"; elif [ "${2:-}" = "operands" ]; then printf -- '-\n'; fi
}

# _tmb_cmd_prog_literals <program> <read-literals> <write-literals>
# Every path-like string literal of <program> that is not only read.
_tmb_cmd_prog_literals() {
  local lit q="['\"]"
  printf '%s\n' "${1:-}" | grep -oE "${q}[^'\"[:space:]]+${q}" | while IFS= read -r lit; do
    if printf '%s\n' "${2:-}" | grep -xF -- "$lit" >/dev/null && ! printf '%s\n' "${3:-}" | grep -xF -- "$lit" >/dev/null; then continue; fi
    lit="${lit:1:${#lit}-2}"
    lit="${lit#+}"; lit="${lit#>}"; lit="${lit#>}"
    case "$lit" in ''|.|..|*[!A-Za-z0-9_./~-]*) continue ;; esac
    case "$lit" in */*|*.[A-Za-z0-9]*) printf '%s\n' "$lit" ;; esac
  done
}

# _tmb_cmd_stdin_interp <encoded-statement-words…>
# Prints py, node, perl, ruby or sh when the statement runs an interpreter
# that reads its program from stdin: `-` or no script operand, no -c / -e /
# -m program option (sh: also -s). Nothing otherwise.
_tmb_cmd_stdin_interp() {
  local kind w k=1 n=$# skip=0
  local -a words=("$@")
  case "${1##*/}" in
    python|python3|python[23].*) kind=py ;;
    node|nodejs) kind=node ;;
    perl) kind=perl ;;
    ruby) kind=ruby ;;
    sh|bash|zsh|dash|ksh) kind="sh" ;;
    *) return 0 ;;
  esac
  while [ "$k" -lt "$n" ]; do
    w="${words[$k]}"
    k=$((k + 1))
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$w" in
      '<<<') skip=1; continue ;;
      '<<'*) continue ;;
      '<'|'>'|'>>'|'>|'|'&>'|'&>>'|[0-9]'<'|[0-9]'>'|[0-9]'>>') skip=1; continue ;;
      '<'*|'>'*|'&>'*|[0-9]'<'*|[0-9]'>'*) continue ;;
      -|--) printf '%s' "$kind"; return 0 ;;
      --*)
        case "$kind:$w" in
          node:--eval|node:--print|node:--eval=*|node:--print=*) return 0 ;;
          node:--require|node:--import|node:--loader|node:--input-type) skip=1 ;;
        esac
        continue
        ;;
      -*)
        case "$kind:$w" in
          py:-*c|py:-*m|py:-*c*|node:-e|node:-p|perl:-*[eE]*|ruby:-*e*|sh:-*c*) return 0 ;;
          sh:-*s*) printf '%s' "$kind"; return 0 ;;
          py:-W|py:-X|node:-r|ruby:-r|ruby:-I|perl:-I|perl:-M|sh:-o|sh:-O) skip=1 ;;
        esac
        continue
        ;;
      *) return 0 ;;
    esac
  done
  printf '%s' "$kind"
}

# _tmb_cmd_inplace_files <tool> <encoded-words-after-argv0…>
# Every file operand of an in-place sed / perl (-i): the operands after the
# script (the first operand unless -e / -f gave it).
_tmb_cmd_inplace_files() {
  local tool="$1" w inplace=0 hasprog=0 skip=0
  local -a ops=()
  shift
  for w in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$tool:$w" in
      *:--) continue ;;
      sed:--in-place*|sed:-i*|sed:-[a-zA-Z]*i) inplace=1 ;;
      sed:-e|sed:-f|sed:--expression|sed:--file|sed:-l) hasprog=1; skip=1 ;;
      sed:--expression=*|sed:--file=*) hasprog=1 ;;
      sed:-[a-zA-Z]*[ef]) hasprog=1; skip=1 ;;
      perl:--*) ;;
      perl:-*[eE]) case "$w" in *i*) inplace=1 ;; esac; hasprog=1; skip=1 ;;
      perl:-*i*) inplace=1 ;;
      *:-*) ;;
      *) ops+=("$w") ;;
    esac
  done
  [ "$inplace" = 1 ] && [ "${#ops[@]}" -gt 0 ] || return 0
  [ "$hasprog" = 1 ] || ops=("${ops[@]:1}")
  [ "${#ops[@]}" -gt 0 ] || return 0
  printf '%s\n' "${ops[@]}"
}

# _tmb_cmd_stmt_write_paths <encoded-statement>
# The written paths of one statement, as written (encoded): the write targets,
# every in-place sed / perl file, the sources a mv / git mv removes, and the
# paths an interpreter one-liner writes.
_tmb_cmd_stmt_write_paths() {
  local stmt="${1:-}" w k=1
  local -a words ops=()
  tmb_cmd_write_targets "$stmt"
  read -r -a words <<< "$stmt"
  [ "${#words[@]}" -gt 1 ] || return 0
  case "${words[0]##*/}" in
    sed|perl) _tmb_cmd_inplace_files "${words[0]##*/}" "${words[@]:1}" ;;
    mv) ops=("${words[@]:1}") ;;
    git)
      while [ "$k" -lt "${#words[@]}" ]; do
        case "${words[$k]}" in
          -C|-c) k=$((k + 2)) ;;
          -*) k=$((k + 1)) ;;
          *) break ;;
        esac
      done
      [ "${words[$k]:-}" = "mv" ] && ops=("${words[@]:$((k + 1))}")
      ;;
  esac
  if [ "${#ops[@]}" -gt 0 ]; then
    local -a srcs=()
    for w in "${ops[@]}"; do case "$w" in -*) ;; *) srcs+=("$w") ;; esac; done
    if [ "${#srcs[@]}" -ge 2 ]; then printf '%s\n' "${srcs[@]:0:${#srcs[@]}-1}"; fi
  fi
  _tmb_cmd_interp_writes "${words[@]}"
}

# _tmb_cmd_join <dir-token> <path> <cwd>
# <path> joined to its statement's dir token and normalized; as written when
# the dir is unknown or the path holds a variable.
_tmb_cmd_join() {
  local dir="${1:-}" p="${2:-}" cwd="${3:-}" base
  case "$p" in *'$'*|*'`'*) printf '%s\n' "$p"; return 0 ;; esac
  if [ "$p" = "~" ] || [ "${p#\~/}" != "$p" ]; then
    [ -n "${HOME:-}" ] || { printf '%s\n' "$p"; return 0; }
    p="${HOME}${p#\~}"
  fi
  case "$p" in
    /*) base="" ;;
    *)
      case "$dir" in
        -) printf '%s\n' "$p"; return 0 ;;
        @) base="$cwd" ;;
        @/*) base="${cwd:+${cwd%/}}${cwd:+/}${dir#@/}" ;;
        *) base="$dir" ;;
      esac
      ;;
  esac
  if [ -n "${_TMB_CMD_RAWJOIN:-}" ]; then printf '%s\n' "${base:+${base%/}/}$p"; return 0; fi
  printf '%s\n' "${base:+$base/}$p" | awk '{
    lead = (substr($0, 1, 1) == "/") ? "/" : ""
    n = split($0, parts, "/"); m = 0
    for (k = 1; k <= n; k++) {
      if (parts[k] == "" || parts[k] == ".") continue
      if (parts[k] == ".." && m > 0 && out[m] != "..") { m--; continue }
      if (parts[k] == ".." && lead == "/") continue
      out[++m] = parts[k]
    }
    p = ""
    for (k = 1; k <= m; k++) p = p (k > 1 ? "/" : "") out[k]
    if (p == "" && lead == "") p = "."
    print lead p
  }'
}

tmb_cmd_write_paths() {
  local _TMB_CMD_VARS="" _TMB_CMD_RAWJOIN="" _TMB_CMD_PWD="" _TMB_CMD_OLDTOK="-"
  local _TMB_CMD_CWD="${2:-}" _TMB_CMD_ROOT="${4:-}" _TMB_CMD_ROOTC=""
  [ "${3:-}" = "raw" ] && _TMB_CMD_RAWJOIN=1
  _tmb_cmd_write_paths_in "${1:-}" "${2:-}" "@" 0
  return 0
}

tmb_cmd_heredoc_bodies() {
  case "${1:-}" in *'<<'*) ;; *) return 0 ;; esac
  _tmb_cmd_heredoc_align "$1" "$(_tmb_cmd_statements_enc "$1" "@" 3)"
}

# _tmb_cmd_heredoc_align <command> <statement-listing>
# Pairs each heredoc body of <command> (textual order) with the statement of
# <statement-listing> whose `<<WORD` operator names its delimiter, in order:
# `<line-of-listing><TAB><delimiter><TAB><body, \037 for newline>`.
_tmb_cmd_heredoc_align() {
  awk '
    FILENAME == ARGV[1] { t = index($0, "\t"); nb++; bd[nb] = substr($0, 1, t - 1); bb[nb] = substr($0, t + 1); next }
    {
      si++
      s = substr($0, index($0, "\t") + 1)
      while (match(s, /<<+/)) {
        op = substr(s, RSTART, RLENGTH)
        s = substr(s, RSTART + RLENGTH)
        if (op != "<<") continue
        d = ""; k = 1
        while (k <= length(s) && substr(s, k, 1) !~ /[ \t;&|<>()]/) { d = d substr(s, k, 1); k++ }
        if (d == "") continue
        for (j = p + 1; j <= nb; j++) if (!used[j] && bd[j] == d) break
        if (j <= nb) { used[j] = 1; p = j; printf "%s\t%s\t%s\n", si, d, bb[j] }
      }
    }
  ' <(tmb_cmd_strip_literals "${1:-}" bodies) <(printf '%s\n' "${2:-}")
}

# _tmb_cmd_write_paths_in <command> <cwd> <base-dir-token> <depth>
# tmb_cmd_write_paths for one command level; bash -c / eval bodies and sh
# programs fed through a heredoc recurse with their statement's dir. Variable
# assignments accumulate in the caller-scoped _TMB_CMD_VARS.
_tmb_cmd_write_paths_in() {
  local cmd="${1:-}" cwd="${2:-}" base="${3:-@}" depth="${4:-0}"
  local listing bodies="" dir stmt p inner kind idx=0 w prog b_idx b_body old mark
  local -a words progs
  local _TMB_CMD_VARS="${_TMB_CMD_VARS:-}" _TMB_CMD_OLDTOK="-"
  listing=$(_tmb_cmd_statements_enc "$cmd" "$base" 3 assign)
  case "$cmd" in *'<<'*) bodies=$(_tmb_cmd_heredoc_align "$cmd" "$listing") ;; esac
  while IFS="$(printf '\t')" read -r dir stmt; do
    idx=$((idx + 1))
    old="${dir#*$'\022'}"
    [ "$old" != "$dir" ] || old="-"
    dir="${dir%%$'\022'*}"
    _TMB_CMD_OLDTOK="$old"
    read -r -a words <<< "$stmt"
    [ "${#words[@]}" -gt 0 ] || continue
    if [ "${dir#=}" != "$dir" ]; then
      _TMB_CMD_PWD=$(_tmb_cmd_dir_path "${dir#=}" "$cwd")
      for w in "${words[@]}"; do _tmb_cmd_var_set "${w%%=*}" "$(tmb_cmd_decode "${w#*=}")"; done
      continue
    fi
    if [ "$depth" -lt 3 ]; then
      inner=$(_tmb_cmd_inner "$stmt")
      if [ -n "$inner" ]; then
        _tmb_cmd_write_paths_in "$(tmb_cmd_decode "$inner")" "$cwd" "$dir"$'\022'"$old" $((depth + 1))
        continue
      fi
    fi
    mark=""
    if [ "${words[0]##*/}" = xargs ] && [ "${words[${#words[@]}-1]#$'\022'}" != "${words[${#words[@]}-1]}" ]; then
      mark="${words[${#words[@]}-1]}"
      words=("${words[@]:0:${#words[@]}-1}")
      stmt="${words[*]}"
    fi
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      _tmb_cmd_emit "$dir" "$(tmb_cmd_decode "$p")" "$cwd"
    done < <(_tmb_cmd_stmt_write_paths "$stmt")
    case "${words[0]##*/}" in
      find|fd|fdfind|xargs) _tmb_cmd_exec_writes "$dir" "$cwd" "$mark" "${words[@]}" ;;
    esac
    kind=$(_tmb_cmd_stdin_interp "${words[@]}")
    if [ -n "$kind" ]; then
      progs=()
      for ((w = 0; w < ${#words[@]}; w++)); do
        case "${words[$w]}" in
          '<<<') progs+=("$(tmb_cmd_decode "${words[$((w + 1))]:-}")") ;;
          '<<<'*) progs+=("$(tmb_cmd_decode "${words[$w]#<<<}")") ;;
        esac
      done
      while IFS="$(printf '\t')" read -r b_idx _ b_body; do
        [ "$b_idx" = "$idx" ] && progs+=("$(printf '%s' "$b_body" | tr '\037' '\n')")
      done <<< "$bodies"
      for prog in ${progs[@]+"${progs[@]}"}; do
        if [ "$kind" = "sh" ]; then
          [ "$depth" -lt 3 ] && _tmb_cmd_write_paths_in "$prog" "$cwd" "$dir"$'\022'"$old" $((depth + 1))
        else
          while IFS= read -r p; do
            [ -n "$p" ] && _tmb_cmd_emit "$dir" "$p" "$cwd"
          done < <(_tmb_cmd_prog_writes "$prog")
        fi
      done
    fi
    _TMB_CMD_PWD=$(_tmb_cmd_dir_path "$dir" "$cwd")
    _tmb_cmd_track_vars "${words[@]}"
  done <<< "$listing"
  return 0
}

# _tmb_cmd_exec_writes <dir-token> <cwd> <xargs-source-mark> <encoded-statement-words…>
# The paths a find, fd or xargs statement writes through what it runs. The
# command of find -exec / -execdir / -ok / -okdir, fd -x / -X and xargs is
# judged as a statement of its own (_tmb_cmd_stmt_write_paths) with its
# placeholder bound to a variable: find's {} to ${find_path}; fd's {}, {.}
# and {//} to ${fd_path}, {/} and {/.} to `*` in its dir; xargs's -I / -i /
# -J string, else an appended last argument, to ${xargs_arg}. find -delete
# writes ${find_path}, and -fprint / -fprint0 / -fprintf / -fls their file.
# find and fd bind the variable from their own paths (_tmb_cmd_lister_bind);
# xargs from the find or fd it is piped from (<xargs-source-mark>,
# _tmb_cmd_loop_source). Any other input, or paths that cannot be bound,
# leave it unresolvable.
_tmb_cmd_exec_writes() {
  local dir="${1:-}" cwd="${2:-}" mark="${3:-}" tool name act cmd p k=1 n rep="" noin=0 ph rv
  local _TMB_CMD_VARS="${_TMB_CMD_VARS:-}"
  local -a words _TMB_CMD_ACTS=()
  shift 3
  words=("$@")
  n=${#words[@]}
  tool="${words[0]##*/}"
  case "$tool" in
    find) name=find_path ;;
    fd|fdfind) name=fd_path ;;
    xargs)
      name=xargs_arg
      while [ "$k" -lt "$n" ]; do
        p="${words[$k]}"
        case "$p" in
          --) k=$((k + 1)); break ;;
          -I|-J) rep="${words[$((k + 1))]:-}"; k=$((k + 2)) ;;
          -I*|-J*) rep="${p#-?}"; k=$((k + 1)) ;;
          -i|--replace) rep='{}'; k=$((k + 1)) ;;
          -i*) rep="${p#-i}"; k=$((k + 1)) ;;
          --replace=*) rep="${p#--replace=}"; k=$((k + 1)) ;;
          -a|--arg-file) noin=1; k=$((k + 2)) ;;
          -a*|--arg-file=*) noin=1; k=$((k + 1)) ;;
          -d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars) k=$((k + 2)) ;;
          -*) k=$((k + 1)) ;;
          *) break ;;
        esac
      done
      [ "$k" -lt "$n" ] || return 0
      cmd="${words[*]:$k}"
      rv="\${$name}"
      if [ -n "$rep" ]; then cmd="${cmd//"$rep"/$rv}"; else cmd="$cmd $rv"; fi
      _TMB_CMD_ACTS=("x$cmd")
      if [ "$noin" = 1 ] || [ -z "$mark" ] || ! _tmb_cmd_loop_source "$name" "$mark"; then
        _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}"$'\t\001\n'
      fi
      ;;
    *) return 0 ;;
  esac
  if [ "$tool" != xargs ]; then
    _tmb_cmd_lister_bind "$name" "$dir" exec "${words[@]}" || _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}"$'\t\001\n'
  fi
  [ "${#_TMB_CMD_ACTS[@]}" -gt 0 ] || return 0
  rv="\${$name}"
  for act in "${_TMB_CMD_ACTS[@]}"; do
    case "$act" in
      d) _tmb_cmd_emit "$dir" "$rv" "$cwd" ;;
      f*) _tmb_cmd_emit "$dir" "$(tmb_cmd_decode "${act#f}")" "$cwd" ;;
      x*)
        cmd="${act#x}"
        case "$tool" in
          find) ph='{}'; cmd="${cmd//"$ph"/$rv}" ;;
          fd|fdfind)
            for ph in '{//}' '{.}' '{}'; do cmd="${cmd//"$ph"/$rv}"; done
            for ph in '{/.}' '{/}'; do cmd="${cmd//"$ph"/*}"; done
            ;;
        esac
        while IFS= read -r p; do
          [ -n "$p" ] && _tmb_cmd_emit "$dir" "$(tmb_cmd_decode "$p")" "$cwd"
        done < <(_tmb_cmd_stmt_write_paths "$cmd")
        ;;
    esac
  done
  return 0
}

# _tmb_cmd_emit <dir-token> <path> <cwd>
# Prints <path> joined to its statement's dir, once per value its variables
# resolve to; `UNRESOLVED:<var>:<path>` when a variable (or a $( ) /
# backtick, named `$()`) cannot be resolved from this command.
_tmb_cmd_emit() {
  local dir="${1:-}" p="${2:-}" cwd="${3:-}" v base
  case "$p" in
    *'$'*|*'`'*) ;;
    *) _tmb_cmd_join "$dir" "$p" "$cwd"; return 0 ;;
  esac
  _TMB_CMD_PWD=$(_tmb_cmd_dir_path "$dir" "$cwd")
  if _tmb_cmd_expand "$p"; then
    for v in "${_TMB_CMD_EXP[@]}"; do _tmb_cmd_join "$dir" "$v" "$cwd"; done
    return 0
  fi
  case "$p" in
    /*|'~'*|'$'*|'`'*) ;;
    *)
      base=$(_tmb_cmd_join "$dir" . "$cwd")
      [ "$base" = "." ] || p="${base%/}/$p"
      ;;
  esac
  printf 'UNRESOLVED:%s:%s\n' "$_TMB_CMD_UNRES" "$p"
}

# _tmb_cmd_var_set <name> <value-as-written>
# Records every value <value> expands to under <name> in _TMB_CMD_VARS
# (`NAME<TAB>value` lines; every assignment is kept, so a variable assigned
# twice holds both values), or \001 when it cannot be expanded.
_tmb_cmd_var_set() {
  local name="${1:-}" v tab nl
  tab="$(printf '\t')"; nl=$'\n'
  case "$name" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 0 ;; esac
  if _tmb_cmd_expand "${2:-}"; then
    for v in "${_TMB_CMD_EXP[@]}"; do _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}${tab}${v}${nl}"; done
  else
    _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}${tab}"$'\001'"${nl}"
  fi
}

# _tmb_cmd_track_vars <encoded-statement-words…>
# The assignments a statement makes for the statements after it: export /
# declare / typeset / local / readonly NAME=value, a for loop's words (or its
# $( ) source, _tmb_cmd_loop_source), the variable of a `read` fed by a source
# the listing attached, and read / printf -v (values the guard cannot know).
_tmb_cmd_track_vars() {
  local w tab mk="" skip=0
  local -a names=()
  tab="$(printf '\t')"
  case "${1##*/}" in
    export|declare|typeset|local|readonly)
      shift
      for w in "$@"; do
        case "$w" in [A-Za-z_]*=*) _tmb_cmd_var_set "${w%%=*}" "$(tmb_cmd_decode "${w#*=}")" ;; esac
      done
      ;;
    for)
      if [ "${3:-}" = "in" ]; then
        local name="${2:-}"
        shift 3
        case "$#:${1:-}" in
          1:'$'$'\017\020\022'*)
            _tmb_cmd_loop_source "$name" "${1#?$'\017\020'}" || _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}${tab}"$'\001'$'\n'
            return 0
            ;;
        esac
        for w in "$@"; do _tmb_cmd_var_set "$name" "$(tmb_cmd_decode "$w")"; done
      else
        _TMB_CMD_VARS="${_TMB_CMD_VARS}${2:-}${tab}"$'\001'$'\n'
      fi
      ;;
    read)
      shift
      for w in "$@"; do
        if [ "$skip" = 1 ]; then skip=0; continue; fi
        case "$w" in
          $'\022'*) mk="$w" ;;
          -d) skip=1 ;;
          -r|-e) ;;
          -*) mk="!" ;;
          [A-Za-z_]*) names+=("$w") ;;
        esac
      done
      if [ "${#names[@]}" = 1 ] && [ -n "$mk" ] && [ "$mk" != "!" ] && _tmb_cmd_loop_source "${names[0]}" "$mk"; then return 0; fi
      for w in ${names[@]+"${names[@]}"}; do _TMB_CMD_VARS="${_TMB_CMD_VARS}${w}${tab}"$'\001'$'\n'; done
      ;;
    printf)
      [ "${2:-}" = "-v" ] && _TMB_CMD_VARS="${_TMB_CMD_VARS}${3:-}${tab}"$'\001'$'\n'
      ;;
  esac
  return 0
}

# _tmb_cmd_loop_source <name> <source-mark>
# Records the values of a loop variable fed by one path-listing command
# (\022<dir-token>\022<word>\022<word>…, from _tmb_cmd_statements_enc):
# _tmb_cmd_lister_bind of its decoded words. Non-zero, nothing recorded, for
# a source that cannot be bound.
_tmb_cmd_loop_source() {
  local m="${2#$'\022'}" dirtok
  local -a words=()
  dirtok="${m%%$'\022'*}"
  m="${m#"$dirtok"}"
  m=$(tmb_cmd_decode "${m#$'\022'}")
  IFS=$'\022' read -r -a words <<< "$m"
  [ "${#words[@]}" -gt 0 ] || return 1
  _tmb_cmd_lister_bind "${1:-}" "$dirtok" loop "${words[@]}"
}

# _tmb_cmd_lister_bind <name> <dir-token> loop|exec <words…>
# The path-listing model shared by loop variables and by the commands find
# and fd run. Records under <name> in _TMB_CMD_VARS the paths a lister may
# list, when <words> is find, ls, git ls-files, git diff --name-only,
# rg --files or fd and every path it lists from (its literal path arguments,
# else the dir it runs in; git -C composes) is inside the run root
# _TMB_CMD_ROOT. The values are each listed path itself and a glob under it
# (`<path>`, `<path>/*`; `*` for names printed relative to the dir they are
# used in), `<path>/<pattern>` for a -name / --glob pattern that can name
# CLAUDE.md / CODEX.md / CURSOR.md / GEMINI.md, `<path>/*.md` when the path
# lies in a prompt-surface dir, and `<path>/<surface-dir>/*.md`
# (`<path>/CLAUDE.md` for the root's own) when a recursive lister starts
# above a prompt-surface dir of the root whose whole subtree the source does
# not exclude (_tmb_cmd_excl_covers) and its pattern can match there (-iname
# / --iglob case-insensitively), so a write through the variable is judged
# where its listed files lie and reaches the prompt-surface rule.
# `loop`: <words> are the decoded words of a loop source; a lister that runs
# or prints anything but its paths (find -exec / -printf / -fprint / -ls,
# fd -x / --format) cannot be bound.
# `exec`: <words> are the encoded words of a find or fd statement. Its own
# redirects are skipped, and what it runs or writes is appended to the
# caller's _TMB_CMD_ACTS whether or not its paths bind: `x<command>` for
# find -exec / -execdir / -ok / -okdir and fd -x / -X (fd's command gets {}
# appended when it names no placeholder), `d` for find -delete,
# `f<file>` for find -fprint / -fprint0 / -fprintf / -fls; a statement with
# none binds nothing. An -o leaves find's name patterns out, since the
# action may run on what they do not match.
# Non-zero, nothing recorded, when the paths cannot be bound.
_tmb_cmd_lister_bind() {
  local name="${1:-}" dirtok="${2:-}" mode="${3:-loop}" dir="" cmd w k n gdir="" sub="" ok=0 listed=0 bad=0 skip=0 v p bound pat rel d hit v2 m prev
  local -a words=() dec=() args=() raw=() paths=() vals=() exp=() pats=() excl=() prune=()
  shift 3
  words=("$@")
  if [ "$mode" = loop ]; then
    [ -n "${_TMB_CMD_ROOT:-}" ] || return 1
    case "$name" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;; esac
    dec=("${words[@]}")
  else
    m=$(IFS=$'\022'; printf '%s' "${words[*]}")
    IFS=$'\022' read -r -d '' -a dec < <(tmb_cmd_decode "$m") || true
  fi
  case "$dirtok" in
    /*) dir="$dirtok" ;;
    @) dir="${_TMB_CMD_CWD:-}" ;;
    @/*) [ -n "${_TMB_CMD_CWD:-}" ] && dir="${_TMB_CMD_CWD%/}/${dirtok#@/}" ;;
  esac
  [ -n "$dir" ] || [ "$mode" = exec ] || return 1
  for ((k = 1; k < ${#words[@]}; k++)); do
    w="${dec[$k]:-}"
    if [ "$mode" = exec ]; then
      if [ "$skip" = 1 ]; then skip=0; continue; fi
      case "${words[$k]}" in
        '>'|'>>'|'>|'|'<'|'<<<'|'&>'|'&>>'|[0-9]'>'|[0-9]'>>'|[0-9]'<') skip=1; continue ;;
        '>'*|'<'*|'&>'*|[0-9]'>'*|[0-9]'<'*) continue ;;
      esac
      raw+=("${words[$k]}")
    else
      case "$w" in
        '2>/dev/null') continue ;;
        '2>') [ "${words[$((k + 1))]:-}" = /dev/null ] || return 1; k=$((k + 1)); continue ;;
        *'<'*|*'>'*|*'`'*) return 1 ;;
      esac
    fi
    args+=("$w")
  done
  n=${#args[@]}
  k=0
  cmd="${words[0]##*/}"
  case "$mode:$cmd" in
    exec:find|exec:fd|exec:fdfind|loop:*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    find)
      while [ "$k" -lt "$n" ]; do
        case "${args[$k]}" in
          -L) bad=1; k=$((k + 1)) ;;
          -H|-P|-O*) k=$((k + 1)) ;;
          -D) k=$((k + 2)) ;;
          --) k=$((k + 1)); break ;;
          *) break ;;
        esac
      done
      while [ "$k" -lt "$n" ]; do
        case "${args[$k]}" in -*|'('|'!'|,) break ;; esac
        paths+=("${args[$k]}"); k=$((k + 1))
      done
      while [ "$k" -lt "$n" ]; do
        w="${args[$k]}"
        k=$((k + 1))
        case "$w" in
          -exec|-execdir|-ok|-okdir)
            [ "$mode" = exec ] || { bad=1; break; }
            m=""; prev=""
            while [ "$k" -lt "$n" ]; do
              w="${raw[$k]}"
              k=$((k + 1))
              [ "$w" = $'\006' ] && break
              [ "$w" = + ] && [ "$prev" = '{}' ] && break
              m="${m:+$m }$w"; prev="$w"
            done
            [ -z "$m" ] || _TMB_CMD_ACTS+=("x$m")
            ;;
          -delete) [ "$mode" = loop ] || _TMB_CMD_ACTS+=(d) ;;
          -fprint|-fprint0|-fprintf|-fls)
            [ "$mode" = exec ] || { bad=1; break; }
            _TMB_CMD_ACTS+=("f${raw[$k]:-}")
            k=$((k + 1))
            [ "$w" != -fprintf ] || k=$((k + 1))
            ;;
          -printf) [ "$mode" = exec ] || { bad=1; break; }; k=$((k + 1)) ;;
          -ls) [ "$mode" = exec ] || { bad=1; break; } ;;
          -follow) bad=1 ;;
          -name) pats+=("s:${args[$k]:-}"); k=$((k + 1)) ;;
          -iname) pats+=("i:${args[$k]:-}"); k=$((k + 1)) ;;
          -regex|-iregex) pats+=("r:${args[$k]:-}"); k=$((k + 1)) ;;
          -not|'!')
            case "${args[$k]:-}" in
              -path|-wholename) excl+=("P:${args[$((k + 1))]:-}"); k=$((k + 2)) ;;
              -name) excl+=("N:${args[$((k + 1))]:-}"); k=$((k + 2)) ;;
            esac
            ;;
          -path|-wholename|-ipath)
            [ "${args[$((k + 1))]:-}" = -prune ] && prune+=("R:${args[$k]:-}")
            k=$((k + 1))
            ;;
          -o|-or) ok=1 ;;
        esac
      done
      if [ "$ok" = 1 ]; then
        excl=()
        [ "$mode" = loop ] || pats=()
      fi
      excl+=(${prune[@]+"${prune[@]}"})
      ok=0
      [ "${#paths[@]}" -gt 0 ] || paths=(.)
      ;;
    ls)
      for w in ${args[@]+"${args[@]}"}; do
        case "$w" in
          --) ;;
          --*) return 1 ;;
          -*) case "${w#-}" in *[!1AaBCdFfhimpRrSstuUvXx]*) return 1 ;; esac ;;
          *) paths+=("$w") ;;
        esac
      done
      [ "${#paths[@]}" -gt 0 ] || paths=(.)
      listed=1
      ;;
    git)
      gdir="$dir"
      while [ "$k" -lt "$n" ]; do
        case "${args[$k]}" in
          -C)
            p="${args[$((k + 1))]:-}"
            case "$p" in /*) gdir="$p" ;; '') return 1 ;; *) gdir="${gdir%/}/$p" ;; esac
            k=$((k + 2))
            ;;
          -c) k=$((k + 2)) ;;
          -*) k=$((k + 1)) ;;
          *) break ;;
        esac
      done
      sub="${args[$k]:-}"
      k=$((k + 1))
      case "$sub" in ls-files|diff) ;; *) return 1 ;; esac
      for w in ${args[@]+"${args[@]:$k}"}; do
        case "$w" in
          --name-only) ok=1 ;;
          --format*|--full-name|--output*|--src-prefix*|--dst-prefix*) return 1 ;;
          -*) ;;
          ':!'*|':^'*) excl+=("G:${w#:?}") ;;
          ':(exclude)'*) excl+=("G:${w#:(exclude)}") ;;
          :*) return 1 ;;
          *) case "$w" in /*) paths+=("$w") ;; *) paths+=("${gdir%/}/$w") ;; esac ;;
        esac
      done
      [ "$sub" = ls-files ] || [ "$ok" = 1 ] || return 1
      [ "${#paths[@]}" -gt 0 ] || paths=("$gdir")
      vals=('*')
      ;;
    rg)
      while [ "$k" -lt "$n" ]; do
        w="${args[$k]}"
        k=$((k + 1))
        case "$w" in
          --files) ok=1 ;;
          -L|--follow|--path-separator*|--pre|--pre=*) return 1 ;;
          -g|--glob|--iglob)
            case "$w:${args[$k]:-}" in
              --iglob:'!'*) ;;
              *:'!'*) excl+=("Q:${args[$k]#!}") ;;
              --iglob:*) pats+=("i:${args[$k]:-}") ;;
              *) pats+=("s:${args[$k]:-}") ;;
            esac
            k=$((k + 1))
            ;;
          -i|--ignore-case|--glob-case-insensitive) sub=i ;;
          -t|--type|-T|--type-not|--type-add|-j|--threads|-d|--max-depth|--max-filesize|--ignore-file|--sort|--sortr|-E|--encoding) k=$((k + 1)) ;;
          -*) ;;
          *) paths+=("$w") ;;
        esac
      done
      [ "$ok" = 1 ] || return 1
      if [ "$sub" = i ]; then
        for ((k = 0; k < ${#pats[@]}; k++)); do pats[$k]="i:${pats[$k]#?:}"; done
        excl=()
      fi
      ;;
    fd|fdfind)
      while [ "$k" -lt "$n" ]; do
        w="${args[$k]}"
        k=$((k + 1))
        case "$w" in
          -x|--exec|-X|--exec-batch)
            [ "$mode" = exec ] || { bad=1; break; }
            m=""; hit=0
            while [ "$k" -lt "$n" ]; do
              w="${raw[$k]}"
              k=$((k + 1))
              [ "$w" = $'\006' ] && break
              case "$w" in *'{}'*|*'{/}'*|*'{//}'*|*'{.}'*|*'{/.}'*) hit=1 ;; esac
              m="${m:+$m }$w"
            done
            [ "$hit" = 1 ] || m="${m:+$m }{}"
            _TMB_CMD_ACTS+=("x$m")
            ;;
          --format*|--path-separator*|-L|--follow|-l|--list-details|--base-directory*) bad=1 ;;
          --search-path) paths+=("${args[$k]:-}"); k=$((k + 1)) ;;
          -E|--exclude) excl+=("F:${args[$k]:-}"); k=$((k + 1)) ;;
          -e|--extension|-t|--type|-d|--max-depth|--min-depth|--exact-depth|-S|--size|--changed-within|--changed-before|-o|--owner|-j|--threads|--max-results|-c|--color|--ignore-file|--and) k=$((k + 1)) ;;
          -*) ;;
          *) if [ "$ok" = 0 ]; then ok=1; else paths+=("$w"); fi ;;
        esac
      done
      ;;
    *) return 1 ;;
  esac
  [ "$bad" = 0 ] && [ -n "$dir" ] && [ -n "${_TMB_CMD_ROOT:-}" ] || return 1
  [ "$mode" = loop ] || [ "${#_TMB_CMD_ACTS[@]}" -gt 0 ] || return 1
  case "$name" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;; esac
  [ -n "$_TMB_CMD_ROOTC" ] || _TMB_CMD_ROOTC=$(tmb_path_canonical "$_TMB_CMD_ROOT")
  bound="$_TMB_CMD_ROOTC"
  if [ "$cmd" = git ]; then
    bound=$(tmb_path_canonical "$gdir")
    case "$bound/" in "${_TMB_CMD_ROOTC%/}/"*) ;; *) return 1 ;; esac
  fi
  [ "${#paths[@]}" -gt 0 ] || paths=(.)
  for p in "${paths[@]}"; do
    _tmb_cmd_expand "$p" || return 1
    exp=("${_TMB_CMD_EXP[@]}")
    for v in "${exp[@]}"; do
      case "$v" in \~) v="${HOME:-}" ;; \~/*) v="${HOME:-}/${v#\~/}" ;; esac
      case "$v" in /*) w="$v" ;; *) w="${dir%/}/$v" ;; esac
      case "$w" in *[*?[]*) w="${w%%[*?[]*}"; w="${w%/*}"; [ -n "$w" ] || w=/ ;; esac
      w=$(tmb_path_canonical "$w")
      case "$w/" in "${bound%/}/"*) ;; *) return 1 ;; esac
      w="${w#"${_TMB_CMD_ROOTC%/}"}"
      if tmb_is_prompt_surface_path "${_TMB_CMD_ROOTC%/}${w%/}/x.md" "$_TMB_CMD_ROOTC"; then
        if [ "$cmd" = git ]; then vals+=("${p%/}/*.md"); else vals+=("${v%/}/*.md"); fi
      elif [ "$cmd" != ls ]; then
        rel="${w#/}"
        for d in agents skills commands templates rules .claude/agents CLAUDE.md; do
          case "$d" in
            CLAUDE.md) [ -z "$rel" ] && [ -f "${_TMB_CMD_ROOTC%/}/$d" ] || continue ;;
            *) [ -d "${_TMB_CMD_ROOTC%/}/$d" ] || continue
               [ -z "$rel" ] || [ "${d#"$rel"/}" != "$d" ] || continue ;;
          esac
          hit=0
          for pat in ${excl[@]+"${excl[@]}"}; do
            if _tmb_cmd_excl_covers "$pat" "$d" "${d#"$rel"/}" "$v"; then hit=1; fi
          done
          [ "$hit" = 0 ] || continue
          if [ "${#pats[@]}" -gt 0 ]; then
            hit=0
            for pat in "${pats[@]}"; do
              for v2 in x.md SKILL.md CLAUDE.md; do
                [ "$d" = CLAUDE.md ] && [ "$v2" != CLAUDE.md ] && continue
                if _tmb_cmd_pat_matches "$pat" "$v2"; then hit=1; fi
              done
            done
            [ "$hit" = 1 ] || continue
          fi
          case "$d" in CLAUDE.md) w="$d" ;; *) w="${d#"$rel"/}/*.md" ;; esac
          if [ "$cmd" = git ]; then vals+=("${p%/}/$w"); else vals+=("${v%/}/$w"); fi
        done
      fi
      [ "$cmd" = git ] && continue
      vals+=("$v" "${v%/}/*")
      for pat in ${pats[@]+"${pats[@]}"}; do
        case "${pat#?:}" in ''|*/*|'!'*) continue ;; esac
        for v2 in CLAUDE.md CODEX.md CURSOR.md GEMINI.md; do
          if _tmb_cmd_pat_matches "$pat" "$v2"; then vals+=("${v%/}/${pat#?:}"); break; fi
        done
      done
    done
  done
  [ "$listed" = 1 ] && vals+=('*')
  m=$'\n'
  for v in "${vals[@]}"; do
    case "$m" in *$'\n'"$v"$'\n'*) ;; *) m="$m$v"$'\n' ;; esac
  done
  m="${m#$'\n'}"
  k=0
  while IFS= read -r v; do k=$((k + 1)); done <<< "${m%$'\n'}"
  [ "$k" -le 16 ] || return 1
  while IFS= read -r v; do _TMB_CMD_VARS="${_TMB_CMD_VARS}${name}"$'\t'"${v}"$'\n'; done <<< "${m%$'\n'}"
  return 0
}

# _tmb_cmd_pat_matches <kind:pattern> <name>
# Whether a lister's name pattern can match <name>: `s:` a glob, `i:` a glob
# compared case-insensitively, `r:` a regex (assumed to match).
_tmb_cmd_pat_matches() {
  local pat="${1#?:}" rc=1 was=""
  case "$1" in
    r:*) return 0 ;;
    i:*)
      shopt -q nocasematch && was=1
      shopt -s nocasematch
      # shellcheck disable=SC2254 # the pattern is the source's own glob
      case "$2" in $pat) rc=0 ;; esac
      [ -n "$was" ] || shopt -u nocasematch
      return "$rc"
      ;;
  esac
  # shellcheck disable=SC2254 # the pattern is the source's own glob
  case "$2" in $pat) return 0 ;; esac
  return 1
}

# _tmb_cmd_excl_covers <kind:pattern> <surface> <surface-below-listing> <listed-path>
# Whether a lister's exclusion leaves out the whole prompt-surface subtree
# <surface> (a dir of the root, or CLAUDE.md): find -not -path '<dir>/*' or
# '<dir>/**' and -path '<dir>' -prune (<dir> as */name, ./sub, <listed>/sub or
# <root>/sub), -not -name CLAUDE.md, a :!sub git pathspec, fd -E sub and rg
# --glob '!sub' / '!sub/**'. A deeper path covers nothing.
_tmb_cmd_excl_covers() {
  local e="${1#?:}" d="$2" sub="$3" l="${4%/}" b="${2##*/}" r
  case "$1" in
    N:*) [ "$d" = CLAUDE.md ] && [ "$e" = CLAUDE.md ]; return ;;
    P:*)
      case "$e" in
        */\*\*) r="${e%/\*\*}" ;;
        */\*) r="${e%/\*}" ;;
        *) [ "$d" = CLAUDE.md ] || return 1; r="$e" ;;
      esac
      ;;
    R:*) r="$e" ;;
    G:*)
      r="${e%/}"; r="${r%/\*\*}"; r="${r%/\*}"
      [ "$r" = "$d" ]; return
      ;;
    F:*|Q:*)
      r="${e%/}"; r="${r%/\*\*}"
      [ "$r" = "$d" ] || [ "$r" = "**/$b" ] || { [ "$r" = "$b" ] && [ "${r#*/}" = "$r" ]; }; return
      ;;
    *) return 1 ;;
  esac
  [ "$r" = "*/$b" ] || [ "$r" = "**/$b" ] || [ "$r" = "$l/$sub" ] || [ "$r" = "./$sub" ] || \
    [ "$r" = "${_TMB_CMD_ROOT%/}/$d" ] || [ "$r" = "${_TMB_CMD_ROOTC%/}/$d" ]
}

# _tmb_cmd_var_get <name>
# The recorded values of <name>, one per line; non-zero when never assigned.
_tmb_cmd_var_get() {
  local line found=1 tab
  tab="$(printf '\t')"
  while IFS= read -r line; do
    case "$line" in "${1:-}${tab}"*) printf '%s\n' "${line#*"$tab"}"; found=0 ;; esac
  done <<< "${_TMB_CMD_VARS:-}"
  return "$found"
}

# _tmb_cmd_dir_path <dir-token> <cwd>
# The absolute dir a statement runs in; empty when unknown.
_tmb_cmd_dir_path() {
  case "${1:-}" in
    /*) printf '%s' "$1" ;;
    @) printf '%s' "${2:-}" ;;
    @/*) [ -n "${2:-}" ] && printf '%s/%s' "${2%/}" "${1#@/}" ;;
  esac
  return 0
}

# _tmb_cmd_env_var <name>
# The value of a variable the command did not set: $PWD is the statement's
# own dir (_TMB_CMD_PWD), $OLDPWD the dir before the most recent cd in this
# command (_TMB_CMD_OLDTOK; unknown without one); HOME, TMPDIR,
# CLAUDE_PROJECT_DIR and TMB_MODEL_CACHE_DIR (with its default) are the host's.
_tmb_cmd_env_var() {
  local v=""
  case "${1:-}" in
    PWD) v="${_TMB_CMD_PWD:-}" ;;
    OLDPWD) v=$(_tmb_cmd_dir_path "${_TMB_CMD_OLDTOK:--}" "${_TMB_CMD_CWD:-}") ;;
    HOME) v="${HOME:-}" ;;
    TMPDIR) v="${TMPDIR:-}" ;;
    CLAUDE_PROJECT_DIR) v="${CLAUDE_PROJECT_DIR:-}" ;;
    TMB_MODEL_CACHE_DIR) v="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-}}"; [ -n "$v" ] || v="${HOME:+$HOME/.cache/huggingface}" ;;
  esac
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

# _tmb_cmd_expand <word>
# Expands $VAR, ${VAR}, ${VAR:-def} / ${VAR-def} / ${VAR:=def} / ${VAR=def}
# and ${VAR%suffix} / ${VAR%%suffix} (a literal suffix: letters, digits, . _ -)
# from _TMB_CMD_VARS (else the default, else _tmb_cmd_env_var) into the
# array _TMB_CMD_EXP (every combination of values, at most 16). Non-zero,
# with the variable in _TMB_CMD_UNRES, when one cannot be resolved; a $( ) or
# backtick is `$()`.
_tmb_cmd_expand() {
  local rest="${1:-}" lit name op def vals v a k cut
  local -a acc=("") nxt
  _TMB_CMD_EXP=()
  _TMB_CMD_UNRES=""
  while :; do
    case "$rest" in
      *'$'*|*'`'*) ;;
      *) for ((k = 0; k < ${#acc[@]}; k++)); do acc[$k]="${acc[$k]}${rest}"; done; break ;;
    esac
    lit="${rest%%[\$\`]*}"
    rest="${rest#"$lit"}"
    for ((k = 0; k < ${#acc[@]}; k++)); do acc[$k]="${acc[$k]}${lit}"; done
    op=""; def=""; cut=""
    case "$rest" in
      '`'*|'$('*) _TMB_CMD_UNRES='$()'; return 1 ;;
      '${'*)
        a="${rest#??}"
        case "$a" in *'}'*) ;; *) _TMB_CMD_UNRES="$rest"; return 1 ;; esac
        rest="${a#*\}}"
        a="${a%%\}*}"
        name="${a%%[!A-Za-z0-9_]*}"
        op="${a#"$name"}"
        case "$name" in ''|[0-9]*) _TMB_CMD_UNRES="\${$a}"; return 1 ;; esac
        case "$op" in
          '') ;;
          :-*|:=*) def="${op#??}"; op=def ;;
          -*|=*) def="${op#?}"; op=def ;;
          %*)
            cut="${op#%}"; cut="${cut#%}"; op=""
            case "$cut" in ''|*[!A-Za-z0-9._-]*) _TMB_CMD_UNRES="$name"; return 1 ;; esac
            ;;
          *) _TMB_CMD_UNRES="$name"; return 1 ;;
        esac
        ;;
      '$'[A-Za-z_]*)
        a="${rest#?}"
        name="${a%%[!A-Za-z0-9_]*}"
        rest="${a#"$name"}"
        ;;
      '$'[0-9@*#?\$!-]*) _TMB_CMD_UNRES="${rest:0:2}"; return 1 ;;
      *)
        for ((k = 0; k < ${#acc[@]}; k++)); do acc[$k]="${acc[$k]}\$"; done
        rest="${rest#?}"
        continue
        ;;
    esac
    if vals=$(_tmb_cmd_var_get "$name"); then
      case "$vals" in *$'\001'*) _TMB_CMD_UNRES="$name"; return 1 ;; esac
    elif [ "$op" = "def" ]; then
      case "$def" in *'$'*|*'`'*) _TMB_CMD_UNRES="$name"; return 1 ;; esac
      vals="$def"
    elif ! vals=$(_tmb_cmd_env_var "$name"); then
      _TMB_CMD_UNRES="$name"
      return 1
    fi
    nxt=()
    for a in "${acc[@]}"; do
      while IFS= read -r v; do nxt+=("$a${v%"$cut"}"); done <<< "$vals"
    done
    if [ "${#nxt[@]}" -gt 16 ]; then _TMB_CMD_UNRES="$name"; return 1; fi
    acc=("${nxt[@]}")
  done
  _TMB_CMD_EXP=("${acc[@]}")
  return 0
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
  while [ ! -d "$dir" ]; do
    case "$dir" in */*) dir="${dir%/*}"; [ -n "$dir" ] || dir=/ ;; *) return 0 ;; esac
  done
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
