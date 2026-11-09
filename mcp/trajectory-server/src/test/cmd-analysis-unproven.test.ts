/**
 * Unproven programs fail closed (GH 1739): every row of
 * tests/fixtures/cmd-analysis/unproven-probes.jsonl and of
 * unproven-review-probes.jsonl (the bypasses review found) runs through
 * writePaths with cwd and root /w. A fail_closed row prints an `UNRESOLVED:` line, its
 * danger path, or a path outside /w; an empty row prints nothing; a resolves
 * row prints exactly its paths. A proven python program that writes through
 * a resolved name lists only what the name holds; every shape the prover does
 * not admit, and every write call with a `*` / `**` argument, still fails
 * closed (GH 1723).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePaths } from '../hooks/cmd-analysis/index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis');
const PROBE_FILES = ['unproven-probes.jsonl', 'unproven-review-probes.jsonl'];

interface Probe {
  src: string;
  cmd: string;
  expect: 'fail_closed' | 'empty' | 'resolves';
  danger?: string;
  paths?: string[];
}

const probes: Probe[] = PROBE_FILES.flatMap((f) =>
  readFileSync(join(FIXTURES, f), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Probe),
);

const outside = (l: string): boolean => l.startsWith('/') && l !== '/w' && !l.startsWith('/w/');

describe('unproven programs fail closed (GH 1739)', () => {
  it('has every expectation kind', () => {
    assert.deepEqual([...new Set(probes.map((p) => p.expect))].sort(), ['empty', 'fail_closed', 'resolves']);
  });

  for (const [i, p] of probes.entries()) {
    it(`${p.expect} #${i + 1} (${p.src}): ${JSON.stringify(p.cmd).slice(0, 100)}`, async () => {
      const out = await writePaths(p.cmd, { cwd: '/w', root: '/w', env: { HOME: '/h' } });
      if (p.expect === 'empty') assert.deepEqual(out, []);
      else if (p.expect === 'resolves') assert.deepEqual(out, p.paths);
      else
        assert.ok(
          out.some((l) => l.startsWith('UNRESOLVED:') || l === p.danger || outside(l)),
          `not fail closed: ${JSON.stringify(out)}`,
        );
    });
  }
});

describe('GH 1723: a proven program writing through a name has only that name as its target', () => {
  const run = (cmd: string): Promise<string[]> => writePaths(cmd, { cwd: '/w', root: '/w', env: { HOME: '/h' } });
  const replace = "p='docs/a.md'; s=open(p).read().replace('~/.jobduck','{{home}}'); open(p,'w').write(s)";
  const unproven = (out: string[]): boolean => out.some((l) => l.startsWith('UNRESOLVED:$(unproven):'));

  for (const [label, cmd] of [
    ['(a) a stdin heredoc with a ~/ replace argument', `python3 - <<'EOF'\n${replace}\nEOF`],
    ['(b) python3 -c with a ~/ replace argument', `python3 -c "${replace}"`],
    ['(c) a ~/ re.sub pattern with a string repl', `python3 -c "import re; p='docs/a.md'; s=re.sub(r'~/\\.jobduck','x',open(p).read()); open(p,'w').write(s)"`],
    ['(d) a ~/ literal held in a name that is only written as content', `python3 -c "p='docs/a.md'; q='~/.jobduck'; open(p,'w').write(q)"`],
  ]) {
    it(`GH 1723 ${label} lists only the written path`, async () => {
      assert.deepEqual(await run(cmd), ['/w/docs/a.md']);
    });
  }

  it('GH 1723 a name bound to a ~/ literal and written still lists it', async () => {
    assert.deepEqual(await run(`python3 -c "p='~/.jobduck'; open(p,'w').write('x')"`), ['/h/.jobduck']);
  });

  it('GH 1723 a name bound twice still lists both literals', async () => {
    assert.deepEqual(await run(`python3 -c "p='a.md'; p='~/.x'; open(p,'w').write('x')"`), ['/w/a.md', '/h/.x']);
  });

  it('GH 1723 a write to /etc/q beside a ~/ replace argument still lists /etc/q', async () => {
    const out = await run(`python3 -c "p='docs/a.md'; s=open(p).read().replace('~/.x','y'); open('/etc/q','w').write(s)"`);
    assert.ok(out.includes('/etc/q'), JSON.stringify(out));
  });

  for (const [label, cmd] of [
    ['.replace on a name', `python3 -c "p='docs/a.md'; s='q'; t=s.replace('a','b'); open(p,'w').write(t)"`],
    ['a one-argument .replace on open(p).read()', `python3 -c "p='docs/a.md'; t=open(p).read().replace('a'); open(p,'w').write(t)"`],
    ['Path.replace', `python3 -c "from pathlib import Path; Path('a').replace('b')"`],
    ['re.sub with a repl bound by assignment', `python3 -c "import re; p='docs/a.md'; f=str; t=re.sub('a', f, 's'); open(p,'w').write(t)"`],
    ['re.sub with os.remove as repl', `python3 -c "import re, os; p='docs/a.md'; t=re.sub('a', os.remove, 's'); open(p,'w').write(t)"`],
  ]) {
    it(`GH 1723 ${label} stays unproven`, async () => {
      const out = await run(cmd);
      assert.ok(unproven(out), JSON.stringify(out));
    });
  }

  for (const [label, cmd] of [
    ['a tuple-splat open of a held name (F533-1)', `python3 -c "p='docs/x.md'; c='/etc/q'; open(p,'w').write('x'); open(*(c, 'w'))"`],
    ['a list-splat open of a held name (F533-1)', `python3 -c "p='docs/x.md'; c='/etc/q'; open(p,'w').write('x'); open(*[c, 'w'])"`],
    ['a splat open of a list held in a name (F533-1)', `python3 -c "p='docs/x.md'; c='/etc/q'; open(p,'w').write('x'); a=[c, 'w']; open(*a)"`],
    ['a keyword-splat open of a held name (F533-1)', `python3 -c "p='docs/x.md'; c='/etc/q'; open(p,'w').write('x'); open(**{'file': c, 'mode': 'w'})"`],
    ['a list-splat open of a literal beside a held name (F533-1)', `python3 -c "p='docs/x.md'; open(p,'w').write('x'); open(*['/etc/q', 'w'])"`],
    ['a list-splat open of a literal beside a literal write', `python3 -c "open('docs/x.md','w'); open(*['/etc/q','w'])"`],
    ['a list-splat os.remove beside a held name', `python3 -c "import os; p='docs/x.md'; open(p,'w').write('x'); os.remove(*['/etc/q'])"`],
    ['a keyword-splat shutil.copy beside a held name', `python3 -c "import shutil; p='docs/x.md'; open(p,'w').write('x'); shutil.copy(**{'src': 'a', 'dst': '/etc/q'})"`],
  ]) {
    it(`GH 1723 ${label} still lists the splatted path`, async () => {
      const out = await run(cmd);
      assert.ok(out.includes('/etc/q'), JSON.stringify(out));
    });
  }

  it('GH 1723 an unproven program writing through a resolved name still lists every path-like literal', async () => {
    const out = await run(`python3 -c "import foo; p='docs/a.md'; foo.bar('~/.jobduck'); open(p,'w').write('x')"`);
    assert.ok(unproven(out), JSON.stringify(out));
    assert.ok(out.includes('/w/docs/a.md') && out.includes('/h/.jobduck'), JSON.stringify(out));
  });
});

describe('GH 2463: a call inside an f-string interpolation leaves a python program unproven', () => {
  const run = (program: string): Promise<string[]> =>
    writePaths(`python3 - <<'EOF'\n${program}\nEOF`, { cwd: '/w', root: '/w', env: { HOME: '/h' } });

  for (const [label, program] of [
    ['a standalone f-string (F533-2)', `p='a'\nopen(p,'w')\nx=f'{open("/etc/q","w")}'`],
    ['an f-string as re.sub repl (F533-2)', `import re\np='a'\nre.sub('a', f'{open("/etc/q","w")}', 'c')\nopen(p,'w')`],
    ['a call in a format spec', `p='a'\nopen(p,'w')\nx=f'{p:>{len(open("/etc/q","w").name)}}'`],
  ]) {
    it(`GH 2463 ${label} is not judged inside the worktree`, async () => {
      const out = await run(program);
      assert.ok(out.some((l) => l.startsWith('UNRESOLVED:$(unproven):')), JSON.stringify(out));
    });
  }
});

describe('GH 2669: a node -e program calling Buffer.byteLength is proven', () => {
  const run = (program: string): Promise<string[]> =>
    writePaths(`node -e '${program}'`, { cwd: '/w', root: '/w', env: { HOME: '/h' } });

  for (const program of [
    'console.log(Buffer.byteLength("ab"))',
    'const s="ab"; console.log(Buffer.byteLength(s, "utf8"))',
  ]) {
    it(`GH 2669 ${program} writes nothing`, async () => {
      assert.deepEqual(await run(program), []);
    });
  }

  for (const [label, program] of [
    ['Buffer.from passed on to writeFileSync', 'require("fs").writeFileSync("x", Buffer.from("ab"))'],
    ['Buffer bound to a name', 'const B=Buffer; B.byteLength("a")'],
    ['Buffer.alloc', 'Buffer.alloc(1)'],
    ['a dynamic import', 'await import("./x.js")'],
  ]) {
    it(`GH 2669 ${label} stays unproven`, async () => {
      const out = await run(program);
      assert.ok(out.some((l) => l.startsWith('UNRESOLVED:')), JSON.stringify(out));
    });
  }
});
