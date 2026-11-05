/**
 * tmb_cmd_write_paths on shell commands (GH 1692), ported from the bash
 * cmd-analysis l3 test: write shapes, per statement dirs, -C / --prefix dirs and mutating git, variables, $PWD and
 * $OLDPWD, wrapper options, and loop-body assignments and cds (GH 1944, 1977).
 * Each case is judged on the frozen answers of the shell lib and on writePaths
 * of the TS module, except a command recorded in divergences.jsonl, which is
 * judged on the frozen answer only.
 */
import { after } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePaths } from '../hooks/cmd-analysis/index.js';
import { Suite, ghs, lastField, rootedPaths, runSuite, stmts, targets, wpaths, } from './cmd-analysis-l3.js';
const HOME = process.env.HOME ?? '';
const TMP = mkdtempSync(join(tmpdir(), 'tmb-cmd-analysis-'));
const PLAIN = join(TMP, 'plain');
mkdirSync(PLAIN);
after(() => rmSync(TMP, { recursive: true, force: true }));
const w = (cmd) => wpaths(cmd, '/w');
const s = new Suite('write-paths').token('<TMP>', TMP).token('<TMP_REAL>', realpathSync(TMP));
s.group('tmb_cmd_write_paths: every write shape (GH 1272)')
    .eq('/w/a.md', w('echo x >| a.md'), '>|')
    .eq('/w/a.md', w('exec 3> a.md'), 'exec N>')
    .eq('/w/a.md', w("cat > a.md <<'EOF'\nx > /w/no.md\nEOF"), 'heredoc: the redirect, not the body')
    .eq('/w/a.md,/w/b.md', w('echo x | tee -a a.md b.md'), 'tee -a')
    .eq('/w/x.md,/w/y.md', w("sed -i -e 's/a/b/' x.md y.md"), 'sed -i: every file operand')
    .eq('/w/f.md', w("sed -i '/x/r skills/a/SKILL.md' f.md"), 'sed -i: a path inside the script is data')
    .eq('/w/a.md,/w/b.md', w("perl -pi -e 's/a/b/' a.md b.md"), 'perl -i')
    .eq('/w/of.md', w('dd if=/w/if.md of=of.md'), 'dd of=')
    .eq('/w/t.md', w('truncate --size 0 t.md'), 'truncate')
    .eq('/w/d.md', w('install -m 644 s.md d.md'), 'install')
    .eq('/w/dst', w('rsync -av src/ dst/'), 'rsync destination')
    .eq('/w/d.md,/w/s.md', w('mv s.md d.md'), 'mv: destination and the removed source')
    .eq('/w/r/d.md,/w/r/s.md', w('git -C r mv s.md d.md'), 'git mv under git -C')
    .eq('/w/a.md', w(`python3 -c "open('a.md','w').write('x')"`), 'python open w')
    .eq('/w/a.md', w(`python3 -c "open('a.md', mode='x')"`), 'python open mode=x')
    .eq('/w/s/a.md', w(`python3 -c "from pathlib import Path; Path('s/a.md').write_text('x')"`), 'python write_text')
    .eq('/w/s/a.md', w(`python3 -c "import sys; open(sys.argv[1],'w')" s/a.md`), 'python writing its argv operand')
    .eq('/w/o.md', w(`python3 -c "open('o.md','w').write(open('s/a.md').read())"`), 'python read input is not written')
    .eq('', w(`python3 -c "print(open('s/a.md').read())"`), 'python read only')
    .eq('/w/s/a.md', w(`node -e "require('fs').writeFileSync('s/a.md','x')"`), 'node writeFileSync')
    .eq('/w/s/a.md', w(`node -e "require('fs').appendFileSync('s/a.md','x')"`), 'node appendFileSync')
    .eq('/w/o.md', w(`node -e "const f=require('fs'); f.writeFileSync('o.md', f.readFileSync('s/a.md'))"`), 'node read input is not written')
    .eq('', w(`node -e "require('fs').readFileSync('s/a.md')"`), 'node read only')
    .eq('/w/s/a.md', w(`perl -e 'open(my $f, ">", "s/a.md")'`), 'perl -e open >');
