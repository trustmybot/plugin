#!/usr/bin/env bash
# Unit tests: scripts/hooks/lib/cmd-analysis.sh — tmb_cmd_strip_literals,
# tmb_cmd_write_targets, tmb_cmd_write_paths, tmb_cmd_heredoc_bodies,
# tmb_is_prompt_surface_path,
# tmb_path_canonical, tmb_cmd_statements,
# tmb_gh_mutation and the role / harness-turn / quoted-span helpers.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$PLUGIN_ROOT/scripts/hooks/lib/cmd-analysis.sh"

targets() { tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$1")" | tr '\n' ',' ; }

test_case "tmb_cmd_strip_literals drops heredoc bodies and neutralizes quoted operators"
assert_eq "cat <<EOF > out.txt|echo done" \
  "$(tmb_cmd_strip_literals "$(printf '%s\n' "cat <<'EOF' > out.txt" 'x > /tmp/z' 'EOF' 'echo done')" | paste -sd'|' -)" \
  "the heredoc body is gone, the operator line stays"
assert_eq "echo __/tmp/z" "$(tmb_cmd_strip_literals 'echo "> /tmp/z"')" "a quoted redirect is one word"
assert_eq "echo a___b >/tmp/q" "$(tmb_cmd_strip_literals "echo 'a > b' >/tmp/q")" "single quotes too; the real redirect stays"
assert_eq 'mkdir $TMB_MODEL_CACHE_DIR/x' "$(tmb_cmd_strip_literals 'mkdir "$TMB_MODEL_CACHE_DIR"/x')" "quotes removed around a variable"
assert_eq "grep x f " "$(tmb_cmd_strip_literals 'grep x f # > /tmp/c')" "comments dropped"
assert_eq "cat <<END" "$(tmb_cmd_strip_literals "$(printf 'cat <<-END\n\tbody > /tmp/z\n\tEND')")" "<<- strips leading tabs before the delimiter"

test_case "tmb_cmd_write_targets finds every write position"
# shellcheck disable=SC2088 # the unexpanded word is what the scanner must report
TILDE_TARGET='~/.claude/y'
assert_eq "${TILDE_TARGET}," "$(targets "echo hi > ${TILDE_TARGET}")" "redirect"
assert_eq "/dev/null,log.txt," "$(targets 'ls 2>/dev/null >>log.txt')" "fd redirect and append"
assert_eq "" "$(targets 'echo x 2>&1 >&2')" "fd duplications are not paths"
assert_eq "/tmp/both," "$(targets 'cmd &>/tmp/both')" "&> redirect"
assert_eq "/tmp/t1,out," "$(targets 'echo x | tee -a /tmp/t1 out')" "tee arguments"
assert_eq "/tmp/dest,/var/x," "$(targets 'cp a b /tmp/dest && mv -t /var/x f')" "cp destination, mv -t"
assert_eq "/opt/x," "$(targets 'FOO=1 sudo install -d /opt/x')" "assignments and sudo skipped; install -d"
assert_eq "" "$(targets 'rsync -a src/ host:/remote')" "a remote rsync destination is not local"
assert_eq "/tmp/foo*,a_b," "$(targets 'rm -rf /tmp/foo* ; touch "a b"')" "rm and touch arguments"
assert_eq "../wt," "$(targets 'git -C repo worktree add -b feat ../wt base')" "git worktree add path"
assert_eq "/tmp/clone," "$(targets 'git clone --depth 1 https://x/y.git /tmp/clone')" "git clone directory"
assert_eq "" "$(targets 'git clone https://x/y.git')" "git clone into cwd names no path"
assert_eq "" "$(targets 'cat ~/.claude.json; grep -r x /etc')" "reads name no write position"

test_case "tmb_cmd_write_targets treats every link as a write"
assert_eq "root/link,/outside," "$(targets 'ln -s /outside root/link')" "ln -s destination and absolute source"
assert_eq "build/y,build/../x,build/y/../x," "$(targets 'ln -sf ../x build/y')" "a relative ln -s source read against the link's directory"
assert_eq "b,a," "$(targets 'ln a b')" "hard link destination and source"
assert_eq "dir,dir/../a,/b," "$(targets 'ln -s -t dir ../a /b')" "ln -t directory and sources"
assert_eq "p,/etc/passwd," "$(targets 'link /etc/passwd p')" "link destination and source"
assert_eq "/o/f,here," "$(targets 'cp -s /o/f here')" "cp -s source and destination"
assert_eq "/o,d," "$(targets 'cp -al /o d')" "cp -l source and destination"
assert_eq "b," "$(targets 'cp a b')" "a plain cp names only its destination"

test_case "tmb_cmd_write_targets: dd of=, truncate, git mv"
assert_eq "out.img," "$(targets 'dd if=in.img of=out.img bs=1M')" "dd of="
assert_eq "a,b," "$(targets 'truncate -s 0 a b')" "truncate files, not the size"
assert_eq "d/x.md," "$(targets 'git -C r mv -f x.md d/x.md')" "git mv destination"

wpaths() { tmb_cmd_write_paths "$1" "${2:-}" | paste -sd',' - ; }

