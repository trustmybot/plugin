import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePythonImport } from '../symbol-index.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
const savedIndexTarget = process.env['TMB_WM_INDEX_TARGET'];
process.env['TMB_WM_INDEX_TARGET'] = 'HEAD';
after(() => {
  scanPin.restore();
  if (savedIndexTarget === undefined) delete process.env['TMB_WM_INDEX_TARGET'];
  else process.env['TMB_WM_INDEX_TARGET'] = savedIndexTarget;
});

const FILES: Record<string, string> = {
  'pkg/__init__.py': '"""The pkg package."""\n',
  'pkg/a.py': [
    '"""Module a."""',
    'LIMIT = 3',
    '_PRIVATE: int = 4',
    'T: int',
    '',
    '',
    '# A foo.',
    'class Foo:',
    '    def bar(self):',
    '        return LIMIT',
    '',
    '    def baz(self):',
    '        return self.bar()',
    '',
    '',
    'def helper():',
    '    """Help out."""',
    '    return 1',
    '',
    '',
    'def _hidden():',
    '    return helper()',
    '',
  ].join('\n'),
  'pkg/b.py': [
    'from .a import Foo, helper',
    'import pkg.a',
    'from . import c as sub',
    'import pkg.c as pc',
    '',
    '',
    'def run():',
    '    helper()',
    '    pc.cee()',
    '    return Foo()',
    '',
  ].join('\n'),
  'pkg/c.py': 'def cee():\n    pass\n',
  'pkg/d.py': 'def dee():\n    return uniquely_named_helper()\n',
  'pkg/e.py': 'def uniquely_named_helper():\n    return 1\n',
  'pkg/sub/http.py': 'def get():\n    pass\n',
  'pkg/sub/x.py': 'import http\n',
};

