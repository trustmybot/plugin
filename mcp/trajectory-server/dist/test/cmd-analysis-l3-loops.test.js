/**
 * tmb_cmd_write_paths on loops and listings under a root (GH 1692), ported
 * from the bash cmd-analysis l3 test:
 * loop variables bound by an in-root source and the prompt-surface dirs they
 * reach (GH 1324), and find -exec / -delete, fd -x and xargs (GH 1338). Each
 * case is judged on the frozen answers of the shell lib and on writePaths of
 * the TS module, except a command recorded in divergences.jsonl, which is
 * judged on the frozen answer only.
 */
import { after } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Suite, rootedPaths, runSuite, wpaths } from './cmd-analysis-l3.js';
const LT = mkdtempSync(join(tmpdir(), 'tmb-cmd-analysis.'));
const LR = realpathSync(LT);
mkdirSync(join(LR, 'tests'));
mkdirSync(join(LR, 'a'));
after(() => rmSync(LR, { recursive: true, force: true }));
const L = (cmd, cwd = LR) => rootedPaths(cmd, cwd, LR);
const mapProbe = (p, f) => (p.ts ? { ts: async () => f(await p.ts()) } : {});
const comma = (p) => mapProbe(p, (v) => `,${v},`);
const loop = (src) => `for f in $(${src}); do sed -i s/a/b/ "$f"; done`;
const s = new Suite('loops').token('<LT>', LT).token('<LR>', LR).token('<LR_PARENT>', dirname(LR));
s.group('tmb_cmd_write_paths: loop variables bounded by an in-root source (GH 1324)')
    .eq('@/tests/*.sh', L(`for f in ${LR}/tests/*.sh; do sed -i 's/a/b/' "$f"; done`), 'an in-root glob')
    .eq('@/tests/*.sh', L(`for f in tests/*.sh; do sed -i 's/a/b/' "$f"; done`), 'a relative glob')
    .eq('@,@/*', L(`for f in $(find ${LR} -name '*.sh'); do sed -i 's/a/b/' "$f"; done`), '$(find <root> -name …): the start point and everything under it')
    .eq('@/*', L(`for f in $(git -C ${LR} ls-files); do sed -i 's/a/b/' "$f"; done`), '$(git -C <root> ls-files)')
    .eq('@/*', L('for f in $(git diff --name-only HEAD~1); do sed -i s/a/b/ "$f"; done'), '$(git diff --name-only)')
    .eq('@/tests,@/tests/*', L(`for f in $(rg --files ${LR}/tests); do printf x >> "$f"; done`), '$(rg --files <root>/tests)')
    .eq('@/a,@/a/*', L('for f in $(fd -e sh . a); do printf x >> "$f"; done'), '$(fd <pattern> <path>)')
    .eq('@,@/*,@/*.md', L(`while read f; do sed -i s/a/b/ "$f"; done < <(find ${LR} -name '*.md')`), 'while read … done < <(find <root> …)')
    .eq('@/..bak,@/*.bak,@/*.md.bak', L(`find . -name '*.md' | while IFS= read -r f; do cp "$f" "$f.bak"; done`), 'find … | while read; the $f.bak suffix form')
    .eq('@/tests.out,@/tests/*.out', L(`for f in $(find tests -name '*.sh'); do echo > "\${f%.sh}.out"; done`), 'the ${f%.sh}.out suffix form')
    .eq('@/a/x,@/a/*/x', L('for f in $(find a -type d 2>/dev/null); do echo > "$f/x"; done'), 'a $f/… suffix; 2>/dev/null on the source', (v) => v
    .split(',')
    .filter((x) => !x.includes('/dev/null'))
    .join(','))
    .eq('@/tests/*,@/tests/*/*', L(`for d in ${LR}/tests/*; do for f in $(find "$d" -name x); do rm "$f"; done; done`), 'nested loops compose')
    .eq('/etc,/etc/*', L('for f in $(find . -name x); do (cd /etc && rm "$f"); done'), 'relative names are judged where they are used');
s.group('tmb_cmd_write_paths: a listed path itself is bound, so .. and suffixes leave the root (GH 1324)')
    .eq(`${dirname(LR)}/f,@/f`, L(`for d in $(find ${LR} -type d); do echo x > "$d/../f"; done`), '$d/../f from find <root>')
    .eq('@.bak,@/*.bak', L(`for f in $(find ${LR} -maxdepth 0); do cp x "$f.bak"; done`), '$f.bak of the start point')
    .eq(`${dirname(LR)},@`, L(`for f in $(find ${LR} -name '*'); do rm -rf "$f/.."; done`), '$f/.. of the start point');