test_case "tmb_cmd_write_paths: every write shape (GH 1272)"
assert_eq "/w/a.md" "$(wpaths 'echo x >| a.md' /w)" ">|"
assert_eq "/w/a.md" "$(wpaths 'exec 3> a.md' /w)" "exec N>"
assert_eq "/w/a.md" "$(wpaths "$(printf "cat > a.md <<'EOF'\nx > /w/no.md\nEOF")" /w)" "heredoc: the redirect, not the body"
assert_eq "/w/a.md,/w/b.md" "$(wpaths 'echo x | tee -a a.md b.md' /w)" "tee -a"
assert_eq "/w/x.md,/w/y.md" "$(wpaths "sed -i -e 's/a/b/' x.md y.md" /w)" "sed -i: every file operand"
assert_eq "/w/f.md" "$(wpaths "sed -i '/x/r skills/a/SKILL.md' f.md" /w)" "sed -i: a path inside the script is data"
assert_eq "/w/a.md,/w/b.md" "$(wpaths "perl -pi -e 's/a/b/' a.md b.md" /w)" "perl -i"
assert_eq "/w/of.md" "$(wpaths 'dd if=/w/if.md of=of.md' /w)" "dd of="
assert_eq "/w/t.md" "$(wpaths 'truncate --size 0 t.md' /w)" "truncate"
assert_eq "/w/d.md" "$(wpaths 'install -m 644 s.md d.md' /w)" "install"
assert_eq "/w/dst" "$(wpaths 'rsync -av src/ dst/' /w)" "rsync destination"
assert_eq "/w/d.md,/w/s.md" "$(wpaths 'mv s.md d.md' /w)" "mv: destination and the removed source"
assert_eq "/w/r/d.md,/w/r/s.md" "$(wpaths 'git -C r mv s.md d.md' /w)" "git mv under git -C"
assert_eq "/w/a.md" "$(wpaths "python3 -c \"open('a.md','w').write('x')\"" /w)" "python open w"
assert_eq "/w/a.md" "$(wpaths "python3 -c \"open('a.md', mode='x')\"" /w)" "python open mode=x"
assert_eq "/w/s/a.md" "$(wpaths "python3 -c \"from pathlib import Path; Path('s/a.md').write_text('x')\"" /w)" "python write_text"
assert_eq "/w/s/a.md" "$(wpaths "python3 -c \"import sys; open(sys.argv[1],'w')\" s/a.md" /w)" "python writing its argv operand"
assert_eq "/w/o.md" "$(wpaths "python3 -c \"open('o.md','w').write(open('s/a.md').read())\"" /w)" "python read input is not written"
assert_eq "" "$(wpaths "python3 -c \"print(open('s/a.md').read())\"" /w)" "python read only"
assert_eq "/w/s/a.md" "$(wpaths "node -e \"require('fs').writeFileSync('s/a.md','x')\"" /w)" "node writeFileSync"
assert_eq "/w/s/a.md" "$(wpaths "node -e \"require('fs').appendFileSync('s/a.md','x')\"" /w)" "node appendFileSync"
assert_eq "/w/o.md" "$(wpaths "node -e \"const f=require('fs'); f.writeFileSync('o.md', f.readFileSync('s/a.md'))\"" /w)" "node read input is not written"
assert_eq "" "$(wpaths "node -e \"require('fs').readFileSync('s/a.md')\"" /w)" "node read only"
assert_eq "/w/s/a.md" "$(wpaths "perl -e 'open(my \$f, \">\", \"s/a.md\")'" /w)" "perl -e open >"

test_case "tmb_cmd_write_paths: per statement, in the statement's own dir"
assert_eq "/w/skills/a.md" "$(wpaths 'cd skills && echo x > a.md' /w)" "cd applies"
assert_eq "/w/skills/a.md" "$(wpaths 'cd src && echo x > ../skills/a.md' /w)" ".. normalized"
assert_eq "/w/a.md,/w/b.md" "$(wpaths '(cd sub && true) ; echo > a.md; echo > b.md' /w)" "a subshell cd does not leak"
assert_eq "/w/s/a.md" "$(wpaths "bash -c 'echo x > s/a.md'" /w)" "bash -c body"
assert_eq "skills/a.md" "$(wpaths 'cd "$X" && echo x > skills/a.md' /w)" "an unknown dir keeps the path as written"
assert_eq "skills/a.md" "$(wpaths 'cd skills && echo x > a.md')" "no cwd: relative to the caller's dir"
assert_eq "" "$(wpaths 'cat skills/a.md; grep -r x skills/' /w)" "reads write nothing"

bodies() { tmb_cmd_heredoc_bodies "$1" | tr '\t\037' '#|' | paste -sd';' - ; }

test_case "tmb_cmd_heredoc_bodies: every form, with its delimiter and statement (GH 1279)"
assert_eq "1#EOF#a > b|c" "$(bodies "$(printf '%s\n' 'cat <<EOF' 'a > b' 'c' 'EOF')")" "<<EOF"
assert_eq "1#EOF#a|b" "$(bodies "$(printf 'cat <<-EOF\n\ta\n\tb\n\tEOF')")" "<<-EOF strips leading tabs"
assert_eq "1#EOF#\$x" "$(bodies "$(printf '%s\n' "cat <<'EOF'" '$x' 'EOF')")" "<<'EOF'"
assert_eq "1#EOF#y" "$(bodies "$(printf '%s\n' 'cat <<"EOF"' 'y' 'EOF')")" "<<\"EOF\""
assert_eq "1#A#one;1#B#two" "$(bodies "$(printf '%s\n' 'cat <<A 3<<B' 'one' 'A' 'two' 'B')")" "two heredocs in one statement"
assert_eq "2#EOF#in" "$(bodies "$(printf '%s\n' 'echo $(cat <<EOF' 'in' 'EOF' ')')")" "inside \$( ): the statement that carries it"
assert_eq "1#X#x;2#Y#y" "$(bodies "$(printf '%s\n' 'cat <<X && cat <<Y' 'x' 'X' 'y' 'Y')")" "one per statement"
assert_eq "" "$(bodies 'cat <<< "here string"')" "a here-string is not a heredoc"
assert_eq "" "$(bodies 'echo "<<EOF"')" "quoted text is not a heredoc"

heredoc() { printf '%s\n' "$1 <<'EOF'" "$2" 'EOF'; }