s.group("tmb_cmd_write_paths: per statement, in the statement's own dir")
    .eq('/w/skills/a.md', w('cd skills && echo x > a.md'), 'cd applies')
    .eq('/w/skills/a.md', w('cd src && echo x > ../skills/a.md'), '.. normalized')
    .eq('/w/a.md,/w/b.md', w('(cd sub && true) ; echo > a.md; echo > b.md'), 'a subshell cd does not leak')
    .eq('/w/s/a.md', w("bash -c 'echo x > s/a.md'"), 'bash -c body')
    .eq('UNRESOLVED:X:$X/skills/a.md', w('cd "$X" && echo x > skills/a.md'), 'a relative path after cd $X is judged under $X (GH 1595)')
    .eq('skills/a.md', wpaths('cd skills && echo x > a.md'), "no cwd: relative to the caller's dir")
    .eq('', w('cat skills/a.md; grep -r x skills/'), 'reads write nothing');
s.group("tmb_cmd_write_paths: a -C / --prefix dir and a mutating git's tree are written (GH 1508)")
    .eq('/b', w('git -C /b commit -am x'), 'git -C commit')
    .eq('/b', w('git -C /b checkout main'), 'git -C checkout')
    .eq('/b', w('git -C /b stash'), 'git -C stash')
    .eq('/b', w('tar -xzf a.tgz -C /b'), 'tar -C')
    .eq('/b', w('tar --directory=/b -xf a.tar'), 'tar --directory=')
    .eq('/b', w('make -C /b test'), 'make -C')
    .eq('/b', w('env -C /b make'), 'env -C')
    .eq('/b', w('npm --prefix /b install'), 'npm --prefix')
    .eq('/b', w('npm --prefix=/b ci'), 'npm --prefix=')
    .eq('/w', w('git commit -am x'), "git commit: the statement's own dir")
    .eq('/w', w('git reset --hard'), 'git reset --hard')
    .eq('/w', w('git clean -fd'), 'git clean -fd')
    .eq('/w', w('git checkout -- f'), 'git checkout -- f')
    .eq('/w', w('git stash'), 'git stash')
    .eq('/w/sub', w('cd sub && git add -A'), 'a mutating git after cd')
    .eq('/w/sub', w('git -C sub restore f'), 'a relative git -C')
    .eq('/b/t', w('git -C /b --work-tree=t checkout .'), '--work-tree under git -C')
    .eq('/w/a,/w/a/b', w('tar -C a -C b -xf t.tar'), 'tar -C chain composes')
    .eq('/b,/b/f', w("env -C /b sed -i 's/a/b/' f"), "env -C: the dir and the command's paths under it")
    .eq('/b,/b/x', w('env -C /b git -C x commit'), 'env -C then git -C')
    .eq('/b', w("find . -name '*.md' -exec git -C /b add {} +"), 'a mutating git run by find -exec')
    .eq('/b', w('git worktree remove /b'), 'git worktree remove')
    .eq('UNRESOLVED:Y:$Y', w('git -C "$Y" commit -m x'), 'a git -C behind a variable')
    .eq('', w('git -C /a status && git -C /b log && git -C /b diff'), 'status, log, diff write nothing')
    .eq('', w('git stash list; git fetch; git push; git rev-parse HEAD; git ls-files; git branch --list; git worktree list'), 'read-only git and push')
    .eq('', w('git -C /b apply --check p.diff'), 'git apply --check')
    .eq('/b', w('git -C /b apply p.diff'), 'git apply');