s.group('tmb_cmd_write_paths: a bound source under a prompt-surface dir reaches the surface rule (GH 1324)')
    .step(() => {
    mkdirSync(join(LR, 'agents'));
    mkdirSync(join(LR, 'skills'));
})
    .has(L(loop(`find ${LR}/agents -name '*.md'`)), '@/agents/*.md', 'find <root>/agents')
    .has(L(loop("find agents -name '*.md'")), '@/agents/*.md', 'relative find agents')
    .has(L(`find ${LR}/agents -name '*.md' | while read f; do printf x >> "$f"; done`), '@/agents/*.md', 'find <root>/agents | while read')
    .has(L(loop('git ls-files skills')), '@/skills/*.md', 'git ls-files skills')
    .has(L(loop('find . -name CLAUDE.md')), '@/CLAUDE.md', 'a -name pattern naming CLAUDE.md');
s.group("tmb_cmd_write_paths: a recursive listing above the root's prompt-surface dirs reaches them (GH 1324)")
    .step(() => writeFileSync(join(LR, 'CLAUDE.md'), ''))
    .eq('@/agents/*.md,@/skills/*.md,@/CLAUDE.md,@,@/*,@/*.md', L(loop(`find ${LR} -name '*.md'`)), "find <root> -name '*.md'")
    .eq('@,@/*', L(loop(`find ${LR} -name '*.sh'`)), 'a pattern that cannot match a surface file')
    .eq('@/tests,@/tests/*,@/tests/*.md', L(loop(`find ${LR}/tests -name '*.md'`)), 'a listing below the surface dirs')
    .eq('@,@/*,@/*.md', L(loop(`find ${LR} -name '*.md' -not -path '*/agents/*' -not -path '*/skills/*' -not -path '*/commands/*' -not -path '*/templates/*' -not -name CLAUDE.md`)), '-not -path exclusions')
    .eq('@,@/*,@/*.md', L(loop("find . -path ./agents -prune -o -path ./skills -prune -o -path ./CLAUDE.md -prune -o -name '*.md' -print")), '-path … -prune exclusions')
    .has(L(loop(`find ${LR} -name '*.md' -o -not -path '*/agents/*'`)), '@/agents/*.md', 'a -not -path in an -o branch excludes nothing')
    .eq('@/*,@/agents/*.md,@/skills/*.md,@/CLAUDE.md', L(loop('git ls-files')), 'git ls-files at the root')
    .eq('@/*', L(loop('git ls-files tests')), 'git ls-files tests')
    .eq('@/*', L(loop("git ls-files ':!agents' ':!skills' ':!CLAUDE.md'")), ':! pathspec exclusions')
    .eq('@,@/*', L(loop("rg --files --glob '!agents/**' --glob '!skills/**' -g '!CLAUDE.md'")), "--glob '!…' exclusions")
    .step(() => rmSync(join(LR, 'CLAUDE.md')));
s.group('tmb_cmd_write_paths: case-insensitive patterns and partial exclusions still reach the surface (GH 1324)').step(() => mkdirSync(join(LR, 'commands')));
for (const src of [
    `find ${LR} -iname '*.MD'`,
    `find ${LR} -iname 'skill.md'`,
    `rg --files ${LR} --iglob '*.MD'`,
    `rg --files ${LR} -g '*.MD' --glob-case-insensitive`,
    `find ${LR} -name '*.md' ! -path '*/agents'`,
    `find ${LR} -name '*.md' -not -name 'agents*'`,
    `find ${LR} -name '*.md' -not -path '*/agents/zzz/*'`,
    `find ${LR} -path '*/agents/zzz' -prune -o -name '*.md' -print`,
    "git ls-files ':!agents/zzz'",
    `fd -E agents/zzz md ${LR}`,
])
    s.has(L(loop(src)), src.includes('skill.md') ? '@/skills/*.md' : '@/agents/*.md', src);
for (const src of [
    `find ${LR} -name '*.md' -not -path '*/agents/*' -not -path '*/skills/**' -not -path '*/commands/*'`,
    `find ${LR} -path '*/agents' -prune -o -path ${LR}/skills -prune -o -path '*/commands' -prune -o -name '*.md' -print`,
    "git ls-files ':!agents' ':^skills' ':(exclude)commands'",
    `fd -E agents -E skills -E commands md ${LR}`,
    `rg --files ${LR} --glob '!agents/**' --glob '!skills' --glob '!commands/**'`,
])
    for (const d of ['agents', 'skills', 'commands'])
        s.lacks(L(loop(src)), `@/${d}/*.md`, `${src} leaves out ${d}`);