test_case "tmb_cmd_write_paths: programs fed to an interpreter through a heredoc (GH 1279)"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "open('/etc/x','w').write('y')")" /w)" "python3 -"
assert_eq "/w/o.txt" "$(wpaths "$(heredoc 'python' "from pathlib import Path; Path('o.txt').write_text('y')")" /w)" "python, no script"
assert_eq "/tmp/x" "$(wpaths "$(heredoc 'node' "require('fs').writeFileSync('/tmp/x','y')")" /w)" "node"
assert_eq "/w/d" "$(wpaths "$(heredoc 'node -' "require('fs').mkdirSync('d/', {recursive: true})")" /w)" "node - mkdirSync"
assert_eq "/w/p.txt" "$(wpaths "$(heredoc 'perl' 'open(my $f, ">", "p.txt");')" /w)" "perl"
assert_eq "/w/r.txt" "$(wpaths "$(heredoc 'ruby -' "File.write('r.txt', 'x')")" /w)" "ruby -"
assert_eq "/tmp/s,/w/sub/t" "$(wpaths "$(printf '%s\n' "sh <<'EOF'" 'echo x > /tmp/s' 'cd sub && touch t' 'EOF')" /w)" "sh: redirects and write commands, in the program's own dirs"
assert_eq "/w/sub/a" "$(wpaths "$(heredoc 'cd sub && bash -s' 'echo x > a')" /w)" "bash -s, from its statement's dir"
assert_eq "/w/a.txt,/w/b.txt" "$(wpaths "$(printf '%s\n' "python3 - <<A 3<<B" "open('a.txt','w')" 'A' "open('b.txt','w')" 'B')" /w)" "every heredoc of the statement"
assert_eq "/w/t.txt" "$(wpaths "$(printf 'python3 - <<-EOF\n\topen("t.txt","w")\n\tEOF')" /w)" "<<-EOF"
assert_eq "/o/sub" "$(wpaths "$(printf '%s\n' 'x=$(python3 - <<"EOF"' "open('/o/sub','w')" 'EOF' ')')" /w)" "inside \$( )"
assert_eq "/yes" "$(wpaths "$(printf '%s\n' "cat <<'X' && python3 <<'Y'" "open('/no','w')" 'X' "open('/yes','w')" 'Y')" /w)" "only the interpreter's own heredoc"
assert_eq "/hs" "$(wpaths 'python3 - <<< "open(\"/hs\",\"w\")"' /w)" "a here-string program"
assert_eq "" "$(wpaths "$(heredoc 'python3 -' "print(open('/etc/hosts').read())")" /w)" "a program that only reads"
assert_eq "/w/f" "$(wpaths "$(heredoc 'cat > f' "open('/etc/passwd','w')")" /w)" "a data heredoc: only the redirect"
assert_eq "" "$(wpaths "$(heredoc 'python3 script.py' "open('/etc/passwd','w')")" /w)" "a script is given: stdin is data"
assert_eq "" "$(wpaths "$(heredoc 'python3 -c pass' "open('/etc/passwd','w')")" /w)" "python -c: stdin is data"
assert_eq "" "$(wpaths "$(heredoc 'bash script.sh' 'echo x > /etc/passwd')" /w)" "bash script: stdin is data"

test_case "tmb_cmd_write_paths: variables set in the same command (GH 1279)"
assert_eq "/etc/x" "$(wpaths 'OUT=/etc/x; cat > "$OUT"' /w)" "a prior statement"
assert_eq "/w/o/f" "$(wpaths 'D=o && touch "${D}/f"' /w)" "\${VAR}, relative to the statement's dir"
assert_eq "/e/y" "$(wpaths 'export OUT=/e/y && tee "$OUT"' /w)" "export"
assert_eq "/x/y/z" "$(wpaths 'A=/x; B="$A/y"; cat > "$B/z"' /w)" "one level of nesting"
assert_eq "/tmp/d" "$(wpaths 'cat > "${NOPE:-/tmp}/d"' /w)" "\${VAR:-default}: the default branch"
assert_eq "/k/d" "$(wpaths 'V=/k; cat > "${V:-/tmp}/d"' /w)" "\${VAR:-default}: the set value"
assert_eq "/w/a.txt,/w/b.txt" "$(wpaths 'for f in a.txt b.txt; do sed -i s/x/y/ "$f"; done' /w)" "a for loop's words"
assert_eq "/a,/b" "$(wpaths 'P=/a; true || P=/b; touch "$P"' /w)" "every value a variable may hold"
assert_eq "$HOME/f" "$(wpaths 'touch $HOME/f' /w)" "\$HOME from the host"
assert_eq "$HOME/.bashrc" "$(wpaths 'HOME=/inside cat > "$HOME/.bashrc"' /w)" "a HOME= prefix does not reach its own command's words"
assert_eq "/w/out" "$(wpaths 'echo x > "$PWD/out"' /w)" "\$PWD is the cwd"
assert_eq "/w/x/f" "$(wpaths 'cd x && echo y > "$PWD/f"' /w)" "\$PWD after a cd"
assert_eq "/w/s/f" "$(wpaths 'cd s; D="$PWD/f"; cd /; echo y > "$D"' /w)" "\$PWD in an assignment is that statement's dir"
assert_eq 'UNRESOLVED:PWD:$PWD/f' "$(wpaths 'cd "$X" && echo y > "$PWD/f"' /w)" "\$PWD after cd \$X is unknown"
assert_eq 'UNRESOLVED:OUT:$OUT' "$(wpaths 'OUT=/etc/x cat > "$OUT"' /w)" "a VAR=value prefix does not reach its own command's words (the shell expands them first)"
assert_eq 'UNRESOLVED:OUT:$OUT' "$(wpaths 'OUT="$(mktemp)"; cat > "$OUT"' /w)" "a \$( ) value"
assert_eq 'UNRESOLVED:OUT:$OUT' "$(wpaths 'OUT=`mktemp`; cat > $OUT' /w)" "a backtick value"
assert_eq 'UNRESOLVED:UNKNOWN:$UNKNOWN/f' "$(wpaths 'cat > "$UNKNOWN/f"' /w)" "never set"
assert_eq 'UNRESOLVED:UNKNOWN:/w/sub/$UNKNOWN' "$(wpaths 'cat > sub/$UNKNOWN' /w)" "a relative target keeps its dir"
assert_eq 'UNRESOLVED:$():$(mktemp)' "$(wpaths 'cat > "$(mktemp)"' /w)" "a \$( ) target"
assert_eq 'UNRESOLVED:f:$f' "$(wpaths 'while read -r f; do touch "$f"; done < list' /w)" "read"
assert_eq "/w/out" "$(wpaths 'echo $(date) > out' /w)" "a \$( ) outside the target is not a target"

test_case "tmb_cmd_write_paths: \$OLDPWD is the dir before the command's last cd (GH 1324)"
assert_eq "/w/f" "$(wpaths 'cd x && echo y > "$OLDPWD/f"' /w)" "after cd x, \$OLDPWD is the cwd"
assert_eq "/w/x/f" "$(wpaths 'cd x; cd /r && echo y > "${OLDPWD}/f"' /w)" "the dir before the most recent cd"
assert_eq "/w/f" "$(wpaths 'cd x && D="$OLDPWD/f" && cd / && echo y > "$D"' /w)" "in an assignment, that statement's \$OLDPWD"
assert_eq 'UNRESOLVED:OLDPWD:$OLDPWD/f' "$(wpaths 'echo y > "$OLDPWD/f"' /w)" "without a cd it is unknown"
assert_eq "/w/x/a,/r/b" "$(wpaths 'cd x && cd /r && cd - && echo y > "$PWD/a" && echo z > "$OLDPWD/b"' /w)" "cd - swaps \$PWD and \$OLDPWD"
assert_eq 'UNRESOLVED:OLDPWD:$OLDPWD/f' "$(wpaths 'cd x; echo y > "$OLDPWD/f"' /w)" "a cd not chained with && may have failed"
assert_eq 'UNRESOLVED:OLDPWD:$OLDPWD/f' "$(wpaths 'cd x && true; echo y > "$OLDPWD/f"' /w)" "outside the cd's && chain"
assert_eq "/w/f" "$(wpaths '(cd x; cd y); cd z && echo y > "$OLDPWD/f"' /w)" "a subshell's cd does not leak"

LR=$(cd "$(mktemp -d)" && pwd -P)
mkdir -p "$LR/tests" "$LR/a"
lpaths() { tmb_cmd_write_paths "$1" "${2:-$LR}" "" "$LR" | sed "s|$LR|@|g" | paste -sd',' - ; }

test_case "tmb_cmd_write_paths: loop variables bounded by an in-root source (GH 1324)"
assert_eq "@/tests/*.sh" "$(lpaths "for f in $LR/tests/*.sh; do sed -i 's/a/b/' \"\$f\"; done")" "an in-root glob"
assert_eq "@/tests/*.sh" "$(lpaths "for f in tests/*.sh; do sed -i 's/a/b/' \"\$f\"; done")" "a relative glob"
assert_eq "@,@/*" "$(lpaths "for f in \$(find $LR -name '*.sh'); do sed -i 's/a/b/' \"\$f\"; done")" "\$(find <root> -name …): the start point and everything under it"
assert_eq "@/*" "$(lpaths "for f in \$(git -C $LR ls-files); do sed -i 's/a/b/' \"\$f\"; done")" "\$(git -C <root> ls-files)"
assert_eq "@/*" "$(lpaths "for f in \$(git diff --name-only HEAD~1); do sed -i s/a/b/ \"\$f\"; done")" "\$(git diff --name-only)"
assert_eq "@/tests,@/tests/*" "$(lpaths "for f in \$(rg --files $LR/tests); do printf x >> \"\$f\"; done")" "\$(rg --files <root>/tests)"
assert_eq "@/a,@/a/*" "$(lpaths "for f in \$(fd -e sh . a); do printf x >> \"\$f\"; done")" "\$(fd <pattern> <path>)"
assert_eq "@,@/*,@/*.md" "$(lpaths "while read f; do sed -i s/a/b/ \"\$f\"; done < <(find $LR -name '*.md')")" "while read … done < <(find <root> …)"
assert_eq "@/..bak,@/*.bak,@/*.md.bak" "$(lpaths "find . -name '*.md' | while IFS= read -r f; do cp \"\$f\" \"\$f.bak\"; done")" "find … | while read; the \$f.bak suffix form"
assert_eq "@/tests.out,@/tests/*.out" "$(lpaths "for f in \$(find tests -name '*.sh'); do echo > \"\${f%.sh}.out\"; done")" "the \${f%.sh}.out suffix form"
assert_eq "@/a/x,@/a/*/x" "$(lpaths "for f in \$(find a -type d 2>/dev/null); do echo > \"\$f/x\"; done" | tr ',' '\n' | grep -v /dev/null | paste -sd',' -)" "a \$f/… suffix; 2>/dev/null on the source"
assert_eq "@/tests/*,@/tests/*/*" "$(lpaths "for d in $LR/tests/*; do for f in \$(find \"\$d\" -name x); do rm \"\$f\"; done; done")" "nested loops compose"
assert_eq "/etc,/etc/*" "$(lpaths "for f in \$(find . -name x); do (cd /etc && rm \"\$f\"); done")" "relative names are judged where they are used"

test_case "tmb_cmd_write_paths: a listed path itself is bound, so .. and suffixes leave the root (GH 1324)"
assert_eq "$(dirname "$LR")/f,@/f" "$(lpaths "for d in \$(find $LR -type d); do echo x > \"\$d/../f\"; done")" "\$d/../f from find <root>"
assert_eq "@.bak,@/*.bak" "$(lpaths "for f in \$(find $LR -maxdepth 0); do cp x \"\$f.bak\"; done")" "\$f.bak of the start point"
assert_eq "$(dirname "$LR"),@" "$(lpaths "for f in \$(find $LR -name '*'); do rm -rf \"\$f/..\"; done")" "\$f/.. of the start point"

test_case "tmb_cmd_write_paths: a bound source under a prompt-surface dir reaches the surface rule (GH 1324)"
mkdir -p "$LR/agents" "$LR/skills"
assert_contains "$(lpaths "for f in \$(find $LR/agents -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")" "@/agents/*.md" "find <root>/agents"
assert_contains "$(lpaths "for f in \$(find agents -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")" "@/agents/*.md" "relative find agents"
assert_contains "$(lpaths "find $LR/agents -name '*.md' | while read f; do printf x >> \"\$f\"; done")" "@/agents/*.md" "find <root>/agents | while read"
assert_contains "$(lpaths "for f in \$(git ls-files skills); do sed -i s/a/b/ \"\$f\"; done")" "@/skills/*.md" "git ls-files skills"
assert_contains "$(lpaths "for f in \$(find . -name CLAUDE.md); do sed -i s/a/b/ \"\$f\"; done")" "@/CLAUDE.md" "a -name pattern naming CLAUDE.md"

test_case "tmb_cmd_write_paths: a recursive listing above the root's prompt-surface dirs reaches them (GH 1324)"
touch "$LR/CLAUDE.md"
assert_eq "@/agents/*.md,@/skills/*.md,@/CLAUDE.md,@,@/*,@/*.md" "$(lpaths "for f in \$(find $LR -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")" "find <root> -name '*.md'"
assert_eq "@,@/*" "$(lpaths "for f in \$(find $LR -name '*.sh'); do sed -i s/a/b/ \"\$f\"; done")" "a pattern that cannot match a surface file"
assert_eq "@/tests,@/tests/*,@/tests/*.md" "$(lpaths "for f in \$(find $LR/tests -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")" "a listing below the surface dirs"
assert_eq "@,@/*,@/*.md" "$(lpaths "for f in \$(find $LR -name '*.md' -not -path '*/agents/*' -not -path '*/skills/*' -not -path '*/commands/*' -not -path '*/templates/*' -not -name CLAUDE.md); do sed -i s/a/b/ \"\$f\"; done")" "-not -path exclusions"
assert_eq "@,@/*,@/*.md" "$(lpaths "for f in \$(find . -path ./agents -prune -o -path ./skills -prune -o -path ./CLAUDE.md -prune -o -name '*.md' -print); do sed -i s/a/b/ \"\$f\"; done")" "-path … -prune exclusions"
assert_contains "$(lpaths "for f in \$(find $LR -name '*.md' -o -not -path '*/agents/*'); do sed -i s/a/b/ \"\$f\"; done")" "@/agents/*.md" "a -not -path in an -o branch excludes nothing"
assert_eq "@/*,@/agents/*.md,@/skills/*.md,@/CLAUDE.md" "$(lpaths "for f in \$(git ls-files); do sed -i s/a/b/ \"\$f\"; done")" "git ls-files at the root"
assert_eq "@/*" "$(lpaths "for f in \$(git ls-files tests); do sed -i s/a/b/ \"\$f\"; done")" "git ls-files tests"
assert_eq "@/*" "$(lpaths "for f in \$(git ls-files ':!agents' ':!skills' ':!CLAUDE.md'); do sed -i s/a/b/ \"\$f\"; done")" ":! pathspec exclusions"
assert_eq "@,@/*" "$(lpaths "for f in \$(rg --files --glob '!agents/**' --glob '!skills/**' -g '!CLAUDE.md'); do sed -i s/a/b/ \"\$f\"; done")" "--glob '!…' exclusions"
rm -f "$LR/CLAUDE.md"

test_case "tmb_cmd_write_paths: case-insensitive patterns and partial exclusions still reach the surface (GH 1324)"
mkdir -p "$LR/commands"
for src in "find $LR -iname '*.MD'" "find $LR -iname 'skill.md'" "rg --files $LR --iglob '*.MD'" "rg --files $LR -g '*.MD' --glob-case-insensitive" \
  "find $LR -name '*.md' ! -path '*/agents'" "find $LR -name '*.md' -not -name 'agents*'" "find $LR -name '*.md' -not -path '*/agents/zzz/*'" \
  "find $LR -path '*/agents/zzz' -prune -o -name '*.md' -print" "git ls-files ':!agents/zzz'" "fd -E agents/zzz md $LR"; do
  out=$(lpaths "for f in \$($src); do sed -i s/a/b/ \"\$f\"; done")
  case "$src" in *skill.md*) want="@/skills/*.md" ;; *) want="@/agents/*.md" ;; esac
  assert_contains "$out" "$want" "$src"