s.group('tmb_cmd_write_paths: variables set in the same command (GH 1279)')
    .eq('/etc/x', w('OUT=/etc/x; cat > "$OUT"'), 'a prior statement')
    .eq('/w/o/f', w('D=o && touch "${D}/f"'), "${VAR}, relative to the statement's dir")
    .eq('/e/y', w('export OUT=/e/y && tee "$OUT"'), 'export')
    .eq('/x/y/z', w('A=/x; B="$A/y"; cat > "$B/z"'), 'one level of nesting')
    .eq('/tmp/d', w('cat > "${NOPE:-/tmp}/d"'), '${VAR:-default}: the default branch')
    .eq('/k/d', w('V=/k; cat > "${V:-/tmp}/d"'), '${VAR:-default}: the set value')
    .eq('/w/a.txt,/w/b.txt', w('for f in a.txt b.txt; do sed -i s/x/y/ "$f"; done'), "a for loop's words")
    .eq('/a,/b', w('P=/a; true || P=/b; touch "$P"'), 'every value a variable may hold')
    .eq(`${HOME}/f`, w('touch $HOME/f'), '$HOME from the host')
    .eq(`${HOME}/.bashrc`, w('HOME=/inside cat > "$HOME/.bashrc"'), "a HOME= prefix does not reach its own command's words")
    .eq('/w/out', w('echo x > "$PWD/out"'), '$PWD is the cwd')
    .eq('/w/x/f', w('cd x && echo y > "$PWD/f"'), '$PWD after a cd')
    .eq('/w/s/f', w('cd s; D="$PWD/f"; cd /; echo y > "$D"'), "$PWD in an assignment is that statement's dir")
    .eq('UNRESOLVED:PWD:$PWD/f', w('cd "$X" && echo y > "$PWD/f"'), '$PWD after cd $X is unknown')
    .eq('UNRESOLVED:OUT:$OUT', w('OUT=/etc/x cat > "$OUT"'), "a VAR=value prefix does not reach its own command's words (the shell expands them first)")
    .eq('UNRESOLVED:OUT:$OUT', w('OUT="$(mktemp "$TMPDIR/f.XXXXXX")"; cat > "$OUT"'), 'a $( ) value')
    .eq('UNRESOLVED:OUT:$OUT', w('OUT=`mktemp "$TMPDIR/f.XXXXXX"`; cat > $OUT'), 'a backtick value')
    .eq('UNRESOLVED:UNKNOWN:$UNKNOWN/f', w('cat > "$UNKNOWN/f"'), 'never set')
    .eq('UNRESOLVED:UNKNOWN:/w/sub/$UNKNOWN', w('cat > sub/$UNKNOWN'), 'a relative target keeps its dir')
    .eq('UNRESOLVED:$():$(mktemp $TMPDIR/f.XXXXXX)', w('cat > "$(mktemp "$TMPDIR/f.XXXXXX")"'), 'a $( ) target')
    .eq('UNRESOLVED:f:$f', w('while read -r f; do touch "$f"; done < list'), 'read')
    .eq('/w/out', w('echo $(date) > out'), 'a $( ) outside the target is not a target');
s.group("tmb_cmd_write_paths: $OLDPWD is the dir before the command's last cd (GH 1324)")
    .eq('/w/f', w('cd x && echo y > "$OLDPWD/f"'), 'after cd x, $OLDPWD is the cwd')
    .eq('/w/x/f', w('cd x; cd /r && echo y > "${OLDPWD}/f"'), 'the dir before the most recent cd')
    .eq('/w/f', w('cd x && D="$OLDPWD/f" && cd / && echo y > "$D"'), "in an assignment, that statement's $OLDPWD")
    .eq('UNRESOLVED:OLDPWD:$OLDPWD/f', w('echo y > "$OLDPWD/f"'), 'without a cd it is unknown')
    .eq('/w/x/a,/r/b', w('cd x && cd /r && cd - && echo y > "$PWD/a" && echo z > "$OLDPWD/b"'), 'cd - swaps $PWD and $OLDPWD')
    .eq('UNRESOLVED:OLDPWD:$OLDPWD/f', w('cd x; echo y > "$OLDPWD/f"'), 'a cd not chained with && may have failed')
    .eq('UNRESOLVED:OLDPWD:$OLDPWD/f', w('cd x && true; echo y > "$OLDPWD/f"'), "outside the cd's && chain")
    .eq('/w/f', w('(cd x; cd y); cd z && echo y > "$OLDPWD/f"'), "a subshell's cd does not leak");
