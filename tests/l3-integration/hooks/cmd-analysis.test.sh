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
assert_eq 'UNRESOLVED:X:$X/skills/a.md' "$(wpaths 'cd "$X" && echo x > skills/a.md' /w)" "a relative path after cd \$X is judged under \$X (GH 1595)"
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

test_case "tmb_cmd_write_paths: a -C / --prefix dir and a mutating git's tree are written (GH 1508)"
assert_eq "/b" "$(wpaths 'git -C /b commit -am x' /w)" "git -C commit"
assert_eq "/b" "$(wpaths 'git -C /b checkout main' /w)" "git -C checkout"
assert_eq "/b" "$(wpaths 'git -C /b stash' /w)" "git -C stash"
assert_eq "/b" "$(wpaths 'tar -xzf a.tgz -C /b' /w)" "tar -C"
assert_eq "/b" "$(wpaths 'tar --directory=/b -xf a.tar' /w)" "tar --directory="
assert_eq "/b" "$(wpaths 'make -C /b test' /w)" "make -C"
assert_eq "/b" "$(wpaths 'env -C /b make' /w)" "env -C"
assert_eq "/b" "$(wpaths 'npm --prefix /b install' /w)" "npm --prefix"
assert_eq "/b" "$(wpaths 'npm --prefix=/b ci' /w)" "npm --prefix="
assert_eq "/w" "$(wpaths 'git commit -am x' /w)" "git commit: the statement's own dir"
assert_eq "/w" "$(wpaths 'git reset --hard' /w)" "git reset --hard"
assert_eq "/w" "$(wpaths 'git clean -fd' /w)" "git clean -fd"
assert_eq "/w" "$(wpaths 'git checkout -- f' /w)" "git checkout -- f"
assert_eq "/w" "$(wpaths 'git stash' /w)" "git stash"
assert_eq "/w/sub" "$(wpaths 'cd sub && git add -A' /w)" "a mutating git after cd"
assert_eq "/w/sub" "$(wpaths 'git -C sub restore f' /w)" "a relative git -C"
assert_eq "/b/t" "$(wpaths 'git -C /b --work-tree=t checkout .' /w)" "--work-tree under git -C"
assert_eq "/w/a,/w/a/b" "$(wpaths 'tar -C a -C b -xf t.tar' /w)" "tar -C chain composes"
assert_eq "/b,/b/f" "$(wpaths "env -C /b sed -i 's/a/b/' f" /w)" "env -C: the dir and the command's paths under it"
assert_eq "/b,/b/x" "$(wpaths 'env -C /b git -C x commit' /w)" "env -C then git -C"
assert_eq "/b" "$(wpaths "find . -name '*.md' -exec git -C /b add {} +" /w)" "a mutating git run by find -exec"
assert_eq "/b" "$(wpaths 'git worktree remove /b' /w)" "git worktree remove"
assert_eq 'UNRESOLVED:Y:$Y' "$(wpaths 'git -C "$Y" commit -m x' /w)" "a git -C behind a variable"
assert_eq "" "$(wpaths 'git -C /a status && git -C /b log && git -C /b diff' /w)" "status, log, diff write nothing"
assert_eq "" "$(wpaths 'git stash list; git fetch; git push; git rev-parse HEAD; git ls-files; git branch --list; git worktree list' /w)" "read-only git and push"
assert_eq "" "$(wpaths 'git -C /b apply --check p.diff' /w)" "git apply --check"
assert_eq "/b" "$(wpaths 'git -C /b apply p.diff' /w)" "git apply"

test_case "tmb_cmd_write_paths: a program writes its write calls' own path arguments (GH 1510)"
assert_eq "/w/out.txt" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' 'import json' "cfg = json.load(open('/etc/tmb-cg/config.json', encoding='utf-8'))" "open('out.txt','w').write(str(cfg))")")" /w)" "a file opened to read is not written"
assert_eq "/w/out.txt" "$(wpaths "$(heredoc 'python3 -' "import os; open('out.txt','w').write(str(os.listdir('/usr/share/doc')))")" /w)" "os.listdir reads"
assert_eq "/w/out.txt" "$(wpaths "$(heredoc 'python3 -' "import sys; sys.path.insert(0, '/opt/tmb-cg/lib'); open('out.txt','w')")" /w)" "sys.path.insert names no write"
assert_eq "/w/out.txt" "$(wpaths "python3 -c \"open('out.txt','w').write(open('/etc/hosts').read())\"" /w)" "a one-liner"
assert_eq "/w/scripts/x.sh" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "s = open('scripts/x.sh').read()" "s = s.replace('/^[\\\\/~\$]/', '/x/')" "open('scripts/x.sh','w').write(s)")")" /w)" "regex text with / in a program is data"
assert_eq "/etc/tmb-cg/x" "$(wpaths "$(heredoc 'python3 -' "open('/etc/tmb-cg/x', 'w')")" /w)" "an outside open w"
assert_eq "/etc/tmb-cg/x" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = '/etc/tmb-cg/x'" "open(p, 'w').write('y')")")" /w)" "a write to a variable: every literal not only read"
assert_eq "/etc/tmb-cg" "$(wpaths "$(heredoc 'python3 -' "import shutil; shutil.copy('in.txt', '/etc/tmb-cg/')")" /w)" "shutil.copy: the destination"
assert_eq "/w/a.txt,/w/b.txt,/w/d" "$(wpaths "$(heredoc 'python3 -' "import os; os.rename('a.txt', 'b.txt'); os.makedirs('d', exist_ok=True)")" /w)" "os.rename: both paths; makedirs"
assert_eq "/etc/x,/etc/z" "$(wpaths "$(heredoc 'python3 -' "from pathlib import Path; p = Path('/etc/x'); p.write_text(open('/etc/y').read()); print('/etc/z')")" /w)" "an unknown receiver: every literal not only read, a printed one too"
assert_eq "/etc/x,/etc/z" "$(wpaths "$(heredoc 'python3 -' "from pathlib import Path; p = Path('/etc/x'); p.write_text(open('/etc/y').read()); q = '/etc/z'")" /w)" "an unknown receiver: an assigned literal counts"
assert_eq "/w/notes.txt" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "s = open('notes.txt').read()" "s = s.replace('x', '/user/own')" "open('notes.txt', 'w').write(s)")")" /w)" "GH 1550: a literal write path; replace text is data"
assert_eq "/w/notes.txt" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import re" "s = re.sub('a', '/user/own', open('notes.txt').read())" "open('notes.txt', 'w').write(s)")")" /w)" "GH 1550: a literal write path; re.sub text is data"
assert_eq "/w/notes.txt" "$(wpaths "$(heredoc 'node -' "const fs = require('fs'); fs.writeFileSync('notes.txt', fs.readFileSync('notes.txt', 'utf8').replace('a', '/user/own'));")" /w)" "GH 1550: node, a literal write path"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'notes.txt'" "s = open(p).read()" "s = s.replace('x', '/user/own')" "open(p, 'w').write(s)")")" /w)" "/user/own" "GH 1550: a write through a variable counts the replace text"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import re" "p = 'notes.txt'" "s = re.sub('a', '/user/own', open(p).read())" "open(p, 'w').write(s)")")" /w)" "/user/own" "GH 1550: a write through a variable counts the re.sub text"
assert_contains "$(wpaths "$(heredoc 'node -' "const fs = require('fs'); const p = 'notes.txt'; const s = fs.readFileSync(p, 'utf8').replace('a', '/user/own'); fs.writeFileSync(p, s);")" /w)" "/user/own" "GH 1550: node, a write through a const counts the replace text"
assert_eq "/outside/f" "$(wpaths "echo x > /outside/f" /w)" "GH 1550: a redirect stays a target"