done
for src in "find $LR -name '*.md' -not -path '*/agents/*' -not -path '*/skills/**' -not -path '*/commands/*'" \
  "find $LR -path '*/agents' -prune -o -path $LR/skills -prune -o -path '*/commands' -prune -o -name '*.md' -print" \
  "git ls-files ':!agents' ':^skills' ':(exclude)commands'" "fd -E agents -E skills -E commands md $LR" \
  "rg --files $LR --glob '!agents/**' --glob '!skills' --glob '!commands/**'"; do
  out=$(lpaths "for f in \$($src); do sed -i s/a/b/ \"\$f\"; done")
  for d in agents skills commands; do assert_not_contains "$out" "@/$d/*.md" "$src leaves out $d"; done
done

test_case "tmb_cmd_write_paths: loop variables from any other source stay unresolvable (GH 1324)"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find /etc -name x); do rm \"\$f\"; done")" "\$(find /etc …)"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find -- /etc -name x); do rm \"\$f\"; done")" "\$(find -- /etc …): -- ends the options"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find .. -name x); do rm \"\$f\"; done")" "\$(find ..) climbs out of the root"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(cat list.txt); do rm \"\$f\"; done")" "\$(cat list.txt)"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(curl -s https://x); do rm \"\$f\"; done")" "\$(curl …)"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find . -printf '/etc/%f'); do rm \"\$f\"; done")" "find -printf writes its own text"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find . | grep x); do rm \"\$f\"; done")" "a pipeline source"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find .) /etc/x; do rm \"\$f\"; done")" "more words after the \$( )"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(git -C /etc ls-files); do rm \"\$f\"; done")" "git -C outside the root"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "for f in \$(find \$SRC); do rm \"\$f\"; done")" "a variable source"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths 'while read -r f; do touch "$f"; done < list')" "read from a file"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "cat list | while read f; do rm \"\$f\"; done")" "cat list | while read"
assert_eq 'UNRESOLVED:f:$f' "$(lpaths "find /etc | while read f; do rm \"\$f\"; done")" "find /etc | while read"
assert_eq 'UNRESOLVED:f:$f' "$(tmb_cmd_write_paths "for f in \$(find $LR); do rm \"\$f\"; done" "$LR")" "no root given"