s.group('tmb_cmd_write_paths: more mutating git subcommands and output options (GH 1531)')
    .eq('/p', w('git -C /p bisect start'), 'git -C bisect start')
    .eq('', w('git bisect log; git bisect view; git bisect'), 'bisect log / view read')
    .eq('/w', w('git submodule --quiet update --init'), 'submodule update')
    .eq('', w('git submodule status'), 'submodule status reads')
    .eq('/w', w('git sparse-checkout set a'), 'sparse-checkout set')
    .eq('', w('git sparse-checkout list'), 'sparse-checkout list reads')
    .eq('/w', w('git read-tree -m -u HEAD'), 'read-tree -u')
    .eq('', w('git read-tree HEAD'), 'read-tree without -u writes the index only')
    .eq('/etc/o', w('git checkout-index -a --prefix=/etc/o/'), 'checkout-index --prefix')
    .eq('/w', w('git checkout-index -a'), 'checkout-index')
    .eq('/w', w('git mergetool'), 'mergetool')
    .eq('/etc/r', w('git init /etc/r'), 'init <dir>')
    .eq('/w', w('git init'), 'init in its own dir')
    .eq('/etc/g,/w/r', w('git init --separate-git-dir=/etc/g -b main r'), 'init --separate-git-dir')
    .eq('/etc/p', w('git format-patch -o /etc/p HEAD~1'), 'format-patch -o')
    .eq('/etc/q', w('git format-patch --output-directory=/etc/q -1'), 'format-patch --output-directory=')
    .eq('/w', w('git format-patch -1'), 'format-patch into its own dir')
    .eq('', w('git format-patch --stdout -1'), 'format-patch --stdout')
    .eq('/etc/x.tar', w('git archive -o /etc/x.tar HEAD'), 'archive -o')
    .eq('/etc/y.tar', w('git archive --output=/etc/y.tar HEAD'), 'archive --output=')
    .eq('', w('git archive HEAD'), 'archive to stdout');
s.group('tmb_cmd_write_paths: each wrapper skips its own options (GH 1531)')
    .eq('/etc/x', w('sudo -S rm /etc/x'), 'sudo -S takes no value')
    .eq('/w/x', wpaths('sudo -C 5 rm ../x', '/w/a'), 'sudo -C takes an fd number')
    .eq('/b,/b/f', w('sudo -u root -D /b touch f'), 'sudo -D is a dir')
    .eq('/etc/y', w('sudo --user=root -iS rm /etc/y'), 'sudo long option and cluster')
    .eq('/etc/z', w('env -u FOO -i X=1 rm /etc/z'), 'env -u takes a value')
    .eq('/b,/b/f', w('env --chdir=/b touch f'), 'env --chdir=')
    .eq('/etc/t', w('time -p rm /etc/t'), 'time -p')
    .eq('/etc/e', w('exec -a n rm /etc/e'), 'exec -a takes a value')
    .eq('/etc/x,', targets('sudo -S rm /etc/x'), 'write_targets: sudo -S')
    .eq('../x,', targets('sudo -C 5 rm ../x'), 'write_targets: sudo -C')
    .eq('@#rm /etc/x', stmts('sudo -S rm /etc/x', PLAIN), 'statements drop sudo -S', (v) => v.replace(PLAIN, '@'))
    .eq('pr merge', ghs('sudo -u git gh pr merge 1', PLAIN), 'sudo -u <user> gh');
s.group('GH 1595: a relative path after an unresolvable cd is never bare')
    .eq('UNRESOLVED:UNSET:$UNSET/f', w('cd $UNSET && touch f'), 'cd $UNSET && touch f')
    .eq('UNRESOLVED:PWD:$PWD/f', w('cd - && touch f'), 'cd - && touch f')
    .eq('UNRESOLVED:U:$U', w('git -C $U add f'), 'git -C $U add')
    .eq('/b/f', w('D=/b; cd $D && touch f'), 'a literal-set variable resolves');
const P1944 = '/w/a,/etc/p1944';
s.group("GH 1944: a loop body's later assignment reaches an earlier use");
for (const head of ['while :', 'until false', 'for i in 1 2'])
    s.eq(P1944, w(`x=/w/a; ${head}; do echo > $x; x=/etc/p1944; done`), head);
s.eq(P1944, w('x=/w/a; while :; do while :; do echo > $x; done; x=/etc/p1944; done'), 'a nested loop')
    .eq('UNRESOLVED:x:$x', w('x=/w/a; while :; do echo > $x; read -r x; done'), 'an in-body read')
    .eq('UNRESOLVED:x:$x', w('x=/w; while :; do echo > $x; x=$x/a; done'), 'a value that keeps growing')
    .eq('/w/a,/w/b', w('for f in a b; do x=/w/$f; echo > $x; done'), 'a for loop over in-root targets')
    .eq('/w/a', w('x=/w/a; while :; do echo > $x; done'), 'a loop that never reassigns');
