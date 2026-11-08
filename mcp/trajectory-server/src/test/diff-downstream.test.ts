import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffDownstream, indexRepoSymbols } from '../symbol-index.js';
import { tempDB } from './helpers.js';

const FILES: Record<string, string> = {
  'src/core.ts': [
    'export function coreFn(): number {',
    '  return 1;',
    '}',
    'export function steadyFn(): number {',
    '  return 2;',
    '}',
    '',
  ].join('\n'),
  'src/other.ts': 'export function otherFn(): number {\n  return 3;\n}\n',
  'src/caller.ts': [
    "import { coreFn } from './core.js';",
    "import { otherFn } from './other.js';",
    'export function callerFn(): number {',
    '  return coreFn() + otherFn();',
    '}',
    'export function chainFn(): number {',
    '  return callerFn();',
    '}',
    '',
  ].join('\n'),
  'src/test/core.test.ts': "import { coreFn } from '../core.js';\nexport const subject = coreFn();\n",
  'schema.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n',
  'src/writer.ts': "export function writeItem(db: { run(sql: string): void }): void {\n  db.run('INSERT INTO items (id) VALUES (1)');\n}\n",
  'src/reader.ts': "export function readItems(db: { all(sql: string): unknown[] }): unknown[] {\n  return db.all('SELECT id FROM items');\n}\n",
};

describe('diffDownstream maps a change set to its consumers (GH 1988)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-diff-downstream-'));
  const db = tempDB();
  const idOf = (path: string, name: string) =>
    db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = ? AND qualified_name = ?`, [path, name])!.id;
  const edit = (path: string, from: string, to: string) => ({ path, content: FILES[path]!.replace(from, to) });

  before(async () => {
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, dirname(p)), { recursive: true });
      writeFileSync(join(root, p), body);
      db.run(`INSERT INTO wm_files (repo, path, dir, purpose, content_md5, size_bytes, updated_at) VALUES ('app', ?, ?, '', ?, ?, datetime('now'))`, [
        p,
        dirname(p),
        createHash('md5').update(body).digest('hex'),
        Buffer.byteLength(body),
      ]);
    }
    const stats = await indexRepoSymbols(db, 'app', root);
    assert.equal(stats.files_failed, 0);
  });

  after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('SC1: a body change reports the symbol modified, its direct caller by call with from, and its test', async () => {
    const out = await diffDownstream(db, 'app', [edit('src/core.ts', 'return 1;', 'return 10;')]);
    const coreId = idOf('src/core.ts', 'coreFn');
    const fns = out.changed.filter((c) => c.kind === 'function');
    assert.deepEqual(fns.map((c) => [c.qualified_name, c.change, c.id]), [['coreFn', 'modified', coreId]]);
    assert.ok(!out.changed.some((c) => c.qualified_name === 'steadyFn'));
    const caller = out.downstream.find((d) => d.qualified_name === 'callerFn');
    assert.ok(caller, JSON.stringify(out.downstream));
    assert.equal(caller.via, 'call');
    assert.deepEqual(caller.from, [coreId]);
    assert.ok(!out.downstream.some((d) => d.qualified_name === 'chainFn'), 'depth 1 only');
    assert.deepEqual(out.tests.map((t) => t.path), ['src/test/core.test.ts']);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.unparsed, []);
    assert.equal(out.truncated, false);
  });

  it('SC2: a table writer reaches the readers of the table via table:<name>', async () => {
    const out = await diffDownstream(db, 'app', [edit('src/writer.ts', 'VALUES (1)', 'VALUES (2)')]);
    assert.deepEqual(out.downstream.map((d) => [d.qualified_name, d.via]), [['readItems', 'table:items']]);
    assert.deepEqual(out.downstream[0]!.from, [idOf('src/writer.ts', 'writeItem')]);
  });

  it('SC3: a deleted file removes every indexed symbol, a new function is added, an unknown language is unparsed', async () => {
    const out = await diffDownstream(db, 'app', [
      { path: 'src/core.ts', content: null },
      { path: 'src/other.ts', content: `${FILES['src/other.ts']}export function freshFn(): number {\n  return 4;\n}\n` },
      { path: 'assets/logo.png', content: '\x89PNG' },
    ]);
    const indexed = db
      .all<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = 'src/core.ts' ORDER BY id`)
      .map((r) => Number(r.id));
    const removed = out.changed.filter((c) => c.path === 'src/core.ts');
    assert.deepEqual(removed.map((c) => c.id).sort((a, b) => a - b), indexed);
    assert.ok(removed.every((c) => c.change === 'removed'));
    assert.deepEqual(out.added, [{ path: 'src/other.ts', kind: 'function', qualified_name: 'freshFn' }]);
    assert.ok(!out.changed.some((c) => c.qualified_name === 'freshFn' || c.qualified_name === 'otherFn'));
    assert.deepEqual(out.unparsed, ['assets/logo.png']);
  });

  it('SC4: two changed symbols sharing a caller yield one ref holding both ids; a changed symbol is not downstream', async () => {
    const out = await diffDownstream(db, 'app', [
      edit('src/core.ts', 'return 1;', 'return 10;'),
      edit('src/other.ts', 'return 3;', 'return 30;'),
    ]);
    const callers = out.downstream.filter((d) => d.qualified_name === 'callerFn');
    assert.equal(callers.length, 1);
    assert.deepEqual([...callers[0]!.from].sort((a, b) => a - b), [idOf('src/core.ts', 'coreFn'), idOf('src/other.ts', 'otherFn')].sort((a, b) => a - b));

    const withCaller = await diffDownstream(db, 'app', [
      edit('src/core.ts', 'return 1;', 'return 10;'),
      edit('src/caller.ts', 'coreFn() + otherFn()', 'otherFn() + coreFn()'),
    ]);
    assert.ok(withCaller.changed.some((c) => c.qualified_name === 'callerFn' && c.change === 'modified'));
    assert.ok(!withCaller.downstream.some((d) => d.qualified_name === 'callerFn'), JSON.stringify(withCaller.downstream));
    assert.ok(withCaller.downstream.some((d) => d.qualified_name === 'chainFn'));
  });
});