test_case "tmb_cmd_write_paths: find -exec / -delete, fd -x and xargs write the listed paths (GH 1338)"
assert_eq "@,@/*" "$(lpaths "find $LR -name x -exec rm {} \\;")" "find <root> -name x -exec rm {} \\;"
for cmd in "find $LR -delete" "find $LR -print0 | xargs -0 rm" "fd -e md -x sed -i s/a/b/ {}" \
  "find $LR -exec sed -i s/a/b/ {} +" "find $LR -execdir rm {} ';'" "find $LR -ok rm {} \\;" "fd . $LR -X rm"; do
  out=",$(lpaths "$cmd"),"
  assert_contains "$out" ",@," "$cmd: the start path"
  assert_contains "$out" ",@/*," "$cmd: everything under it"
done
assert_eq "@/a.bak,@/a/*.bak,@/a,@/a/*" "$(lpaths "find a -name x -exec mv {} {}.bak \\;")" "mv {} {}.bak: destination and the removed source"
assert_eq "@/a.bak,@/a/*.bak" "$(lpaths "find a | xargs -I X cp X X.bak")" "xargs -I X"
assert_eq "@/a,@/a/*" "$(lpaths "fd x a -x rm")" "fd -x with no placeholder appends {}"
assert_eq "@/out.txt,@/f2,@/f3" "$(lpaths "find a -fprint out.txt -fprintf f2 '%p' -fls f3")" "-fprint / -fprintf / -fls write their file"
assert_contains "$(lpaths "find agents -name '*.md' -exec sed -i s/a/b/ {} \\;")" "@/agents/*.md" "find agents -exec: the prompt-surface rule applies"
assert_contains "$(lpaths "find $LR -name '*.sh' -o -exec sed -i s/a/b/ {} \\;")" "@/agents/*.md" "an -o: the action runs on what -name does not match"