const U = 'UNRESOLVED:f:$f';
s.group('tmb_cmd_write_paths: loop variables from any other source stay unresolvable (GH 1324)')
    .eq(U, L('for f in $(find /etc -name x); do rm "$f"; done'), '$(find /etc …)')
    .eq(U, L('for f in $(find -- /etc -name x); do rm "$f"; done'), '$(find -- /etc …): -- ends the options')
    .eq(U, L('for f in $(find .. -name x); do rm "$f"; done'), '$(find ..) climbs out of the root')
    .eq(U, L('for f in $(cat list.txt); do rm "$f"; done'), '$(cat list.txt)')
    .eq(U, L('for f in $(curl -s https://x); do rm "$f"; done'), '$(curl …)')
    .eq(U, L(`for f in $(find . -printf '/etc/%f'); do rm "$f"; done`), 'find -printf writes its own text')
    .eq(U, L('for f in $(find . | grep x); do rm "$f"; done'), 'a pipeline source')
    .eq(U, L('for f in $(find .) /etc/x; do rm "$f"; done'), 'more words after the $( )')
    .eq(U, L('for f in $(git -C /etc ls-files); do rm "$f"; done'), 'git -C outside the root')
    .eq(U, L('for f in $(find $SRC); do rm "$f"; done'), 'a variable source')
    .eq(U, L('while read -r f; do touch "$f"; done < list'), 'read from a file')
    .eq(U, L('cat list | while read f; do rm "$f"; done'), 'cat list | while read')
    .eq(U, L('find /etc | while read f; do rm "$f"; done'), 'find /etc | while read')
    .eq(U, wpaths(`for f in $(find ${LR}); do rm "$f"; done`, LR), 'no root given');
s.group('tmb_cmd_write_paths: find -exec / -delete, fd -x and xargs write the listed paths (GH 1338)').eq('@,@/*', L(`find ${LR} -name x -exec rm {} \\;`), 'find <root> -name x -exec rm {} \\;');
for (const cmd of [
    `find ${LR} -delete`,
    `find ${LR} -print0 | xargs -0 rm`,
    'fd -e md -x sed -i s/a/b/ {}',
    `find ${LR} -exec sed -i s/a/b/ {} +`,
    `find ${LR} -execdir rm {} ';'`,
    `find ${LR} -ok rm {} \\;`,
    `fd . ${LR} -X rm`,
])
    s.has(comma(L(cmd)), ',@,', `${cmd}: the start path`).has(comma(L(cmd)), ',@/*,', `${cmd}: everything under it`);
s.eq('@/a.bak,@/a/*.bak,@/a,@/a/*', L('find a -name x -exec mv {} {}.bak \\;'), 'mv {} {}.bak: destination and the removed source')
    .eq('@/a.bak,@/a/*.bak', L('find a | xargs -I X cp X X.bak'), 'xargs -I X')
    .eq('@/a,@/a/*', L('fd x a -x rm'), 'fd -x with no placeholder appends {}')
    .eq('@/out.txt,@/f2,@/f3', L("find a -fprint out.txt -fprintf f2 '%p' -fls f3"), '-fprint / -fprintf / -fls write their file')
    .has(L("find agents -name '*.md' -exec sed -i s/a/b/ {} \\;"), '@/agents/*.md', 'find agents -exec: the prompt-surface rule applies')
    .has(L(`find ${LR} -name '*.sh' -o -exec sed -i s/a/b/ {} \\;`), '@/agents/*.md', 'an -o: the action runs on what -name does not match');
s.group('tmb_cmd_write_paths: read-only find and fd forms write nothing (GH 1338)');
for (const cmd of [
    `find ${LR} -name '*.sh' -print`,
    'find a -type f -newer x -ls',
    "find a -printf '%p'",
    'find a -exec grep -l x {} \\;',
    'find /etc -name x',
    'fd -e md . a',
    'find a | xargs grep x',
    'find a -executable -print',
])
    s.eq('', L(cmd), cmd);
s.group('tmb_cmd_write_paths: find, fd and xargs over an unbound source stay unresolvable (GH 1338)');
for (const cmd of ['find / -exec rm {} \\;', 'find $HOME -delete', 'find .. -delete', 'find $SRC -exec rm {} +', `find -L ${LR} -exec rm {} \\;`])
    s.eq('UNRESOLVED:find_path:${find_path}', L(cmd), cmd);
s.eq('UNRESOLVED:fd_path:${fd_path}', L('fd x /etc -x rm'), 'fd x /etc -x rm');
for (const cmd of ['find / -print0 | xargs -0 rm', 'cat list | xargs rm', 'xargs rm < list', 'find a -print0 | xargs -0 -a list rm', 'find a | grep x | xargs rm'])
    s.eq('UNRESOLVED:xargs_arg:${xargs_arg}', L(cmd), cmd);
s.eq('UNRESOLVED:find_path:${find_path}', wpaths(`find ${LR} -delete`, LR), 'no root given');
runSuite('tmb_cmd_write_paths on loops and listings under a root (GH 1692)', s);
//# sourceMappingURL=cmd-analysis-l3-loops.test.js.map