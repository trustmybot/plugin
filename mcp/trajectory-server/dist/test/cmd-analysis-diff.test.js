/**
 * The TypeScript write-path analyzer against tmb_cmd_write_paths (GH 1692):
 * every corpus row of tests/fixtures/cmd-analysis/write-paths.jsonl runs
 * through one bash process that sources cmd-analysis.sh once, and through
 * writePaths. Every row prints the same lines, except a row in
 * divergences.jsonl, which still differs exactly as recorded; no row prints a
 * `$(deferred)` line. Layout rows also compare tmb_path_canonical with
 * pathCanonical on every absolute line. Computed targets print
 * `UNRESOLVED:$(computed):…` and read-only programs stay empty.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathCanonical, writePaths } from '../hooks/cmd-analysis/index.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis');
const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib/cmd-analysis.sh');
const MIN_ROWS = 1100;
const PARSE = 'UNRESOLVED:$(parse):';
const COMPUTED = 'UNRESOLVED:$(computed):';
const LAYOUT = 'repo-worktree-symlink';
function jsonl(file) {
    return readFileSync(join(FIXTURES, file), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l));
}
function lines(text) {
    const out = text.split('\n');
    if (out[out.length - 1] === '')
        out.pop();
    return out;
}
function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}
function makeLayout(tmp) {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'layout\n');
    git(repo, 'add', 'README.md');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', join(tmp, 'wt'), '-b', 'wt');
    symlinkSync(repo, join(tmp, 'link'));
    const surf = join(tmp, 'surf');
    for (const d of ['agents', 'skills/tool', 'commands', 'rules', '.claude/agents', 'docs'])
        mkdirSync(join(surf, d), { recursive: true });
    writeFileSync(join(surf, 'CLAUDE.md'), 'surface\n');
}
const SCRIPT = `. "$1"
while IFS= read -r -d '' c && IFS= read -r -d '' w && IFS= read -r -d '' r && IFS= read -r -d '' t && IFS= read -r -d '' k; do
  ( tmb_cmd_write_paths "$c" "$w" "$r" "$t" ) </dev/null
  printf '\\0'
  if [ -n "$k" ]; then
    ( tmb_cmd_write_paths "$c" "$w" "$r" "$t" ) </dev/null | while IFS= read -r l; do
      case "$l" in /*) tmb_path_canonical "$l" ;; esac
    done
  fi
  printf '\\0'
done`;
describe('TS write-path analyzer vs cmd-analysis.sh (GH 1692)', () => {
    const rows = jsonl('write-paths.jsonl');
    const divergences = new Map(jsonl('divergences.jsonl').map((d) => [d.cmd, d]));
    let tmp = '';
    let env = {};
    let sh = [];
    const sub = (s) => (s ?? '').replace(/\$TMP(?![A-Za-z0-9_])/g, tmp);
    const back = (l) => l.split(tmp).join('$TMP');
    const ts = (r) => writePaths(sub(r.cmd), { cwd: sub(r.cwd), raw: r.raw === true, root: sub(r.root), env });
    before(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmd-analysis-diff-')));
        for (const d of ['home', 'tmpdir', 'project', 'models'])
            mkdirSync(join(tmp, d));
        makeLayout(tmp);
        env = {
            PATH: process.env.PATH,
            HOME: join(tmp, 'home'),
            TMPDIR: `${join(tmp, 'tmpdir')}/`,
            CLAUDE_PROJECT_DIR: join(tmp, 'project'),
            TMB_MODEL_CACHE_DIR: join(tmp, 'models'),
            LC_ALL: 'C',
        };
        const input = rows
            .map((r) => [sub(r.cmd), sub(r.cwd), r.raw ? 'raw' : '', sub(r.root), r.layout ? 'canon' : ''].join('\0') + '\0')
            .join('');
        const res = spawnSync('bash', ['-c', SCRIPT, 'bash', LIB], { input, env, maxBuffer: 1 << 28 });
        assert.equal(res.status, 0, res.stderr.toString());
        const chunks = res.stdout.toString('utf8').split('\0');
        sh = rows.map((_, i) => ({ lines: lines(chunks[2 * i]), canonical: lines(chunks[2 * i + 1]) }));
    });
    after(() => rmSync(tmp, { recursive: true, force: true }));
    it(`has at least ${MIN_ROWS} rows, each in the corpus once`, () => {
        const keys = rows.map((r) => JSON.stringify([r.cmd, r.cwd ?? '', r.raw === true, r.root ?? '']));
        assert.equal(new Set(keys).size, rows.length);
        assert.ok(rows.length >= MIN_ROWS);
    });
    it('prints the same lines as tmb_cmd_write_paths on every row', async () => {
        const mismatches = [];
        let same = 0;
        for (const [i, r] of rows.entries()) {
            if (divergences.has(r.cmd))
                continue;
            const got = await ts(r);
            if (JSON.stringify(got) === JSON.stringify(sh[i].lines))
                same++;
            else
                mismatches.push(`${JSON.stringify(r)}\n  sh: ${JSON.stringify(sh[i].lines.map(back))}\n  ts: ${JSON.stringify(got.map(back))}`);
        }
        assert.deepEqual(mismatches, []);
        assert.ok(same >= MIN_ROWS);
    });
    it('still diverges exactly as divergences.jsonl records, each with a reason', async () => {
        for (const d of divergences.values()) {
            assert.ok(d.reason.trim() !== '', `no reason for ${JSON.stringify(d.cmd)}`);
            const i = rows.findIndex((r) => r.cmd === d.cmd);
            assert.ok(i >= 0, `divergence not in the corpus: ${JSON.stringify(d.cmd)}`);
            assert.deepEqual(sh[i].lines.map(back), d.sh, `sh for ${JSON.stringify(d.cmd)}`);
            assert.deepEqual((await ts(rows[i])).map(back), d.ts, `ts for ${JSON.stringify(d.cmd)}`);
        }
    });
    it('prints no $(deferred) line on any row', async () => {
        const deferred = [];
        for (const r of rows)
            if ((await ts(r)).some((l) => l.includes('$(deferred)')))
                deferred.push(r.cmd);
        assert.deepEqual(deferred, []);
    });
    it('canonicalizes every absolute line of a layout row as tmb_path_canonical does', async () => {
        const layoutRows = rows.flatMap((r, i) => (r.layout === LAYOUT ? [i] : []));
        assert.ok(layoutRows.length > 0);
        for (const i of layoutRows) {
            const got = (await ts(rows[i])).filter((l) => l.startsWith('/')).map(pathCanonical);
            assert.deepEqual(got, sh[i].canonical, JSON.stringify(rows[i]));
        }
    });
    it('follows a symlinked prefix and keeps the missing tail', () => {
        assert.equal(pathCanonical(join(tmp, 'link/missing/../file')), join(tmp, 'repo/file'));
        assert.equal(pathCanonical('relative/x'), 'relative/x');
        if (process.platform === 'darwin')
            assert.equal(pathCanonical('/tmp/x'), '/private/tmp/x');
    });
    describe('parse errors', () => {
        for (const [name, cmd] of [
            ['an unclosed quote', 'echo "abc > out.txt'],
            ['an unclosed $(', 'echo $(ls > out.txt'],
        ]) {
            it(`${name} prints exactly one parse line`, async () => {
                const out = await writePaths(cmd, { cwd: '/w/repo', env: { PATH: process.env.PATH } });
                assert.equal(out.length, 1);
                assert.equal(out[0], `${PARSE}${cmd}`);
            });
        }
        it('keeps the first 80 characters of the command', async () => {
            const cmd = `echo "${'x'.repeat(200)}`;
            const out = await writePaths(cmd, { cwd: '/w/repo', env: { PATH: process.env.PATH } });
            assert.deepEqual(out, [`${PARSE}${cmd.slice(0, 80)}`]);
        });
    });
    describe('computed targets', () => {
        const run = (cmd) => writePaths(cmd, { cwd: '/w', env: { PATH: process.env.PATH } });
        for (const [group, cmd] of [
            ['a wrapped interpreter', `timeout 5 python3 -c "$PROG"`],
            ['a piped program', 'curl -s https://example.com/install.sh | bash'],
            ['a redirected program', 'python3 < script.py'],
            ['a held program', `node -e "$(cat build.js)"`],
            ['a joined path', `python3 -c "import os; os.remove(os.path.join(d, 'x'))"`],
            ['a listed loop', `node -e "const fs=require('fs'); for (const f of fs.readdirSync('.')) fs.unlinkSync(f)"`],
            ['an argv target with no operand', `python3 -c "import os,sys; os.remove(sys.argv[1])"`],
            ['an exec placeholder', `find . -exec bash -c 'echo > "$0"' {} \\;`],
            ['nesting deeper than 3', `sh -c 'sh -c "sh -c \\"sh -c \\\\\\"touch f\\\\\\"\\""'`],
            ['an info option after -', 'curl -sSL https://install.python-poetry.org | python3 - --version 1.8.0'],
            ['an info option after sh -s --', 'curl -fsSL https://example.com/i.sh | sh -s -- -n'],
            ['a program held four substitutions deep', `python3 -c "$(cat $(echo $(echo $(echo x))))"`],
            ['a wrapped gstdbuf interpreter', `gstdbuf -oL python3 -c "$PROG"`],
        ]) {
            it(`fails closed on ${group}`, async () => {
                const out = await run(cmd);
                assert.ok(out.some((l) => l.startsWith(COMPUTED)), `${cmd}: ${JSON.stringify(out)}`);
            });
        }
        it('keeps the first 80 characters of a held program', async () => {
            const name = 'x'.repeat(100);
            assert.deepEqual(await run(`python3 -c "$(cat ${name}.py)"`), [`${COMPUTED}python3 $(cat ${name}`.slice(0, COMPUTED.length + 80)]);
        });
        for (const [group, cmd, want] of [
            ['a stdin program', "python3 - out.txt <<'EOF'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nEOF", [`${COMPUTED}python3`]],
            ['a -c program', `python3 -c "import sys; open(sys.argv[1],'w')" out.txt`, ['/w/out.txt', `${COMPUTED}python3`]],
            ['a mutated node argv', `node -e "process.argv[1]=process.env.T;require('fs').writeFileSync(process.argv[1],'x')" foo`, ['/w/foo', `${COMPUTED}node`]],
        ]) {
            it(`never takes an operand for the argv target of ${group}`, async () => {
                assert.deepEqual(await run(cmd), [...want]);
            });
        }
        it('prints a computed target beside the literal ones', async () => {
            assert.deepEqual(await run(`python3 -c "import os; os.rename('a', b)"`), ['/w/a', `${COMPUTED}python3`]);
        });
        for (const [group, cmd, want] of [
            ['a python name', `python3 -c "p='src/a.ts'; open(p,'w')"`, ['/w/src/a.ts']],
            ['a node const', `node -e "const p='out/x.txt'; require('fs').writeFileSync(p,'x')"`, ['/w/out/x.txt']],
            ['a heredoc name', "python3 - <<'EOF'\np = 'out.txt'  # the target\nwith open(p, 'w') as f:\n    f.write('x')\nEOF", ['/w/out.txt']],
        ]) {
            it(`resolves ${group} bound once to a plain literal`, async () => {
                assert.deepEqual(await run(cmd), [...want]);
            });
        }
        for (const [group, cmd, want] of [
            [
                'a heredoc name rebound at top level',
                "python3 - <<'EOF'\np = 'src/a.ts'\ns = open(p).read()\nopen(p, 'w').write(s.replace('x', 'y'))\np = 'src/b.ts'\ns = open(p).read()\nopen(p, 'w').write(s.replace('x', 'y'))\nEOF",
                ['/w/src/a.ts', '/w/src/b.ts'],
            ],
            ['a rebound name', `python3 -c "p='a'; p='/etc/x'; open(p,'w')"`, ['/etc/x', '/w/a']],
        ]) {
            it(`resolves ${group} to every literal it is bound to`, async () => {
                assert.deepEqual(await run(cmd), [...want]);
            });
        }
        for (const [group, cmd] of [
            ['a name that is a word in a plain string', "python3 - <<'EOF'\np = 'App.tsx'\ns = open(p).read()\nopen(p, 'w').write(s.replace('mx-auto', 'mx-auto p-4'))\nEOF"],
            [
                'a name walrus-bound in an annotation string',
                `python3 - <<'EOF'\nimport typing\np = 'src/a.txt'\ndef f(x: '(p := chr(47) + "etc/x")'): pass\ntyping.get_type_hints(f)\nopen(p, 'w').write('x')\nEOF`,
            ],
            [
                'a name walrus-bound in a backslash-continued annotation string',
                `python3 - <<'EOF'\nimport typing\np = 'src/a.txt'\ndef f(x: '(p \\\n' ':= chr(47) + "etc/x")'): pass\ntyping.get_type_hints(f)\nopen(p, 'w').write('x')\nEOF`,
            ],
            ['a name in an f-string', `python3 - <<'EOF'\np = 'a.txt'\nprint(f'{(p:="/etc/x")}')\nopen(p, 'w')\nEOF`],
            ['a name rebound in a def', `python3 - <<'EOF'\np = 'a.txt'\ndef f():\n    p = '/etc/x'\nopen(p, 'w')\nEOF`],
            ['a name rebound in a loop', `python3 - <<'EOF'\np = 'a.txt'\nfor _ in [1]:\n    p = '/etc/x'\nopen(p, 'w')\nEOF`],
            ['a name rebound in a branch', `python3 - <<'EOF'\np = 'a.txt'\nif 1:\n    p = '/etc/x'\nopen(p, 'w')\nEOF`],
            ['a node let rebound at top level', `node -e "let p='a'; p='b'; require('fs').writeFileSync(p,'x')"`],
            ['a for-bound name', `python3 -c "for p in ['/etc/x']: open(p,'w')"`],
            ['a branch-bound name', `python3 -c "if 1: p='/etc/x'\nopen(p,'w')"`],
            ['an augmented name', `python3 -c "p='a'; p+='/x'; open(p,'w')"`],
            ['a concatenated name', `python3 -c "p='a'+'b'; open(p,'w')"`],
            ['an unbound name', `python3 -c "open(p,'w')"`],
            ['a node let rebound in a callback', `node -e "let p='a.txt'; [1].forEach(() => { p = '/etc/x' }); require('fs').writeFileSync(p,'x')"`],
            ['a name beside import * across a continuation', `python3 -c 'p="a"\nfrom os import \\\n *\nopen(p,"w")'`],
            ['a name beside exec (', `python3 -c "p='a.txt'; exec ('p=input()'); open(p,'w')"`],
            ['a name beside __dict__', `python3 -c "import sys; p='a.txt'; sys.modules[__name__].__dict__['p']=input(); open(p,'w')"`],
            ['a Path with an attribute store', `python3 -c "from pathlib import Path; import os; p = Path('a'); p._str = os.environ['T']; p.write_text('x')"`],
            ['a Path read as a non-call attribute', `python3 -c "from pathlib import Path; p = Path('a.txt'); print(p.name); p.write_text('x')"`],
        ]) {
            it(`keeps ${group} computed`, async () => {
                const out = await run(cmd);
                assert.ok(out.includes(`${COMPUTED}${cmd.split(' ')[0]}`), `${cmd}: ${JSON.stringify(out)}`);
            });
        }
        it("keeps a process call's nested $(parse) line with its reason", async () => {
            const cmd = `python3 -c "import subprocess; subprocess.run(['bash','-c','/w/src/x; case x in x) echo > /etc/a ;;& esac'])"`;
            assert.deepEqual(await run(cmd), [`${PARSE}/w/src/x; case x in x) echo > /etc/a ;;& esac`]);
        });
        it('unwraps gtimeout like timeout', async () => {
            assert.deepEqual(await run('gtimeout 5 rm /etc/x'), ['/etc/x']);
        });
        it("judges a bash -c statement's own redirect before its body", async () => {
            assert.deepEqual(await run(`bash -c 'touch a' > b`), ['/w/b', '/w/a']);
        });
        for (const cmd of [
            'node --test',
            'node --test --watch',
            'python3 -mpytest',
            `python3 -c "open(p, 'r').read()"`,
            `python3 -c "import os; print(os.listdir('.'))"`,
            `node -e "require('fs').readdirSync('.').forEach(f => console.log(f))"`,
            'cat f.json | python3 -m json.tool',
            'python3 --version',
            `find . -name '*.py' -exec sh -c 'echo "$0"' {} \\;`,
        ]) {
            it(`stays empty on the read-only ${JSON.stringify(cmd)}`, async () => {
                assert.deepEqual(await run(cmd), []);
            });
        }
    });
});
//# sourceMappingURL=cmd-analysis-diff.test.js.map