test_case "tmb_cmd_write_paths: read-only find and fd forms write nothing (GH 1338)"
for cmd in "find $LR -name '*.sh' -print" "find a -type f -newer x -ls" "find a -printf '%p'" "find a -exec grep -l x {} \\;" \
  "find /etc -name x" "fd -e md . a" "find a | xargs grep x" "find a -executable -print"; do
  assert_eq "" "$(lpaths "$cmd")" "$cmd"
done

test_case "tmb_cmd_write_paths: find, fd and xargs over an unbound source stay unresolvable (GH 1338)"
for cmd in "find / -exec rm {} \\;" "find \$HOME -delete" "find .. -delete" "find \$SRC -exec rm {} +" "find -L $LR -exec rm {} \\;"; do
  assert_eq 'UNRESOLVED:find_path:${find_path}' "$(lpaths "$cmd")" "$cmd"
done
assert_eq 'UNRESOLVED:fd_path:${fd_path}' "$(lpaths "fd x /etc -x rm")" "fd x /etc -x rm"
for cmd in "find / -print0 | xargs -0 rm" "cat list | xargs rm" "xargs rm < list" "find a -print0 | xargs -0 -a list rm" "find a | grep x | xargs rm"; do
  assert_eq 'UNRESOLVED:xargs_arg:${xargs_arg}' "$(lpaths "$cmd")" "$cmd"
done
assert_eq 'UNRESOLVED:find_path:${find_path}' "$(tmb_cmd_write_paths "find $LR -delete" "$LR")" "no root given"

test_case "tmb_cmd_write_shapes lists the shapes once"
assert_contains "$(tmb_cmd_write_shapes)" "sed -i" "sed -i"
assert_contains "$(tmb_cmd_write_shapes)" "dd of=" "dd of="
assert_contains "$(tmb_cmd_write_shapes)" "git mv" "git mv"

test_case "tmb_is_prompt_surface_path matches at a path boundary"
for p in agents/swe.md skills/x/SKILL.md skills/x/references/r.md commands/scan.md templates/agents/a.md \
  rules/style.md .claude/agents/local.md CLAUDE.md sub/CODEX.md /w/.claude/worktrees/t/agents/a.md; do
  if tmb_is_prompt_surface_path "$p"; then _pass; else _fail "$p should be a prompt surface"; fi
done
for p in myskills/x/SKILL.md myagents/a.md src/agents.md skills/x/helper.sh agents/openai.yaml NOTCLAUDE.md docs/x.md; do
  if tmb_is_prompt_surface_path "$p"; then _fail "$p is not a prompt surface"; else _pass; fi
done

test_case "tmb_path_canonical"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REAL=$(cd -P "$TMP" && pwd -P)
mkdir -p "$TMP/a"
ln -s "$TMP/a" "$TMP/link"
assert_eq "$REAL/a/new/file" "$(tmb_path_canonical "$TMP/link/new/file")" "symlinked ancestor resolved; missing tail kept"
assert_eq "$REAL/a" "$(tmb_path_canonical "$TMP/a/b/../.")" ". and .. resolved"
assert_eq "/" "$(tmb_path_canonical /)" "root"
mkdir -p "$TMP/outside/deep" "$TMP/root/a"
ln -s "$TMP/outside/deep" "$TMP/root/link"
ln -s ../outside/deep "$TMP/root/rel"
assert_eq "$REAL/outside/x" "$(tmb_path_canonical "$TMP/root/link/../x")" "a symlink is followed before .. applies"
assert_eq "$REAL/outside/deep/f" "$(tmb_path_canonical "$TMP/root/rel/f")" "a relative symlink resolves against its directory"
assert_eq "$REAL/root/b" "$(tmb_path_canonical "$TMP/root/a/../b")" "a legitimate .. without a symlink"
assert_eq "$REAL/root/a/new" "$(tmb_path_canonical "$TMP/root/missing/../a/new")" ".. collapses inside the missing tail"
assert_eq "$REAL/outside/y" "$(tmb_path_canonical "$TMP/root/missing/../link/../y")" "a link reached after the tail empties is still followed"

stmts() { tmb_cmd_statements "$1" "${2:-$PLAIN}" | tr '\t' '#' | paste -sd'|' - ; }
PLAIN="$TMP/plain"
mkdir -p "$PLAIN"

test_case "tmb_cmd_statements splits the skeleton into statements"
assert_eq "$PLAIN#git add .|$PLAIN#git commit -m x" "$(stmts 'git add . && git commit -m x')" "&&"
assert_eq "$PLAIN#a|$PLAIN#b|$PLAIN#c|$PLAIN#d" "$(stmts 'a; b || c & d')" "; || &"
assert_eq "$PLAIN#git log|$PLAIN#head -1" "$(stmts 'git log | head -1')" "pipe"
assert_eq "$PLAIN#a|$PLAIN#b" "$(stmts "$(printf 'a\nb')")" "newline"
assert_eq "$PLAIN#echo|$PLAIN#git status|$PLAIN#git log" "$(stmts 'echo $(git status) `git log`')" "\$( ) and backticks"
assert_eq "$PLAIN#true|$PLAIN#git status|$PLAIN#ls 2>&1|$PLAIN#grep x &>/dev/null" "$(stmts 'if true; then git status; fi; ls 2>&1 | grep x &>/dev/null')" "keywords dropped; fd redirects are not separators"
assert_eq "$PLAIN#git commit" "$(stmts 'FOO=1 sudo git commit')" "assignments and wrappers dropped"

