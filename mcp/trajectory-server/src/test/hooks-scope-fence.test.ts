/**
 * src/hooks/lib/scope-fence.ts, the port of scripts/hooks/lib/scope-fence.sh
 * (GH 1692): files[] loaded as a path list, the allow predicate, the
 * once-per-path note, and the cksum and `sort -u` it reproduces.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cksum, ScopeFence, sortUnique } from '../hooks/lib/scope-fence.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-11T10:00:00.000Z';

describe('scope-fence: cksum and sort -u as the .sh runs them', () => {
  it('cksum gives the first field of the system cksum', () => {
    for (const text of ['', 'a', 'src/index.ts', 'docs/über guide.md', 'x'.repeat(300), 'lib/a b\tc']) {
      const r = spawnSync('cksum', { input: text, encoding: 'utf8' });
      assert.equal(cksum(text), r.stdout.split(' ')[0], JSON.stringify(text));
    }
  });

  it('sortUnique orders and dedupes as sort -u does under C and en_US.UTF-8', () => {
    const items = ['src', 'Zeta', '_gen', 'README.md', 'docs/guide.md', 'tests/l3', 'src', 'agents', 'Agents', 'a-b', 'a_b', 'a.b'];
    for (const locale of ['C', 'en_US.UTF-8']) {
      const env = { ...process.env, LC_ALL: locale };
      const r = spawnSync('sort', ['-u'], { input: `${items.join('\n')}\n`, encoding: 'utf8', env });
      assert.deepEqual(sortUnique(items, env), r.stdout.split('\n').filter((l) => l !== ''), locale);
    }
  });
});

describe('scope-fence: ScopeFence over a task row', () => {
  let dir: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scope-fence-')));
    db = join(dir, 'trajectory.db');
    env = { ...process.env, TRAJECTORY_DB_PATH: db, LC_ALL: 'C' };
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)").run(NOW, NOW);
      const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at, files) VALUES (?, 1, ?, 'd', ?, ?, ?)");
      task.run(1, 'feat/a', NOW, NOW, JSON.stringify(['src/', 'docs/guide.md', 'tests/l3', 'Zeta', '_gen']));
      task.run(2, 'feat/b', NOW, NOW, '[]');
      task.run(3, 'feat/c', NOW, NOW, JSON.stringify(['', '/', 'lib']));
    } finally {
      d.close();
    }
    writeFileSync(join(dir, 'bad.db'), 'not a database\n'.repeat(64));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads files[] with trailing slashes stripped and empty entries skipped', () => {
    const fence = new ScopeFence(env);
    fence.load(db, '1');
    assert.equal(fence.state, 'ok');
    assert.deepEqual(fence.dirs, ['src', 'docs/guide.md', 'tests/l3', 'Zeta', '_gen']);
    fence.load(db, '3');
    assert.equal(fence.state, 'ok');
    assert.deepEqual(fence.dirs, ['lib']);
  });

  it('reports empty, none and error states', () => {
    const fence = new ScopeFence(env);
    fence.load(db, '2');
    assert.equal(fence.state, 'empty');
    fence.load(db, '99');
    assert.equal(fence.state, 'none');
    fence.load(db, 'x');
    assert.equal(fence.state, 'none');
    fence.load(join(dir, 'bad.db'), '1');
    assert.equal(fence.state, 'error');
  });

  it('allows an entry, anything beneath it, and all of tests/ once a tests entry is listed', () => {
    const fence = new ScopeFence(env);
    fence.load(db, '1');
    for (const rel of ['src', 'src/a.ts', 'docs/guide.md', 'tests/unit/x.ts', 'tests', '_gen/x']) assert.ok(fence.allows(rel), rel);
    for (const rel of ['srcx/a.ts', 'docs/other.md', 'lib/a.ts', 'zeta']) assert.ok(!fence.allows(rel), rel);
    fence.load(db, '3');
    assert.ok(!fence.allows('tests/unit/x.ts'));
  });

  it('notes a path once per task, naming the sorted entries, with a marker under the state dir', () => {
    const fence = new ScopeFence(env);
    fence.load(db, '1');
    assert.equal(fence.note('1', 'lib/a.ts'), "lib/a.ts is outside this task's files[] (Zeta, _gen, docs/guide.md, src, tests/l3); list it and why in your report");
    assert.equal(fence.note('1', 'lib/a.ts'), '');
    assert.ok(existsSync(join(dir, 'locks/scope-notes/1', cksum('lib/a.ts'))));
    const en = new ScopeFence({ ...env, LC_ALL: 'en_US.UTF-8' });
    en.load(db, '1');
    assert.equal(en.note('1', 'lib/b.ts'), "lib/b.ts is outside this task's files[] (_gen, docs/guide.md, src, tests/l3, Zeta); list it and why in your report");
    assert.equal(fence.note('x', 'lib/c.ts'), '');
    assert.equal(fence.note('1', ''), '');
  });
});