for (const c of [
    'x=/w/a; for ((i=0;i<2;i++)) { echo > $x; x=/etc/p1944; }',
    'x=/w/a; for i in 1 2; { echo > $x; x=/etc/p1944; }',
    'x=/w/a; select i in 1 2; { echo > $x; x=/etc/p1944; }',
])
    s.eq(P1944, w(c), `a braced body: ${c}`);
s.eq(P1944, w('x=/w/a; while :; do coproc for i in 1; do :; done; echo > $x; x=/etc/p1944; done'), 'a nested coproc for keeps the outer frame')
    .eq(P1944, w('x=/w/a; coproc while echo > $x; do x=/etc/p1944; done'), 'a coproc while frames its condition')
    .eq(P1944, w('x=/w/a; for i in 1 2; { coproc { :; }; echo > $x; x=/etc/p1944; }'), 'a coproc group closes no braced body')
    .eq(P1944, w('x=/w/a; while for i in 1; do :; done; do echo > $x; x=/etc/p1944; done'), 'a for in a while condition')
    .eq('/w/a,/w/b', w('for f in a b; { x=/w/$f; echo > $x; }'), 'a braced for over in-root targets');
for (const c of [
    'x=/w/a; for i do echo > $x; x=/etc/p1944; done',
    'x=/w/a; select i do echo > $x; x=/etc/p1944; done',
    'x=/w/a; while :; do for i do :; done; echo > $x; x=/etc/p1944; done',
    'x=/w/a; while :; do select i do :; done; echo > $x; x=/etc/p1944; done',
    'x=/w/a; coproc for i do echo > $x; x=/etc/p1944; done',
])
    s.eq(P1944, rootedPaths(c, '/w', '/w', false), `a do inside the header: ${c}`);
s.eq('/w/a', w('x=/w/a; for i in $(for j in 1; do echo; done); do echo > $x; done'), 'a loop in the for list keeps the header waiting');
for (const c of ['x=/w/a; echo > $x; done', 'x=/w/a; echo > $x; }', 'x=/w/a; do echo > $x', 'x=/w/a; while :; do echo > $x', 'x=/w/a; { echo > $x; done; }'])
    s.eq('UNRESOLVED:x:$x', w(c), `unbalanced loop frames fail closed: ${c}`);
s.eq('UNRESOLVED:HOME:$HOME/f1944', w('echo > $HOME/f1944; done'), 'an unbalanced command resolves no variable')
    .eq('UNRESOLVED:x:$x', w('x=/w/a; bash -c "echo > \\$x; done"'), 'an unbalanced bash -c body');
for (const c of [
    'x=/w/a; while :; do echo > $x; "done"; x=/etc/p1944; "while" :; "do" :; done',
    'x=/w/a; while :; do echo > $x; \\done; x=/etc/p1944; \\while :; \\do :; done',
    "x=/w/a; until false; do echo > $x; d''one; x=/etc/p1944; w''hile :; d''o :; done",
    "x=/w/a; while :; do echo > $x; $'done'; x=/etc/p1944; $'while' :; $'do' :; done",
    'x=/w/a; for i in 1 2; do echo > $x; "done"; x=/etc/p1944; "while" :; "do" :; done',
    'x=/w/a; for i in 1 2; { echo > $x; "}"; x=/etc/p1944; "{"; }',
    "x=/w/a; for i in 1 2; { echo > $x; \\}; x=/etc/p1944; '{'; }",
])
    s.eq(P1944, w(c), `a quoted or escaped reserved word is a command word: ${c}`);
s.eq('/w/a,/w/b', w('for f in a b; do x=/w/$f; echo "done" > $x; done'), 'a quoted done argument keeps the for-loop exact')
    .eq('UNRESOLVED:$():/w$()/p', w('echo > /w\x17/p'), 'a literal \\027 byte reads as computed text');
s.group("GH 1977: a loop body's cd reaches an earlier relative write");
for (const head of ['while :', 'until false', 'for i in 1 2'])
    s.eq('/w/f,/etc/f', w(`${head}; do echo > f; cd /etc; done`), head);