test_case "tmb_cmd_statements treats heredoc bodies and quoted text as data"
HEREDOC_CMD=$(printf '%s\n' "cat > notes.md <<'EOF'" 'git commit -m x' 'gh pr merge 1' 'EOF')
assert_eq "$PLAIN#cat > notes.md <<EOF" "$(stmts "$HEREDOC_CMD")" "heredoc body is not a statement"
assert_eq "$PLAIN#python3 -c print_'gh_pr_merge_1'_" "$(stmts "python3 -c \"print('gh pr merge 1')\"")" "a python program is one word"
assert_eq "$PLAIN#echo git_commit_-m_x" "$(stmts 'echo "git commit -m x"')" "a quoted command is one word"
assert_contains "$(stmts 'bash -c "cd /w && git status"; eval "git log"')" "/w#git status" "bash -c body statement carries its cd"
assert_contains "$(stmts 'bash -c "cd /w && git status"; eval "git log"')" "$PLAIN#git log" "eval body statement"

test_case "tmb_cmd_statements effective dir"
assert_eq "/r/wt#git -C /r/wt commit" "$(stmts 'git -C /r/wt commit')" "git -C"
assert_eq "/r/wt#git -C wt commit" "$(stmts 'cd /r && git -C wt commit' | sed 's/^[^|]*|//')" "git -C relative to a cd"
assert_eq "/a#git commit" "$(stmts 'cd /a && git commit' | sed 's/^[^|]*|//')" "leading cd"
assert_eq "$PLAIN#git status|$PLAIN#cd /b|/b#git commit" "$(stmts 'git status; cd /b; git commit')" "mid-chain cd applies to later statements only"
assert_eq "$PLAIN/sub#git commit" "$(stmts 'cd sub && git commit' | sed 's/^[^|]*|//')" "relative cd joins the cwd"
assert_eq "/a#git log" "$(stmts 'cd /a && (cd /b && git x) && git log' | awk -F'|' '{print $NF}')" "a subshell cd does not leak"
assert_eq "-#git commit" "$(stmts 'cd "$WT" && git commit' | sed 's/^[^|]*|//')" "a variable path is unknown"
assert_eq "-#git commit" "$(stmts 'git commit' "$TMP/missing")" "no cwd → unknown"

REPO="$TMP/repo"
git init -q -b main "$REPO"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
assert_eq "$REPO#git commit" "$(stmts 'git commit' "$REPO")" "cwd in a repo without worktrees is the dir"
git -C "$REPO" worktree add -q -b feat/x "$REPO/.claude/worktrees/x"
assert_eq "?#git commit" "$(stmts 'git commit' "$REPO")" "cwd in a repo with worktrees is ambiguous"
assert_eq "$REPO/.claude/worktrees/x#git commit" "$(stmts "cd $REPO/.claude/worktrees/x && git commit" "$REPO" | sed 's/^[^|]*|//')" "explicit cd resolves the ambiguity"
assert_eq "$(cd -P "$REPO" && pwd)" "$(tmb_stmt_repo_root '?' "$REPO")" "an ambiguous dir still names its repo"
assert_eq "$(cd -P "$REPO" && pwd)" "$(tmb_stmt_repo_root "$REPO/.claude/worktrees/x")" "a worktree's repo is the main checkout"
assert_eq "" "$(tmb_stmt_repo_root -)" "unknown dir names no repo"

test_case "tmb_git_subcommand / tmb_git_commit_message"
assert_eq "push origin main" "$(tmb_git_subcommand 'git -C /x -c a=b --no-pager push origin main')" "global options dropped"
assert_eq "" "$(tmb_git_subcommand 'gh pr create')" "not git"
assert_eq "✨ feat(x): a b" "$(tmb_git_commit_message 'cd /w && git commit -m "✨ feat(x): a b" -m body')" "first -m from argv"
assert_eq "fix: y" "$(tmb_git_commit_message "git commit -am 'fix: y'")" "-am"
assert_eq "" "$(tmb_git_commit_message "$HEREDOC_CMD")" "a heredoc mentioning git commit has no message"
assert_eq "" "$(tmb_git_commit_message 'git commit -m "$(cat <<EOF
feat: x
EOF
)"')" "a \$( ) message is not judged"

test_case "tmb_gh_mutation: gh api implied POST shapes"
ghm() { tmb_gh_mutation "$(tmb_cmd_strip_literals "$1")"; }
assert_eq "POST" "$(ghm "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'")" "graphql -f query is a POST"
assert_eq "POST" "$(ghm "gh api graphql -f query='query { viewer { login } }'")" "a graphql read travels as a POST too"
assert_eq "POST" "$(ghm 'gh api graphql -F query=@q.graphql -F owner=o')" "graphql -F query=@file"
assert_eq "POST" "$(ghm 'gh api graphql --input body.json')" "graphql --input"
assert_eq "POST" "$(ghm 'gh api graphql --raw-field=query=x')" "graphql --raw-field="
assert_eq "" "$(ghm 'gh api graphql -X GET -f query=x')" "an explicit GET wins"
assert_eq "" "$(ghm 'gh api repos/o/r/pulls')" "a bare api path is a GET"

test_case "tmb_cmd_statements drops every heredoc form, also inside \$( ) (GH 1281)"
assert_eq "$PLAIN#cat <<EOF" "$(stmts "$(printf '%s\n' 'cat <<EOF' 'git push origin dev' 'EOF')")" "<<EOF"
assert_eq "$PLAIN#cat <<EOF" "$(stmts "$(printf 'cat <<-EOF\n\tgit push origin dev\n\tEOF')")" "<<-EOF"
assert_eq "$PLAIN#cat <<EOF" "$(stmts "$(printf '%s\n' "cat <<'EOF'" 'a && git push origin dev' 'EOF')")" "<<'EOF'"
assert_eq "$PLAIN#cat <<EOF" "$(stmts "$(printf '%s\n' 'cat <<"EOF"' 'a; git push origin dev' 'EOF')")" "<<\"EOF\""
assert_eq "$PLAIN#cat <<A <<B|$PLAIN#git status" "$(stmts "$(printf '%s\n' 'cat <<A <<B' 'git push' 'A' 'git commit -m x' 'B' 'git status')")" "two heredocs on one line, then a real statement"
assert_eq "$PLAIN#echo|$PLAIN#cat <<EOF" "$(stmts "$(printf '%s\n' 'echo $(cat <<EOF' 'git push origin dev' 'EOF' ')')")" "heredoc inside an unquoted \$( )"
COMMENT_CMD=$(printf '%s\n' "gh issue comment 1 --body \"\$(cat <<'EOF'" 'run: `cd x && git commit --amend` then rebase' "it's \"done\"" 'EOF' ')"')
assert_eq "$PLAIN#cat <<EOF|$PLAIN#gh issue comment 1 --body \$_cat___EOF__" "$(stmts "$COMMENT_CMD")" "a quoted \$( ) body runs; its heredoc text does not"
assert_eq "$PLAIN#gh pr merge 1|$PLAIN#echo \$_gh_pr_merge_1_" "$(stmts 'echo "$(gh pr merge 1)"')" "a quoted \$( ) is a statement and a word of its outer statement"
assert_eq "$PLAIN#date|$PLAIN#gh api \$_date_ -X POST x" "$(stmts 'gh api "`date`" -X POST x')" "a quoted backtick runs; the outer statement keeps its later words"
assert_eq "$PLAIN#echo it's_a____git_push" "$(stmts "echo \$'it\\'s a && git push'")" "\$'…' is a quoted span"