test_case "tmb_cmd_write_paths: a path inside a larger string literal is not a literal of its own (GH 1567)"
assert_eq "/w/a.sh" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p='a.sh'" "new='''" 'x "$P" "/onboard"' "'''" "open(p,'w').write(new)")")" /w)" "a triple-quoted string quoting /onboard"
assert_eq "/w/a.txt" "$(wpaths "$(heredoc 'node -' "$(printf '%s\n' "const fs = require('fs'); const p = 'a.txt';" 'const s = `x "/abs" y`;' "fs.writeFileSync(p, s);")")" /w)" "node: a template literal quoting /abs"
assert_eq "/w/a.txt" "$(wpaths "$(heredoc 'perl' "$(printf '%s\n' 'my $p = "a.txt";' "my \$s = 'one" 'two "/abs" three' "';" 'open(my $f, ">", $p); print $f $s;')")" /w)" "perl: a multi-line string quoting /abs"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'a.txt'" 'q = "/abs/x"' "open(p, 'w').write('1')")")" /w)" "/abs/x" "a standalone literal with a write through a variable counts"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'a.txt'" "open(p, 'w').write('1')" "s = 'see \"/abs/y\" here")")" /w)" "/abs/y" "a program that does not parse counts quoted sub-tokens"

test_case "tmb_cmd_write_paths: a variable rebound unseen still counts every literal (GH 1550)"
assert_contains "$(wpaths "python3 -c \"import cProfile; p='notes.txt'; cProfile.run('p=%r' % '/etc/evil'); open(p,'w').write('1')\"" /w)" "/etc/evil" "python -c: cProfile.run rebinds the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import cProfile" "p = 'notes.txt'" "cProfile.run('p=%r' % '/etc/evil')" "open(p, 'w').write('1')")")" /w)" "/etc/evil" "cProfile.run rebinds the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import trace" "p = 'notes.txt'" "trace.Trace(count=0, trace=0).run('p=%r' % '/etc/evil')" "open(p, 'w').write('1')")")" /w)" "/etc/evil" "trace.Trace().run rebinds the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import pdb" "p = 'notes.txt'" "pdb.run('p=%r' % '/etc/evil')" "open(p, 'w').write('1')")")" /w)" "/etc/evil" "pdb.run rebinds the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import gc" "p = 'notes.txt'" "for o in gc.get_objects():" "    if isinstance(o, dict) and o.get('p') == 'notes.txt': o['p'] = '/etc/evil'" "open(p, 'w').write('1')")")" /w)" "/etc/evil" "a gc.get_objects() dict write rebinds the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import pickle" "p = 'notes.txt'" "globals().update(pickle.loads(pickle.dumps({'p': '/etc/evil'})))" "open(p, 'w').write('1')")")" /w)" "/etc/evil" "a pickle round trip rebinds the variable"

test_case "tmb_cmd_write_paths: a path routed through a text call is still written (GH 1550)"
assert_contains "$(wpaths "python3 -c \"p='x'.replace('x','/etc/evil'); open(p,'w').write('1')\"" /w)" "/etc/evil" "python -c: a variable assigned from replace()"
assert_contains "$(wpaths "$(heredoc 'python3 -' "p='x'.replace('x','/etc/evil'); open(p,'w').write('1')")" /w)" "/etc/evil" "python heredoc: a variable assigned from replace()"
assert_contains "$(wpaths "python3 -c \"open('x'.replace('x','/etc/evil'),'w')\"" /w)" "/etc/evil" "replace() as open's path"
assert_contains "$(wpaths "node -e \"const p='x'.replace('x','/etc/evil'); require('fs').writeFileSync(p,'1')\"" /w)" "/etc/evil" "node: a const assigned from replace()"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'notes.txt'" "p = p.replace('notes.txt', '/etc/evil')" "open(p, 'w')")")" /w)" "/etc/evil" "a variable bound twice is not resolved"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'notes.txt'" "for p in ['/etc/evil']: open(p, 'w')")")" /w)" "/etc/evil" "a loop rebinding the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'notes.txt'" "def f(p): open(p, 'w')" "f('/etc/evil')")")" /w)" "/etc/evil" "a parameter shadowing the variable"
assert_contains "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = 'notes.txt'" "globals()['p'] = '/etc/evil'" "open(p, 'w')")")" /w)" "/etc/evil" "a write through globals()"
assert_contains "$(wpaths "$(heredoc 'node -' "const p = 'notes.txt'; try { throw '/etc/evil' } catch (p) { require('fs').writeFileSync(p, '1') }")" /w)" "/etc/evil" "node: a catch binding shadowing the const"
assert_contains "$(wpaths "$(heredoc 'node -' "const p = 'notes.txt'; ({ m(p) { require('fs').writeFileSync(p, '1') } }).m('/etc/evil');")" /w)" "/etc/evil" "node: a method parameter shadowing the const"
assert_eq "/w/o.txt" "$(wpaths "$(heredoc 'node -' "const fs = require('fs'); fs.writeFileSync('o.txt', fs.readFileSync('/etc/hosts'))")" /w)" "node: the readFileSync path is not written"
assert_eq "/w/h.txt" "$(wpaths "$(heredoc 'node -' "require('fs').copyFileSync('/etc/hosts', 'h.txt')")" /w)" "node copyFileSync: the destination"
assert_eq "/w/p.txt" "$(wpaths "$(heredoc 'perl' 'open(my $i, "<", "/etc/hosts"); open my $o, ">", "p.txt" or die; print $o <$i>;')" /w)" "perl: < reads, > writes"
assert_eq "/w/q.txt" "$(wpaths "$(heredoc 'perl' 'open(F, ">>q.txt"); print F "/etc/hosts";')" /w)" "perl two-argument open"

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
assert_eq 'UNRESOLVED:OUT:$OUT' "$(wpaths 'OUT="$(mktemp "$TMPDIR/f.XXXXXX")"; cat > "$OUT"' /w)" "a \$( ) value"
assert_eq 'UNRESOLVED:OUT:$OUT' "$(wpaths 'OUT=`mktemp "$TMPDIR/f.XXXXXX"`; cat > $OUT' /w)" "a backtick value"
assert_eq 'UNRESOLVED:UNKNOWN:$UNKNOWN/f' "$(wpaths 'cat > "$UNKNOWN/f"' /w)" "never set"
assert_eq 'UNRESOLVED:UNKNOWN:/w/sub/$UNKNOWN' "$(wpaths 'cat > sub/$UNKNOWN' /w)" "a relative target keeps its dir"
assert_eq 'UNRESOLVED:$():$(mktemp $TMPDIR/f.XXXXXX)' "$(wpaths 'cat > "$(mktemp "$TMPDIR/f.XXXXXX")"' /w)" "a \$( ) target"
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

LR=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-cmd-analysis.XXXXXX")" && pwd -P)
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

test_case "tmb_is_prompt_surface_path anchors on the repo root"
for p in agents/x.md .claude/agents/x.md .claude/skills/s/SKILL.md commands/c.md nested/CLAUDE.md; do
  if tmb_is_prompt_surface_path "$p"; then _pass; else _fail "$p should be a prompt surface"; fi
done
for p in src/agents/x.md docs/templates/a.md myskills/x.md src/rules/r.md; do
  if tmb_is_prompt_surface_path "$p"; then _fail "$p is not a prompt surface"; else _pass; fi
done
SURF=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-cmd-analysis.XXXXXX")
git init -q "$SURF"
mkdir -p "$SURF/src/agents" "$SURF/agents" "$SURF/.claude/worktrees/t/agents"
if tmb_is_prompt_surface_path "$SURF/src/agents/x.md"; then _fail "<repo>/src/agents/x.md is not a prompt surface"; else _pass; fi
if tmb_is_prompt_surface_path "$SURF/agents/x.md"; then _pass; else _fail "<repo>/agents/x.md should be a prompt surface"; fi
if tmb_is_prompt_surface_path "$SURF/.claude/worktrees/t/agents/x.md"; then _pass; else _fail "worktree agents/x.md should be a prompt surface"; fi
if tmb_is_prompt_surface_path "$SURF/.claude/worktrees/t/src/agents/x.md"; then _fail "worktree src/agents/x.md is not a prompt surface"; else _pass; fi
if tmb_is_prompt_surface_path "$SURF/src/agents/x.md" "$SURF"; then _fail "explicit root: src/agents/x.md is not a prompt surface"; else _pass; fi
if tmb_is_prompt_surface_path "/nonexistent/agents/x.md"; then _pass; else _fail "an unresolvable root fails closed"; fi
rm -rf "$SURF"