s.eq('/w/f,/etc/f', w('while :; do echo > f; pushd /etc; done'), 'a pushd').eq('/w/f,/etc/f', w('for i in 1 2; { echo > f; cd /etc; }'), 'a braced body');
for (const c of ['cd "$d"', 'cd -', 'cd', 'popd'])
    s.eq('/w/f,UNRESOLVED:PWD:$PWD/f', w(`while :; do echo > f; ${c}; done`), `a cd it cannot name fails closed: ${c}`);
s.eq('/w/f,/etc/f', w('while false; do cd /etc; done; echo > f'), "after the loop, the entry dir and the body's")
    .eq('/w/f,/etc/f,/w/g,/etc/g', w('while :; do echo > f; cd /etc; done; echo > g'), 'inside and after the loop')
    .eq('/w/f', w('while :; do echo > f; done'), 'a loop with no cd')
    .eq('/w/f', w('while :; do echo > f; ( cd /etc ); done'), 'a subshell cd stays inside it')
    .eq('/w/f,/etc/f', w('while :; do echo > f; while :; do cd /etc; done; done'), 'a cd in a nested loop')
    .eq('/w/f,/etc/f', w('while :; do while :; do echo > f; done; cd /etc; done'), 'a write in a nested loop')
    .eq('/w/f,/tmp/f', w('while :; do echo > f; cd /etc; cd /tmp; done'), 'the dir a pass ends in')
    .eq('/w/a,/w/b,/etc/a,/etc/b', w('for f in a b; do echo > $f; cd /etc; done'), 'a loop variable in each dir')
    .eq('/w/f,/etc/f', w('while :; do bash -c "echo > f"; cd /etc; done'), 'a bash -c body')
    .eq('/w/f,/etc/f', w(`while :; do python3 -c "open('f','w')"; cd /etc; done`), 'an inline program')
    .eq('UNRESOLVED:PWD:$PWD/f', w('while :; do echo > f; cd sub; done'), 'a dir that keeps growing fails closed', (v) => lastField(v, ','))
    .eq('/w/f,/f', w('cd /w; while :; do echo > f; cd ..; done'), 'cd .. stops at the root, so the dirs stop growing');
const boundedUnresolved = (c) => ({
    ts: async () => String((await writePaths(c, { cwd: '/w', root: '/w' })).some((l) => l.startsWith('UNRESOLVED:')) ? 0 : 1),
});
const absLoops = (n) => `${Array.from({ length: n }, (_, i) => `while false; do cd /a${i + 1}; done; `).join('')}echo > f`;
s.group('GH 1977 (F210-1): a drifting loop-body cd stays bounded and fails closed');
for (const c of [
    'while :; do echo > f1; cd d1; done; while :; do echo > f2; cd d2; done; while :; do echo > f3; cd d3; done; while :; do echo > f4; cd d4; done; echo > g',
    'while :; do cd n1; while :; do cd n2; echo > g; done; done',
])
    s.eq('0', boundedUnresolved(c), `within 10 s and UNRESOLVED: ${c}`);
s.eq('UNRESOLVED:PWD:$PWD/f1,UNRESOLVED:PWD:$PWD/f2,UNRESOLVED:PWD:$PWD/f3,UNRESOLVED:PWD:$PWD/f4,UNRESOLVED:PWD:$PWD/g', w('while :; do echo > f1; cd d1; done; while :; do echo > f2; cd d2; done; while :; do echo > f3; cd d3; done; while :; do echo > f4; cd d4; done; echo > g'), '4 sequential drifting loops')
    .eq('UNRESOLVED:PWD:$PWD/g', w('while :; do cd n1; while :; do cd n2; while :; do cd n3; echo > g; done; done; done'), '3 nested drifting loops')
    .eq('/w/f,/a1/f,/a2/f,/a3/f,/a4/f,/a5/f,/a6/f,/a7/f', w(absLoops(7)), '8 dirs resolve exactly')
    .eq('UNRESOLVED:PWD:$PWD/f,/a8/f', w(absLoops(8)), 'a 9th dir collapses the set to unresolved');
runSuite('tmb_cmd_write_paths on shell commands (GH 1692)', s);
//# sourceMappingURL=cmd-analysis-l3-write-paths.test.js.map