test_case "tmb_gh_mutation judges command-position words only (GH 1281)"
ghs() { tmb_cmd_statements "$1" "$PLAIN" | while IFS="$(printf '\t')" read -r _d s; do tmb_gh_mutation "$s"; done; }
assert_eq "" "$(ghs "$(printf '%s\n' "cat > x.test.ts <<'EOF'" ' gh issue close 1' 'EOF')")" "heredoc test fixture"
assert_eq "" "$(ghs "printf 'gh pr merge' > notes.txt")" "printf of a quoted string"
assert_eq "" "$(ghs 'echo "gh pr merge 1"')" "echo of a quoted string"
assert_eq "" "$(ghs 'echo gh pr merge 1')" "an operand of a data command"
assert_eq "" "$(ghs 'grep -rn gh pr merge docs')" "a grep pattern"
assert_eq "pr merge" "$(ghs 'gh pr merge 1')" "plain"
assert_eq "pr merge" "$(ghs 'timeout 5 gh pr merge 1')" "timeout"
assert_eq "pr merge" "$(ghs 'echo 1 | xargs gh pr merge')" "xargs"
assert_eq "issue close" "$(ghs '/usr/bin/gh issue close 2')" "absolute path"
assert_eq "POST" "$(ghs 'GH_TOKEN=x gh api -X POST repos/o/r/issues')" "VAR=value prefix"
assert_eq "" "$(ghs 'gh issue view 1')" "read-only"
assert_eq "mr merge" "$(ghs 'glab mr merge 3')" "glab"
assert_eq "pr merge" "$(ghs 'echo "$(gh pr merge 1)"')" "inside a quoted \$( )"
assert_eq "POST" "$(ghs 'gh api "$(echo repos/o/r/issues)" -f title=x')" "an outer api call keeps its fields after a quoted \$( )"
assert_eq "pr close" "$(ghs 'sudo -u bob nice -n 5 caffeinate -i gh pr close 2')" "chained wrappers with options"
assert_eq "pr merge" "$(ghs 'sudo -u git gh pr merge 1')" "an option value named like a data command is not argv0"
assert_eq "pr merge" "$(ghs 'env -u cat gh pr merge 1')" "env -u cat"
assert_eq "pr merge" "$(ghs 'git bisect run gh pr merge 1')" "git bisect run executes its words"
assert_eq "pr merge" "$(ghs 'git submodule foreach gh pr merge 1')" "git submodule foreach executes its words"
assert_eq "pr merge" "$(ghs "git rebase -x 'gh pr merge 1' main")" "git rebase -x executes its command"
assert_eq "pr merge" "$(ghs 'git rebase --exec="gh pr merge 1" main')" "git rebase --exec="
assert_eq "pr merge" "$(ghs 'git submodule --quiet foreach gh pr merge 1')" "submodule options before foreach"
assert_eq "pr merge" "$(ghs 'git submodule -q foreach gh pr merge 1')" "submodule -q foreach"
assert_eq "pr merge" "$(ghs "git rebase -ix 'gh pr merge 1' main")" "-x in a short-option cluster"
assert_eq "pr merge" "$(ghs "git rebase -kx 'gh pr merge 1' main")" "-kx"
assert_eq "pr merge" "$(ghs "git rebase --exe='gh pr merge 1' main")" "--exe= prefix of --exec"
assert_eq "pr merge" "$(ghs "git rebase -i --exe 'gh pr merge 1' main")" "--exe <cmd>"
assert_eq "pr merge" "$(ghs 'git rebase -x "echo hi && gh pr merge 1" main')" "a compound -x command after a data command"
assert_eq "pr merge" "$(ghs "git submodule foreach 'echo x; gh pr merge 1'")" "a compound foreach command after a data command"
assert_eq "" "$(ghs "git rebase -i --autosquash main")" "a rebase without -x runs nothing"
assert_eq "" "$(ghs 'git log --grep="gh pr merge"')" "other git subcommands only read their words"

test_case "tmb_agent_role reads identity only"
assert_eq "swe" "$(tmb_agent_role '{"agent_type":"tmb:swe","cwd":"/r"}')" "prefixed agent_type"
assert_eq "bro" "$(tmb_agent_role '{"cwd":"/r/.claude/worktrees/x"}')" "no agent_type is the main thread, whatever the cwd"

test_case "tmb_is_harness_turn"
for framing in '<task-notification><task-id>1</task-id>' '[SYSTEM NOTIFICATION - NOT USER INPUT]' \
  'Another Claude session sent a message: hi' '[Subagent hand-back] report' \
  '<agent-message from="swe">done</agent-message>' '<cross-session-message from="x">y</cross-session-message>'; do
  if tmb_is_harness_turn "$framing"; then _pass; else _fail "not a harness turn: $framing"; fi
done
if tmb_is_harness_turn "port the parser to Rust"; then _fail "a Human prompt is not a harness turn"; else _pass; fi

test_case "tmb_strip_quoted_spans"
assert_eq "see   and   then" "$(tmb_strip_quoted_spans 'see `git push` and "push it" then')" "backticks and double quotes"
assert_eq "x   y" "$(tmb_strip_quoted_spans "x 'still open' y")" "single quotes"
assert_eq "let's keep users' words" "$(tmb_strip_quoted_spans "let's keep users' words")" "apostrophes are not quotes"
assert_eq 'an "unclosed quote' "$(tmb_strip_quoted_spans 'an "unclosed quote')" "an unclosed quote stays"

summarize