test_case "tmb_path_canonical"
TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-cmd-analysis.XXXXXX")
trap 'rm -rf "$TMP" "$LR"' EXIT
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

test_case "tmb_cmd_write_paths: more mutating git subcommands and output options (GH 1531)"
assert_eq "/p" "$(wpaths 'git -C /p bisect start' /w)" "git -C bisect start"
assert_eq "" "$(wpaths 'git bisect log; git bisect view; git bisect' /w)" "bisect log / view read"
assert_eq "/w" "$(wpaths 'git submodule --quiet update --init' /w)" "submodule update"
assert_eq "" "$(wpaths 'git submodule status' /w)" "submodule status reads"
assert_eq "/w" "$(wpaths 'git sparse-checkout set a' /w)" "sparse-checkout set"
assert_eq "" "$(wpaths 'git sparse-checkout list' /w)" "sparse-checkout list reads"
assert_eq "/w" "$(wpaths 'git read-tree -m -u HEAD' /w)" "read-tree -u"
assert_eq "" "$(wpaths 'git read-tree HEAD' /w)" "read-tree without -u writes the index only"
assert_eq "/etc/o" "$(wpaths 'git checkout-index -a --prefix=/etc/o/' /w)" "checkout-index --prefix"
assert_eq "/w" "$(wpaths 'git checkout-index -a' /w)" "checkout-index"
assert_eq "/w" "$(wpaths 'git mergetool' /w)" "mergetool"
assert_eq "/etc/r" "$(wpaths 'git init /etc/r' /w)" "init <dir>"
assert_eq "/w" "$(wpaths 'git init' /w)" "init in its own dir"
assert_eq "/etc/g,/w/r" "$(wpaths 'git init --separate-git-dir=/etc/g -b main r' /w)" "init --separate-git-dir"
assert_eq "/etc/p" "$(wpaths 'git format-patch -o /etc/p HEAD~1' /w)" "format-patch -o"
assert_eq "/etc/q" "$(wpaths 'git format-patch --output-directory=/etc/q -1' /w)" "format-patch --output-directory="
assert_eq "/w" "$(wpaths 'git format-patch -1' /w)" "format-patch into its own dir"
assert_eq "" "$(wpaths 'git format-patch --stdout -1' /w)" "format-patch --stdout"
assert_eq "/etc/x.tar" "$(wpaths 'git archive -o /etc/x.tar HEAD' /w)" "archive -o"
assert_eq "/etc/y.tar" "$(wpaths 'git archive --output=/etc/y.tar HEAD' /w)" "archive --output="
assert_eq "" "$(wpaths 'git archive HEAD' /w)" "archive to stdout"

test_case "tmb_cmd_write_paths: each wrapper skips its own options (GH 1531)"
assert_eq "/etc/x" "$(wpaths 'sudo -S rm /etc/x' /w)" "sudo -S takes no value"
assert_eq "/w/x" "$(wpaths 'sudo -C 5 rm ../x' /w/a)" "sudo -C takes an fd number"
assert_eq "/b,/b/f" "$(wpaths 'sudo -u root -D /b touch f' /w)" "sudo -D is a dir"
assert_eq "/etc/y" "$(wpaths 'sudo --user=root -iS rm /etc/y' /w)" "sudo long option and cluster"
assert_eq "/etc/z" "$(wpaths 'env -u FOO -i X=1 rm /etc/z' /w)" "env -u takes a value"
assert_eq "/b,/b/f" "$(wpaths 'env --chdir=/b touch f' /w)" "env --chdir="
assert_eq "/etc/t" "$(wpaths 'time -p rm /etc/t' /w)" "time -p"
assert_eq "/etc/e" "$(wpaths 'exec -a n rm /etc/e' /w)" "exec -a takes a value"
assert_eq "/etc/x," "$(targets 'sudo -S rm /etc/x')" "write_targets: sudo -S"
assert_eq "../x," "$(targets 'sudo -C 5 rm ../x')" "write_targets: sudo -C"
assert_eq "@#rm /etc/x" "$(stmts 'sudo -S rm /etc/x' | sed "s|$PLAIN|@|")" "statements drop sudo -S"
assert_eq "pr merge" "$(ghs 'sudo -u git gh pr merge 1')" "sudo -u <user> gh"

test_case "tmb_cmd_write_paths: truncate, zip and subprocess writes (GH 1531)"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "import os; os.truncate('/etc/x', 0)")" /w)" "os.truncate"
assert_eq "/etc/x.zip" "$(wpaths "$(heredoc 'python3 -' "import zipfile; zipfile.ZipFile('/etc/x.zip', 'w').writestr('a', 'b')")" /w)" "zipfile.ZipFile w"
assert_eq "/etc/x.zip" "$(wpaths "$(heredoc 'python3 -' "import zipfile; zipfile.ZipFile('/etc/x.zip', mode='a')")" /w)" "zipfile.ZipFile mode=a"
assert_eq "" "$(wpaths "$(heredoc 'python3 -' "import zipfile; print(zipfile.ZipFile('/etc/x.zip').namelist())")" /w)" "zipfile.ZipFile read"
assert_eq "/etc/x.tgz" "$(wpaths "$(heredoc 'python3 -' "import tarfile; tarfile.open('/etc/x.tgz', 'w:gz')")" /w)" "tarfile w:gz"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "import subprocess; subprocess.run(['cp', 'a', '/etc/x'])")" /w)" "subprocess.run list"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "import subprocess; subprocess.run('cp a /etc/x', shell=True, check=True, env={'HOME': '/root'})")" /w)" "subprocess.run shell string; env is ignored"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "import subprocess" "dst = '/etc/x'" "subprocess.check_call(['cp', 'a', dst])")")" /w)" "a variable argument fails closed"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "import os; os.system('rm -rf /etc/x')")" /w)" "os.system"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'node -' "require('child_process').execSync('cp a /etc/x')")" /w)" "node execSync"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'node -' "const { spawnSync } = require('child_process'); spawnSync('cp', ['a', '/etc/x'])")" /w)" "node spawnSync"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'perl' 'system("cp", "a", "/etc/x");')" /w)" "perl system"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'ruby' 'system "cp a /etc/x"')" /w)" "ruby system without parens"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'ruby' 'out = `cp a /etc/x`')" /w)" "ruby backticks"