describe('Python symbol extraction (GH 3032)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-python-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  before(async () => {
    mkdirSync(root, { recursive: true });
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    const scanRun = scanTools(db, holder, ':memory:').handlers['scan_run'];
    assert.ok(scanRun);
    const r = await scanRun({ agent: 'bro', session_dir: ws });
    assert.ok(!r.isError, (r.content[0] as { text: string }).text);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const symbol = (path: string, kind: string, name: string) =>
    db.get<{ id: number; doc: string; exported: number }>(
      `SELECT id, doc, exported FROM wm_symbols WHERE repo = 'app' AND path = ? AND kind = ? AND qualified_name = ?`,
      [path, kind, name],
    );

  const edge = (srcPath: string, src: string, kind: string, dst: string) =>
    db.get<{ resolution: string; dst_id: number | null; dst_path: string | null }>(
      `SELECT e.resolution, e.dst_id, d.path AS dst_path
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
        WHERE s.path = ? AND s.qualified_name = ? AND e.kind = ? AND e.dst_name = ?`,
      [srcPath, src, kind, dst],
    );

  it('stores classes, methods, functions, constants and a module per file', () => {
    for (const [path, kind, name] of [
      ['pkg/a.py', 'class', 'Foo'],
      ['pkg/a.py', 'method', 'Foo.bar'],
      ['pkg/a.py', 'function', 'helper'],
      ['pkg/a.py', 'const', 'LIMIT'],
      ['pkg/b.py', 'function', 'run'],
      ...Object.keys(FILES).map((p) => [p, 'module', p]),
    ] as const) {
      assert.ok(symbol(path, kind, name), `${kind} ${name} in ${path}`);
    }
  });

  it('marks underscore names unexported and reads docstrings before comments', () => {
    assert.equal(symbol('pkg/a.py', 'function', 'helper')!.exported, 1);
    assert.equal(symbol('pkg/a.py', 'function', '_hidden')!.exported, 0);
    assert.equal(symbol('pkg/a.py', 'const', '_PRIVATE')!.exported, 0);
    assert.equal(symbol('pkg/a.py', 'function', 'helper')!.doc, 'Help out.');
    assert.equal(symbol('pkg/a.py', 'class', 'Foo')!.doc, 'A foo.');
    assert.equal(symbol('pkg/a.py', 'module', 'pkg/a.py')!.doc, 'Module a.');
  });

  it('resolves relative imports, calls and instantiations exactly', () => {
    assert.equal(edge('pkg/b.py', 'pkg/b.py', 'imports', 'Foo')?.dst_path, 'pkg/a.py');
    assert.equal(edge('pkg/b.py', 'pkg/b.py', 'imports', 'helper')?.dst_path, 'pkg/a.py');
    assert.deepEqual(
      { ...edge('pkg/b.py', 'run', 'calls', 'helper') },
      { resolution: 'exact', dst_id: symbol('pkg/a.py', 'function', 'helper')!.id, dst_path: 'pkg/a.py' },
    );
    assert.deepEqual(
      { ...edge('pkg/b.py', 'run', 'instantiates', 'Foo') },
      { resolution: 'exact', dst_id: symbol('pkg/a.py', 'class', 'Foo')!.id, dst_path: 'pkg/a.py' },
    );
  });

  it('resolves self method calls and absolute and submodule imports', () => {
    assert.equal(edge('pkg/a.py', 'Foo.baz', 'calls', 'bar')?.dst_id, symbol('pkg/a.py', 'method', 'Foo.bar')!.id);
    assert.equal(edge('pkg/b.py', 'pkg/b.py', 'imports', 'pkg.a')?.dst_path, 'pkg/a.py');
    assert.equal(edge('pkg/b.py', 'pkg/b.py', 'imports', 'c')?.dst_path, 'pkg/c.py');
  });

  it('no-guess: `import http` beside pkg/sub/http.py stays unlinked', () => {
    assert.deepEqual(
      { ...edge('pkg/sub/x.py', 'pkg/sub/x.py', 'imports', 'http') },
      { resolution: 'unresolved', dst_id: null, dst_path: null },
    );
  });

  it('no-guess: a call to a uniquely named function that is not imported stays unlinked', () => {
    assert.deepEqual(
      { ...edge('pkg/d.py', 'dee', 'calls', 'uniquely_named_helper') },
      { resolution: 'unresolved', dst_id: null, dst_path: null },
    );
  });

  it('stores no const for a bare annotation', () => {
    assert.equal(symbol('pkg/a.py', 'const', 'T'), undefined);
  });

  it('hints a member call with the module an alias names', () => {
    const hint = db.get<{ hint: string | null }>(
      `SELECT e.hint FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.path = 'pkg/b.py' AND s.qualified_name = 'run' AND e.kind = 'calls' AND e.dst_name = 'cee'`,
    );
    assert.equal(hint?.hint, 'pkg.c');
  });
});

describe('resolvePythonImport', () => {
  const files = new Set([
    'pkg/__init__.py',
    'pkg/a.py',
    'pkg/sub/__init__.py',
    'pkg/sub/d.py',
    'pkg/sub/http.py',
    'src/lib/m.py',
    'top.py',
  ]);

  it('climbs one package per extra leading dot', () => {
    assert.equal(resolvePythonImport('pkg/sub/d.py', '.', files), 'pkg/sub/__init__.py');
    assert.equal(resolvePythonImport('pkg/sub/d.py', '..a', files), 'pkg/a.py');
    assert.equal(resolvePythonImport('pkg/sub/d.py', '..', files), 'pkg/__init__.py');
    assert.equal(resolvePythonImport('top.py', '..x', files), null);
  });

  it('resolves absolute modules from the root, then from a top-level src/', () => {
    assert.equal(resolvePythonImport('pkg/a.py', 'pkg.sub', files), 'pkg/sub/__init__.py');
    assert.equal(resolvePythonImport('pkg/a.py', 'top', files), 'top.py');
    assert.equal(resolvePythonImport('src/lib/x.py', 'lib.m', files), 'src/lib/m.py');
    assert.equal(resolvePythonImport('pkg/a.py', 'os.path', files), null);
  });

  it('no-guess: never resolves an absolute module against ancestors of the importing file', () => {
    assert.equal(resolvePythonImport('pkg/sub/x.py', 'http', files), null);
    assert.equal(resolvePythonImport('pkg/sub/x.py', 'd', files), null);
  });
});