test_case "tmb_cmd_write_paths: a process call's command is judged as a shell command (GH 1531)"
pyw() { wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "$@")")" /w/wt; }
nodew() { wpaths "$(heredoc 'node -' "$1")" /w/wt; }
assert_eq "/w" "$(pyw 'import subprocess' "subprocess.run(['rm', '-rf', '..'])")" "a list argv climbing out"
assert_eq "/w/x" "$(pyw 'import subprocess' "subprocess.run(['rm', '-rf', 'x'], cwd='..')")" "cwd= is a leading cd"
assert_eq "$HOME" "$(pyw 'import os' "os.system('rm -rf ~')")" "os.system with ~"
assert_eq "/w/cg-task" "$(pyw 'import os' "os.system('cd .. && rm -rf cg-task')")" "os.system with a leading cd"
assert_eq "/w/q" "$(pyw 'import subprocess' "subprocess.run(['bash', '-c', 'cd .. && touch q'])")" "bash -c in an argv"
assert_eq "/etc/q" "$(pyw 'import subprocess' "subprocess.run(['python3', '-c', \"open('/etc/q', 'w')\"])")" "an interpreter one-liner in an argv"
assert_eq "/w/wt/a b" "$(pyw 'import subprocess' "subprocess.run(['touch', 'a b'])")" "an argv element with a space stays one word"
assert_eq "" "$(pyw 'import subprocess' "r = subprocess.run(['git', 'status'], stdout=subprocess.PIPE, check=True)" "print(r.stdout)")" "a command that writes nothing"
assert_eq "" "$(pyw 'import subprocess, sys' "subprocess.run([sys.executable, '-m', 'pytest'])")" "sys.executable is python"
assert_eq "/w/x" "$(nodew "require('child_process').spawnSync('touch', ['x'], { cwd: '..', stdio: 'inherit' })")" "node {cwd: ...} is a leading cd"
assert_eq "/w/x" "$(nodew "require('child_process').spawn('touch ../x', { shell: true })")" "node shell: true runs a shell string"
assert_eq "/w/x" "$(wpaths "$(heredoc 'ruby' 'system("touch", "x", chdir: "..")')" /w/wt)" "ruby chdir:"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw 'import subprocess' "d = '..'" "subprocess.run(['rm', '-rf', d])")" "a variable argument is unresolvable"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw 'import subprocess' "subprocess.run(['rm', '-rf', 'x'], cwd=d)")" "a variable cwd is unresolvable"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw 'import subprocess' "subprocess.run(' '.join(['rm', '-rf', '..']), shell=True)")" "a computed command is unresolvable"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(nodew "require('child_process').execSync(\`rm -rf \${d}\`)")" "a template literal command is unresolvable"

test_case "tmb_cmd_write_paths: renamed process imports are resolved, unresolvable ones fail closed (GH 1531)"
assert_eq "/etc/x" "$(pyw 'import subprocess as sp' "sp.run(['rm', '-rf', '/etc/x'])")" "import subprocess as sp"
assert_eq "/etc/x" "$(pyw 'import os, subprocess as sp' "sp.check_output(['cp', 'a', '/etc/x'])")" "import os, subprocess as sp"
assert_eq "/etc/x" "$(pyw 'from subprocess import run as r' "r(['rm', '-rf', '/etc/x'])")" "from subprocess import run as r"
assert_eq "/etc/x" "$(pyw 'from subprocess import (' '    run,' '    PIPE,' ')' "run(['touch', '/etc/x'], stdout=PIPE)")" "from subprocess import (run, PIPE)"
assert_eq "/etc/x" "$(pyw 'from os import system' "system('rm -rf /etc/x')")" "from os import system"
assert_eq "/etc/x" "$(nodew "const {execSync: x} = require('child_process'); x('rm -rf /etc/x')")" "node const {execSync: x}"
assert_eq "/etc/x" "$(nodew "const cp = require('child_process'); cp.execSync('rm -rf /etc/x')")" "node const cp = require"
assert_eq "/etc/x" "$(nodew "import { execSync as run } from 'child_process'; run('rm -rf /etc/x')")" "node import { execSync as run }"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw 'import subprocess' 'f = subprocess.run' "f(['touch', 'x'])")" "a process function held in a variable"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw 'import os' "getattr(os, 'system')('touch x')")" "getattr(os, ...)"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(pyw "__import__('subprocess').run(['touch', 'x'])")" "__import__('subprocess')"
assert_eq "UNRESOLVED:\$(proc):\$(proc)" "$(nodew "const m = require('child_process'); const f = m.execSync; f('touch x')")" "node: a process function held in a variable"
assert_eq "UNRESOLVED:\$(proc):\$(proc),/w/wt/x" "$(nodew "const cp = await import('child_process'); cp.execSync('touch x')")" "node: a dynamic import"
assert_eq "" "$(pyw 'import subprocess' 'try:' "    subprocess.check_call(['make', 'test'])" 'except subprocess.CalledProcessError as e:' '    print(e)')" "subprocess exceptions and constants are not calls"
assert_eq "" "$(pyw 'from os import path' "print(path.join('a', 'b'))")" "other os names"

test_case "_tmb_cmd_prog_calls: every child_process import form finishes (GH 1531)"
. "$PLUGIN_ROOT/tests/l5-l6/lib/timeout-shim.sh"
for imp in "import cp from 'child_process'" 'import cp from "child_process"' "import cp from 'node:child_process'" \
  'import cp from "node:child_process"' "import * as cp from 'child_process'" "import cp, { execSync } from 'child_process'" \
  "import { execSync } from 'child_process'" "const cp = require('child_process')" "const { execSync: x } = require(\"node:child_process\")"; do
  out=$(_l5_timeout 5 bash -c '. "$1/scripts/hooks/lib/cmd-analysis.sh"; _tmb_cmd_prog_calls node "$2" | paste -sd, -' _ "$PLUGIN_ROOT" "$imp; cp.execSync('touch x')")
  assert_eq "0" "$?" "finishes within 5s: $imp"
  assert_contains "$out" "S	touch x" "resolves the import: $imp"
done

test_case "tmb_cmd_write_paths: a process call is judged only when its parts are plain literals (GH 1531)"
U='UNRESOLVED:$(proc):$(proc)'
assert_eq "$U" "$(pyw 'import os' "os.system('rm -rf %s' % '..')")" "% formatting"
assert_eq "$U" "$(pyw 'import subprocess' "subprocess.run('rm -rf %s' % '..', shell=True)")" "% formatting with shell=True"
assert_eq "$U" "$(pyw 'import os' "os.system('rm -rf {}'.format('..'))")" ".format()"
assert_eq "$U" "$(pyw 'import subprocess' "subprocess.run(['rm', '-rf', '..'.strip()])")" "a method on a list element"
assert_eq "$U" "$(pyw 'import os' "os.system('rm -rf ' + '..')")" "a concatenation"
assert_eq "$U" "$(pyw 'import os' "d = '..'" "os.system(f'rm -rf {d}')")" "an f-string"
assert_eq "$U" "$(pyw 'import subprocess' "kw = {'cwd': '..'}" "subprocess.run(['rm', '-rf', 'x'], **kw)")" "**kw"
assert_eq "$U" "$(pyw 'import subprocess' "a = ['rm', '-rf', '..']" "subprocess.run(*a)")" "*args"
assert_eq "$U" "$(pyw 'import subprocess' "subprocess.run(['ls', '..'], executable='/bin/rm')")" "executable= swaps the program"
assert_eq "$U" "$(pyw 'import subprocess' "subprocess.run(['touch', 'x'], cwd=Path('..'))")" "a cwd that is a call"
assert_eq "$U" "$(nodew "const { execSync } = require('child_process'); const o = { cwd: '..' }; execSync('rm -rf x', o)")" "a node options variable"
assert_eq "$U" "$(nodew "const { execSync } = require('child_process'); execSync('rm -rf x', { ...{ cwd: '..' } })")" "a node options spread"
assert_eq "$U" "$(nodew "const { execSync } = require('child_process'); execSync('rm -rf x', { cwd })")" "a node cwd shorthand"
assert_eq "$U" "$(nodew "const cp = require('child_process'); cp.exec('ls', () => cp.execSync('rm -rf ..'))")" "a process call inside a callback"
assert_eq "$U" "$(wpaths "$(heredoc 'perl' 'my $d = ".."; system("rm", "-rf", $d);')" /w/wt)" "a perl variable"
assert_eq "$U" "$(wpaths "$(heredoc 'ruby' 'system("rm", "-rf", "x", chdir: d)')" /w/wt)" "a ruby variable chdir:"
assert_eq "$U" "$(wpaths "$(heredoc 'ruby' 'system("rm -rf x", :chdir => d)')" /w/wt)" "a ruby :chdir => variable"
assert_eq "/w/x" "$(wpaths "$(heredoc 'ruby' 'system("touch x", :chdir => "..")')" /w/wt)" "ruby :chdir => literal is a leading cd"
assert_eq "/w/wt/sub/x" "$(pyw 'import subprocess' "subprocess.run(['touch', 'x'], cwd='sub', check=True, capture_output=True, text=True, env=dict(A='1'))")" "plain literals with ordinary options"
assert_eq "/w/wt/x" "$(nodew "const cp = require('child_process'); cp.exec('touch x', { stdio: 'inherit', encoding: 'utf8' }, (err, out) => { console.log(out) })")" "node options and a callback"
assert_eq "/w/wt/x" "$(wpaths "$(heredoc 'ruby' "system({'A' => '1'}, 'touch', 'x', out: :close)")" /w/wt)" "a ruby env hash and a redirect to a symbol"
assert_eq "" "$(pyw "print('%s/%s' % ('a', 'b'.strip()))")" "a program without process calls is unaffected"

test_case "tmb_cmd_write_paths: a chdir makes process calls and relative writes unresolvable (GH 1531)"
assert_eq "$U" "$(pyw 'import os' "os.chdir('..')" "os.system('rm -rf cg-task')")" "os.chdir then os.system"
assert_eq "$U" "$(pyw 'from os import chdir' 'import subprocess' "chdir('..')" "subprocess.run(['rm', '-rf', 'cg-task'])")" "from os import chdir"
assert_eq "$U" "$(nodew "process.chdir('..'); require('child_process').execSync('rm -rf cg-task')")" "node process.chdir"
assert_eq "$U" "$(wpaths "$(heredoc 'perl' "chdir '..'; system('rm', '-rf', 'cg-task');")" /w/wt)" "perl chdir"
assert_eq "$U" "$(wpaths "$(heredoc 'ruby' "Dir.chdir('..')"$'\n'"system('rm -rf cg-task')")" /w/wt)" "ruby Dir.chdir"
assert_eq "UNRESOLVED:\$(proc):\$(proc)/a.txt" "$(pyw 'import os' "os.chdir('..')" "open('a.txt', 'w').write('x')")" "a relative write after a chdir"
assert_eq "/etc/x" "$(pyw 'import os' "os.chdir('..')" "open('/etc/x', 'w').write('x')")" "an absolute write after a chdir is still judged"

test_case "tmb_cmd_write_paths: qx, %x and string evaluation (GH 1531)"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'perl' 'my $o = qx(rm -rf /etc/x);')" /w/wt)" "perl qx()"
assert_eq "/etc/y" "$(wpaths "$(heredoc 'perl' "my \$o = qx'rm /etc/y';")" /w/wt)" "perl qx'' does not interpolate"
assert_eq "$U" "$(wpaths "$(heredoc 'perl' 'my $o = qx{rm -rf $d};')" /w/wt)" "perl qx{} interpolating"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'ruby' 'o = %x(rm -rf /etc/x)')" /w/wt)" "ruby %x()"
assert_eq "$U" "$(wpaths "$(heredoc 'ruby' 'o = %x{rm -rf #{d}}')" /w/wt)" "ruby %x{} interpolating"
assert_eq "$U" "$(pyw "exec(\"import os; os.system('rm -rf ..')\")")" "python exec of a string"
assert_eq "$U" "$(pyw "eval(compile('1', 'f', 'eval'))")" "python eval"
assert_eq "$U" "$(nodew "eval(\"require('child_process').execSync('rm -rf ..')\")")" "node eval"
assert_eq "$U" "$(nodew "new Function(\"require('child_process').execSync('rm -rf ..')\")()")" "node new Function"
assert_eq "$U" "$(wpaths "$(heredoc 'perl' 'eval "system(q(rm -rf ..))";')" /w/wt)" "perl eval of a string"
assert_eq "" "$(wpaths "$(heredoc 'perl' 'eval { print "x" };')" /w/wt)" "perl eval of a block"

test_case "tmb_cmd_write_paths: data a program writes is content, not a target (GH 1531)"
CONTENT="const root = '/work/proj'; const branch = 'fix/sess-a';"
assert_eq "/w/a.ts" "$(wpaths "$(heredoc 'python3 -' "open('/w/a.ts', 'w').write(\"$CONTENT\")")" /w)" "open w with path-like text"
assert_eq "/w/a.ts" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "from pathlib import Path" "p = Path('/w/a.ts')" "p.write_text(\"$CONTENT\")")")" /w)" "an unknown receiver judges only the literals outside the content"
assert_eq "/w/a.ts" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = '/w/a.ts'" "with open(p, 'w') as f:" "    f.write(\"$CONTENT\")")")" /w)" "a variable path: the written data is not a target"
assert_eq "/w/a.ts" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "from pathlib import Path" "p = Path('/w/a.ts')" "p.write_text(p.read_text().replace('/work/proj', 'fix/sess-a'))")")" /w)" "replace literals inside the written data"
assert_eq "/etc/x" "$(wpaths "$(heredoc 'python3 -' "$(printf '%s\n' "p = '/etc/x'" "with open(p, 'w') as f:" "    f.write(\"$CONTENT\")")")" /w)" "the same program with an outside path"
assert_eq "/w/o.txt" "$(wpaths "$(heredoc 'node -' "require('fs').writeFileSync('o.txt', \"$CONTENT\")")" /w)" "node writeFileSync data"
assert_eq "/etc,/x" "$(wpaths "$(heredoc 'python3 -' "d = '/etc'; open(d + '/x', 'w').write('hi')")" /w)" "a computed path still fails closed"

test_case "tmb_cmd_write_paths: code-string runners and dynamic builtins (GH 1569)"
assert_contains "$(pyw 'import cProfile' "cProfile.run('p = \"/etc/evil\"')" "open(p, 'w')")" "$U" "a code string can rebind a variable write path"
assert_contains "$(pyw 'import cProfile' "cProfile.run('open(\"/etc/evil\", \"w\")')" "open('out.txt', 'w')")" "/etc/evil" "a write inside the code string"
assert_eq "/etc/evil" "$(pyw 'import cProfile' "cProfile.run('import os\\nos.system(\"rm -rf /etc/evil\")')")" "a process call inside the code string"
assert_eq "$U/a.txt" "$(pyw 'import cProfile' "cProfile.run('import os; os.chdir(\"..\")')" "open('a.txt', 'w')")" "a chdir inside the code string"
assert_eq "$U" "$(pyw 'import trace' "trace.Trace(count=0, trace=0).run('open(\"/etc/evil\", \"w\")')")" "trace.Trace().run chained on the constructor"
assert_eq "$U" "$(pyw 'import timeit' "timeit.Timer('x = 1', setup='open(\"/etc/evil\", \"w\")')")" "a literal timeit.Timer"
assert_eq "/etc/evil" "$(pyw 'import timeit' "timeit.timeit('x = 1', setup='open(\"/etc/evil\", \"w\")')")" "timeit setup="
assert_eq "/etc/evil" "$(pyw 'from timeit import timeit' "timeit('open(\"/etc/evil\", \"w\")')")" "from timeit import timeit"
assert_eq "/etc/evil" "$(pyw 'import cProfile as cp' "cp.run('open(\"/etc/evil\", \"w\")')")" "import cProfile as cp"
assert_eq "/etc/evil" "$(pyw 'from cProfile import run' "run('open(\"/etc/evil\", \"w\")')")" "from cProfile import run"
assert_eq "/etc/evil" "$(pyw 'import subprocess as q, pdb' "pdb.run(\"q.run(['rm', '-rf', '/etc/evil'])\")")" "the program's import aliases hold inside the code string"
for prog in 'import timeit|timeit.timeit(s)' "import timeit|timeit.timeit(stmt='x = 1', setup=s)" "import cProfile|cProfile.run('p=%r' % '/etc/evil')" \
  "compile(s, 'f', 'exec')" 'from timeit import timeit|timeit(s)' 'import cProfile as cp|cp.run(s)' 'import trace|t = trace.Trace()|t.run(s)' \
  "import cProfile|cProfile.run('\\x6fpen(\"/etc/evil\", \"w\")')" "import cProfile|cProfile.run('import subprocess as q')|q.run(['rm', '-rf', '..'])" \
  'import cProfile|f = cProfile.run' "import builtins|getattr(builtins, 'ex' + 'ec')(s)" 'getattr(__builtins__, name)(s)' \
  "import builtins|vars(builtins)['exec'](s)" "import builtins|builtins.__dict__['exec'](s)" "globals()['__builtins__']['exec'](s)" \
  "__import__('builtins')" 'e = exec|e(s)' 'from builtins import exec as e|e(s)' 'import builtins as b|b.exec(s)'; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$U" "$(pyw "${lines[@]}")" "unresolvable: $prog"
done
pyq() { printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")"; }
deep="open('/etc/evil', 'w')"
for _ in 1 2 3; do deep="compile($(pyq "$deep"), 'f', 'exec')"; done
assert_eq "/etc/evil" "$(pyw "$deep")" "code strings nest to depth 3"
deep="compile($(pyq "$deep"), 'f', 'exec')"
assert_eq "$U" "$(pyw "$deep")" "deeper is unresolvable"
assert_eq "" "$(pyw 'import cProfile' "cProfile.run('sum(range(9))')")" "benign cProfile.run"
assert_eq "" "$(pyw 'import timeit' "timeit.timeit('sum(range(9))', number=10)")" "benign timeit.timeit"
assert_eq "" "$(pyw 'import timeit' 'timeit.timeit(lambda: 1)')" "a timeit lambda is not a code string"
assert_eq "" "$(pyw 'import timeit' 'def f(): pass' 'timeit.timeit(lambda: f(), number=10)')" "a timeit lambda calling a defined function"
assert_eq "/w/wt/out.txt" "$(pyw 'import cProfile' "cProfile.run('main()')" "open('out.txt', 'w')")" "cProfile.run beside a literal write"
assert_eq "" "$(pyw 'import timeit' "timeit.repeat('sum(range(9))', repeat=3, number=10)")" "benign timeit.repeat"
assert_eq "" "$(pyw 'import pdb' "pdb.run('sum(range(9))')")" "benign pdb.run"
for prog in "import cProfile, sys|s = sys.argv[1]|cProfile.Profile().run('pass').run(s)" \
  "import cProfile|cProfile.Profile().run('pass').run('o' + 'pen(\"/et\" + \"c/x\", \"w\")')" \
  "import cProfile, sys|pr = cProfile.Profile().run('pass')|pr.runctx(sys.argv[1], globals(), None)" \
  "import profile, sys|s = sys.argv[1]|profile.Profile().run('pass').run(s)" \
  "import profile, sys|pr = profile.Profile().run('pass')|pr.runctx(sys.argv[1], globals(), None)" \
  "import cProfile|cProfile.Profile().run('pass')" "import pdb|pdb.Pdb().run('pass')" "import bdb|bdb.Bdb().run('pass')" \
  "import timeit, sys|t = timeit.Timer('pass'); type(t)(sys.argv[1]).timeit(1)" "import timeit|type(timeit.Timer('pass'))(s).timeit()" \
  "import timeit|t = timeit.Timer('pass'); t.__class__(s)" "from timeit import Timer as T|T('pass').timeit()" "from timeit import *|Timer('pass')"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$U" "$(pyw "${lines[@]}")" "a runner object is unresolvable: $prog"
done
assert_eq "" "$(pyw 'import re' "re.compile(r'x')")" "re.compile is not a runner"
assert_eq "" "$(pyw 'import builtins' 'builtins.print(1)')" "builtins.<other name>"
assert_eq "$U" "$(pyw 'import cProfile' 'with cProfile.Profile() as pr:' '    sum(range(9))' 'pr.print_stats()')" "with cProfile.Profile() as pr: no unchained constructor is exempt"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile(); pr.enable(); sum(range(9)); pr.disable()')" "Profile enable / disable"
assert_eq "$U" "$(pyw 'import timeit' 'def f(): pass' 'timeit.timeit(f, number=10)')" "a timeit function the program defines is a bare name"
assert_eq "$U" "$(pyw 'import timeit' 'timeit.timeit(f, number=10)')" "a timeit name the program does not define"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile(); pr.run(s)')" "an unchained constructor beside a .run call"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' "getattr(pr, 'run')(code)")" "an unchained constructor beside getattr"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' 'm = pr.run' 'm(code)')" "an unchained constructor beside a .run reference"
assert_eq "$U" "$(pyw 'import cProfile, inspect' 'pr = cProfile.Profile()' "inspect.getattr_static(pr, 'run')(pr, code)")" "an unchained constructor beside inspect.getattr_static"
assert_eq "$U" "$(pyw 'import cProfile, inspect' 'pr = cProfile.Profile()' "dict(inspect.getmembers(pr))['run'](code)")" "an unchained constructor beside inspect.getmembers"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' '(pr.' ' run)(code)')" "a .run split across lines in parens"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' 'pr.\' 'run(code)')" "a .run split by a backslash continuation"
assert_eq "$U" "$(pyw 'import cProfile, inspect' "dict(inspect.getmembers(cProfile.Profile()))['run'](code)")" "a constructor not bound to a name"
assert_eq "$U" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' 'pr.enable()' 'print(pr)')" "a bound constructor passed to print"
assert_contains "$(pyw 'import cProfile' "cProfile.run('sum(range(9))', '/etc/evil')")" "/etc/evil" "cProfile.run filename"
assert_eq "/w/wt/out.prof" "$(pyw 'import cProfile' "cProfile.run('main()', 'out.prof')")" "cProfile.run filename relative"
assert_contains "$(pyw 'import profile' "profile.run('main()', filename='/etc/evil')")" "/etc/evil" "profile.run filename="
assert_contains "$(pyw 'import cProfile' "cProfile.runctx('main()', {}, {}, '/etc/evil')")" "/etc/evil" "cProfile.runctx 4th positional filename"
assert_contains "$(pyw 'import cProfile' "cProfile.run('main()', fn)")" "$U" "a non-literal cProfile.run filename"
for imp in 'import cProfile|cProfile.Profile' 'from cProfile import Profile|Profile' 'from cProfile import Profile as P|P' 'import cProfile as c|c.Profile'; do
  assert_contains "$(pyw "${imp%%|*}" "p = 'out.txt'" "${imp#*|}.runctx(o, 'p = \"/etc/evil\"', globals(), None)" "open(p, 'w')")" "$U" "a runner method reached through the class: ${imp%%|*}"
done
assert_eq "$U" "$(pyw 'import pdb' 'pdb.Pdb.run(o, s)')" "pdb.Pdb.run through the class"
assert_eq "$U" "$(pyw 'import timeit' 'timeit.Timer.timeit(o)')" "timeit.Timer.timeit through the class"
assert_eq "$U" "$(pyw 'import cProfile' 'f = cProfile.Profile.run')" "a class method referenced without a call"
assert_contains "$(pyw 'import cProfile' 'pr = cProfile.Profile()' "globals()['p' + 'r'].run('p = \"/etc/evil\"')" "open(p, 'w')")" "$U" "a bound constructor beside globals()"
assert_contains "$(pyw 'import cProfile, sys' 'pr = cProfile.Profile()' "getattr(sys, 'mod' + 'ules')['__ma' + 'in__'].pr.run('p = \"/etc/evil\"')" "open(p, 'w')")" "$U" "a bound constructor reached through a computed sys.modules"
assert_contains "$(pyw 'import cProfile, sys' 'pr = cProfile.Profile()' "getattr(getattr(sys, 'mod' + 'ules')['__ma' + 'in__'], 'p' + 'r').run('p = \"/etc/evil\"')" "open(p, 'w')")" "$U" "a bound constructor reached by a computed getattr name"
assert_eq "$U" "$(pyw 'import cProfile' 'def main(): pass' 'if __name__ == "__main__":' '    with cProfile.Profile() as pr:' '        main()' '    pr.print_stats()')" "a with-bound profiler under the __main__ guard"
assert_eq "$U" "$(pyw 'import sys' "sys.modules.get('builtins')")" "sys.modules.get('builtins')"
assert_eq "$U" "$(pyw 'import sys' "b = sys.modules['builtins']")" "sys.modules['builtins']"
assert_eq "$U" "$(pyw "getattr(len.__self__, 'ex' + 'ec')(s)")" ".__self__ of a builtin"
assert_eq "$U" "$(pyw 'import timeit' 'def f(): pass' "f = 'open(p, \"w\")'" 'timeit.timeit(f)')" "a timeit name rebound after its def"
assert_eq "$U" "$(pyw 'import timeit' 'def f(): pass' "for f in ['x = 1']:" '    timeit.timeit(f)')" "a timeit name bound by for"
assert_eq "$U" "$(pyw 'import timeit' "def d(fn): return 'open(p, \"w\")'" '@d' 'def f(): pass' 'timeit.timeit(f)')" "a decorated timeit function"
assert_eq "$U" "$(pyw 'import timeit' 'def f(): pass' 'f()' 'timeit.timeit(f)' 'timeit.repeat(f)')" "a defined timeit function called and timed twice"
assert_contains "$(pyw 'import cProfile' 'pr = cProfile.Profile()' "pr.dump_stats('/etc/evil')")" "/etc/evil" "dump_stats writes its path"
assert_contains "$(pyw 'import cProfile' "open('out.txt', 'w')" 'pr = cProfile.Profile()' "pr.dump_stats('/etc/evil')")" "/etc/evil" "dump_stats beside a literal write"
assert_eq "$U,/w/wt/out.prof" "$(pyw 'import cProfile' 'pr = cProfile.Profile()' "pr.dump_stats('out.prof')")" "dump_stats of a relative path"

test_case "tmb_cmd_write_paths: python paths that hide a write are unresolvable when referenced at all (GH 1571)"
for prog in 'import runpy|runpy.run_path(sys.argv[1])' 'import code|code.interact(local=globals())' 'import doctest|doctest.run_docstring_examples(f, {})' \
  'import codeop, types|c = codeop.compile_command(s)|types.FunctionType(c, {})()' 'import pickle|pickle.loads(b)' 'import marshal|marshal.loads(b)' \
  "import shelve|shelve.open('x')" 'breakpoint()' 'import pdb|pdb.main()' 'import timeit|timeit.main()' 'import cProfile|cProfile.main()' \
  "import sys|sys.modules['built' + 'ins'].exec(s)" 'import sys|sys.modules.get(n).run(s)' "globals()['__buil' + 'tins__']['exec'](s)" \
  'import pydoc|pydoc.locate(n)(s)' 'import importlib|importlib.import_module(n).run(s)' "i = __import__|i('os').system(c)" \
  '().__class__.__bases__[0].__subclasses__()' "f.__globals__['open'](p, 'w')" "getattr(obj, n)(p, 'w')" \
  'vars(obj)[n](s)' "open('\\x2fetc\\x2fevil', 'w')" 'import inspect|inspect.getattr_static(o, n)' \
  'if 1: import runpy; runpy.run_path(p)' '__import__(n).run(s)' 'from sys import *|modules[n].run(s)' 'from pdb import main as m|m()' \
  'import pdb|pdb.set_trace()' "getattr(o, '__globals__')" "open('\\057etc', 'w')"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$U" "$(pyw "${lines[@]}")" "unresolvable: $prog"
done
assert_eq "" "$(pyw 'import json' "json.dumps({})")" "an ordinary module"
assert_eq "/w/wt/out.txt" "$(pyw "open('out.txt', 'w').write('a\\\\n')")" "an escaped backslash is no hex escape"
assert_eq "" "$(pyw 'class A: pass' "getattr(A(), 'x', None)")" "getattr with a literal name"
assert_eq "" "$(pyw "import re" "re.compile(r'\\x41')")" "a raw string's backslash is no escape"
for cmd in "python3 -m timeit -s \"open('/etc/evil','w')\" pass" 'python3 -m cProfile -o out.prof x.py' 'python3 -m pdb x.py' 'python3 -Im runpy x' 'python3 -mpickle x.pkl'; do
  assert_eq "$U" "$(wpaths "$cmd" /w/wt)" "python -m runner: $cmd"
done
for cmd in 'python3 -m json.tool x.json' 'python3 -m pytest -q' 'python3 -m pytest -m pdb' 'python3 x.py -m pdb'; do
  assert_eq "" "$(wpaths "$cmd" /w/wt)" "python -m other: $cmd"
done

test_case "GH 1676: a held or aliased write builtin is \$(alias-write), not \$(proc)"
AW='UNRESOLVED:$(alias-write):$(alias-write)'
for prog in "o = open|o(p, 'w')" "import pdb|pdb.runeval('open')(p, 'w')" "from builtins import open as o|o('/etc/x', 'w')" \
  "import builtins|o = builtins.open|o('/etc/x', 'w')" "x = [open]|x[0]('/etc/x', 'w')" "f = open.__call__|f('/etc/x', 'w')"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$AW" "$(pyw "${lines[@]}")" "alias-write: $prog"
done
for prog in 'e = eval|e(s)' "g = getattr|g(o, 'x')" 'import subprocess|f = subprocess.run|f(c)'; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$U" "$(pyw "${lines[@]}")" "still a process-call class: $prog"
done
assert_eq "/w/wt/a.txt" "$(pyw "open('a.txt', 'w')")" "a direct open() with a literal path resolves"

test_case "GH 1687: a held or aliased module-qualified write callable is \$(alias-write)"
for prog in "import io|f = io.open|f('/etc/x', 'w')" "import os|o = os.open|o('/etc/x', 1)" "import shutil|m = shutil.move|m('a', '/etc/x')" \
  "import shutil|m = shutil.copy|m('a', '/etc/x')" "import shutil as s|m = s.move|m('a', '/etc/x')" "from shutil import move as mv|m = mv|m('a', '/etc/x')" \
  "from shutil import move|m = move|m('a', '/etc/x')" "from io import open as op|f = op|f('/etc/x', 'w')" "import os|ops = [os.remove]|ops[0]('/etc/x')" \
  "import shutil|shutil.move.__call__('a', '/etc/x')" "import pathlib|w = pathlib.Path.write_text|w(pathlib.Path('/etc/x'), 's')" \
  "from pathlib import Path|w = Path.write_text|w(Path('/etc/x'), 's')" "import os|r = os.rename|r('a', '/etc/x')" "import os|r = os.replace|r('a', '/etc/x')" \
  "import os|r = os.unlink|r('/etc/x')" "import os|r = os.makedirs|r('/etc/x')" "import shutil|r = shutil.rmtree|r('/etc/x')" \
  "import shutil|r = shutil.copyfile|r('a', '/etc/x')" "import shutil|r = shutil.copy2|r('a', '/etc/x')" "import shutil as sh|m = sh.move|m('a', '/etc/x')" \
  "import shutil|m = (shutil.move)|m('a', '/etc/x')" "import shutil|f(shutil.move)" "import shutil|d = {'m': shutil.move}|d['m']('a', '/etc/x')" \
  "import shutil, functools|p = functools.partial(shutil.move, 'a')|p('/etc/x')" "import zipfile|z = zipfile.ZipFile|z('/etc/x', 'w')" \
  "from shutil import *|m = move|m('a', '/etc/x')" "from os import *|r = remove|r('/etc/x')" "import shutil|m = shutil . move|m('a', '/etc/x')" \
  "import shutil as sh|m = sh . move|m('a', '/etc/x')" "import shutil|m = getattr(shutil, 'move')|m('a', '/etc/x')" "import io|f = getattr(io, 'open')|f('/etc/x', 'w')"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$AW" "$(pyw "${lines[@]}")" "alias-write: $prog"
done
assert_eq "/w/wt/a,/etc/x" "$(pyw 'from shutil import *' "move('a', '/etc/x')")" "a star-imported writer called directly resolves its paths"
assert_eq "/w/wt/a,/w/wt/b" "$(pyw 'import shutil' "shutil.move('a', 'b')")" "a direct shutil.move resolves its paths"
assert_eq "/w/wt/out" "$(pyw 'import shutil' "shutil.copy('a', 'out')")" "a direct shutil.copy resolves its dst"
assert_eq "/w/wt/a,/etc/x" "$(pyw 'import shutil as s' "s.move('a', '/etc/x')")" "a call through an import alias resolves its paths"
assert_eq "/etc/x" "$(pyw 'from os import remove' "remove('/etc/x')")" "a from-imported writer called directly resolves its path"
assert_eq "/w/wt/b" "$(pyw 'import shutil' "shutil.copytree('a', 'b', copy_function=shutil.copy2)")" "a copy function passed to copytree writes under its dst"
assert_contains "$(pyw 'import shutil' "shutil.copytree('/etc', 'b', copy_function=shutil.rmtree)")" '$(alias-write)' "a non-copy writer as copy_function is held"
for prog in 'import sys|w = sys.stdout.write|w(s)' 'import copy|c = copy.copy|c(x)' 'd = {}|c = d.copy|c()' 'import os|j = os.path.join' 'import shutil|shutil.move = f' \
  'import csv|for row in rows: print(row.open, row.close)' "import feedparser|for e in feedparser.parse('feed.xml').entries: print(e.link)" \
  'import argparse|args = argparse.ArgumentParser().parse_args()|print(args.rm)' "import pandas as pd|df = pd.read_csv('prices.csv')|print(df.open.mean())" \
  'from pathlib import Path|print(isinstance(p, Path))' 'm = shutil.move'; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "" "$(pyw "${lines[@]}")" "not a held writer: $prog"
done
for prog in "m = __import__('shutil').move|m('a', '/etc/x')" "o = __import__('io').open|o('/etc/x', 'w')" "s = __import__('shutil')|m = s.move|m('a', '/etc/x')" \
  "m = __import__('shutil', fromlist=['move']).move|m('a', '/etc/x')" "getattr(__import__('shutil'), 'move')('a', '/etc/x')" \
  "m = __import__('shutil') . move|m('a', '/etc/x')" "__import__('shutil').move.__call__('a', '/etc/x')" "z = __import__('zipfile').ZipFile|z('/etc/x', 'w')"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "$AW" "$(pyw "${lines[@]}")" "alias-write through a literal __import__: $prog"
done
assert_contains "$(pyw 'import importlib' "m = importlib.import_module('shutil').move" "m('a', '/etc/x')")" '$(alias-write)' "a writer held off importlib.import_module is alias-write"
assert_eq "/w/wt/a,/etc/x" "$(pyw "__import__('shutil').move('a', '/etc/x')")" "a direct __import__('shutil').move resolves its paths"
assert_eq "/w/wt/a,/w/wt/b" "$(pyw "__import__('shutil').move('a', 'b')")" "a direct __import__('shutil').move inside the worktree resolves its paths"
assert_eq "/w/wt/o.txt" "$(pyw "__import__('io').open('o.txt', 'w')")" "a direct __import__('io').open resolves its path"
assert_eq "/etc/x" "$(pyw "__import__('pathlib').Path('/etc/x').write_text('s')")" "a Path off __import__('pathlib') is a Path receiver"
for prog in "__import__('io').StringIO('x')" "j = __import__('json')|j.dumps(1)"; do
  IFS='|' read -r -a lines <<< "$prog"
  assert_eq "" "$(pyw "${lines[@]}")" "not a held writer: $prog"
done

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

test_case "GH 1595/1610: a same-command VAR=<literal> resolves a cd or -C dir"
last() { stmts "$1" | awk -F'|' '{print $NF}'; }
assert_eq '/abs#git -C $R status' "$(last 'R=/abs; git -C $R status')" "R=/abs; git -C \$R"
assert_eq '/abs#git -C ${R} status' "$(last 'R=/abs && git -C "${R}" status')" "a braced, quoted \${R} after &&"
assert_eq '/w/B#git commit' "$(last 'export WT=/w/B; cd $WT && git commit')" "export WT=<literal>; cd \$WT"
assert_eq '/w/B#git add f|/w/B#git commit' "$(stmts 'WT=/w/B; cd "$WT" && git add f && git commit' | awk -F'|' '{print $(NF-1) "|" $NF}')" "WT=<literal>; cd \"\$WT\" && git add && git commit"
assert_eq '/b#git -C $R status' "$(last 'R=/a; R=/b; git -C $R status')" "the latest assignment wins"

test_case "GH 1911: VAR=<literal> survives quoted operators and data heredocs, and dies on anything that may assign"
assert_eq '/w/r#git -C $W commit -q -m a__b_|/w/r#git -C $W status' \
  "$(stmts 'W=/w/r; git -C $W commit -q -m "a (b)"; git -C $W status')" "-m \"a (b)\" and the git after it"
assert_eq '/w/r#git -C $W commit -q -F - <<EOM|/w/r#git -C $W status' \
  "$(stmts $'W=/w/r; git -C $W commit -q -F - <<EOM\nmsg\nEOM\ngit -C $W status')" "-F - <<EOM, its <<EOM unmarked"
assert_eq "$PLAIN#cat <<EOM|-#git -C \$W status" \
  "$(stmts $'W=/w/r; cat <<EOM\n$((W=0))\nEOM\ngit -C $W status')" "an unquoted \$((W=0)) body"
STMT_VARS="$PLUGIN_ROOT/tests/fixtures/cmd-analysis/statement-vars.jsonl"
assert_eq "true" "$(jq -s '(map(select(.dirs[-1] == "-")) | length >= 60) and (map(select(.dirs[-1] | startswith("/"))) | length >= 14)' "$STMT_VARS")" "the shared fixture holds both kinds"
while IFS= read -r row; do
  c=$(jq -r .cmd <<< "$row")
  want=$(jq -r --arg p "$PLAIN" '[.dirs[] | if . == "@" then $p else . end] | join("|")' <<< "$row")
  assert_eq "$want" "$(tmb_cmd_statements "$c" "$PLAIN" | cut -f1 | paste -sd'|' -)" "$(jq -r .why <<< "$row"): $c"
done < "$STMT_VARS"

test_case "GH 1595: a relative path after an unresolvable cd is never bare"
assert_eq 'UNRESOLVED:UNSET:$UNSET/f' "$(wpaths 'cd $UNSET && touch f' /w)" "cd \$UNSET && touch f"
assert_eq 'UNRESOLVED:PWD:$PWD/f' "$(wpaths 'cd - && touch f' /w)" "cd - && touch f"
assert_eq 'UNRESOLVED:U:$U' "$(wpaths 'git -C $U add f' /w)" "git -C \$U add"
assert_eq '/b/f' "$(wpaths 'D=/b; cd $D && touch f' /w)" "a literal-set variable resolves"

test_case "GH 1602: an inline program's non-literal process call is \$(proc), not \$()"
assert_eq 'UNRESOLVED:$(proc):$(proc)' "$(pyw 'import subprocess' 'for n in range(3):' "    subprocess.run(['true', str(n)])")" "subprocess.run(['true', str(n)])"
assert_eq 'UNRESOLVED:X:$X/x' "$(pyw 'import os' 'os.system("cd $X && touch x")')" "a literal shell string still names its variable"

test_case "GH 1595: tmb_deny_ambiguous_git_target names an unresolvable dir"
OUT=$(tmb_deny_ambiguous_git_target 'git commit' unresolved | jq -r .hookSpecificOutput.permissionDecisionReason)
assert_contains "$OUT" "ambiguous_git_target" "keeps the token"
assert_contains "$OUT" "comes through a variable" "says the dir is unresolvable"
assert_not_contains "$OUT" "names no directory" "not the no-directory reason"
assert_contains "$(tmb_deny_ambiguous_git_target 'git commit')" "names no directory" "the plain form is unchanged"

test_case "tmb_strip_quoted_spans"
assert_eq "see   and   then" "$(tmb_strip_quoted_spans 'see `git push` and "push it" then')" "backticks and double quotes"
assert_eq "x   y" "$(tmb_strip_quoted_spans "x 'still open' y")" "single quotes"
assert_eq "let's keep users' words" "$(tmb_strip_quoted_spans "let's keep users' words")" "apostrophes are not quotes"
assert_eq 'an "unclosed quote' "$(tmb_strip_quoted_spans 'an "unclosed quote')" "an unclosed quote stays"

summarize
