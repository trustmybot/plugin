// wm_files.lane (GH 2886): a scan of a non-TMB repo stores each file's test or
// product lane by the per-language defaults, a world_model_test_lane extend
// flips an unchanged file on the next scan, and the v68→v69 migration
// backfills existing rows by the default rules.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { WORLD_MODEL_TEST_LANE_KEY } from '../tools/config.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { configureTestLane, DEFAULT_TEST_LANE } from '../utils/test-paths.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(() => Promise.reject(new Error('no model in tests')));
after(() => resetEmbeddingModelForTests());
after(() => configureTestLane(DEFAULT_TEST_LANE));

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/lanes\n\ngo 1.22\n',
  'pkg/foo.go': 'package pkg\n\nfunc Foo() int { return 1 }\n',
  'pkg/foo_test.go': 'package pkg\n\nimport "testing"\n\nfunc TestFoo(t *testing.T) { _ = Foo() }\n',
  'app/__init__.py': '',
  'app/foo.py': 'def foo():\n    return 1\n',
  'app/test_foo.py': 'from app.foo import foo\n\ndef test_foo():\n    assert foo() == 1\n',
  'tests/test_bar.py': 'def test_bar():\n    assert True\n',
};

const TEST_FILES = ['app/test_foo.py', 'pkg/foo_test.go', 'tests/test_bar.py'];

describe('GH 2886: wm_files.lane on a Go and Python repo', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-test-lane-'));
  const root = join(ws, 'lanes');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const scan = async (): Promise<void> => {
    const r = await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: ws });
    assert.ok(!r.isError, JSON.stringify(r.content));
  };
  const laneOf = (path: string): string | undefined =>
    db.get<{ lane: string }>(`SELECT lane FROM wm_files WHERE repo = 'lanes' AND path = ?`, [path])?.lane;

  before(async () => {
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan();
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('SC4: the scan stores lane test for the 3 test files and product for the sources', () => {
    assert.equal(db.get<{ n: number }>(`SELECT count(*) AS n FROM wm_files WHERE lane = 'test'`)!.n, 3);
    assert.deepEqual(
      db.all<{ path: string }>(`SELECT path FROM wm_files WHERE lane = 'test' ORDER BY path`).map((r) => r.path),
      TEST_FILES,
    );
    for (const p of TEST_FILES) assert.equal(laneOf(p), 'test', p);
    assert.equal(laneOf('pkg/foo.go'), 'product');
    assert.equal(laneOf('app/foo.py'), 'product');
  });

  it('SC4: an extend glob flips an unchanged file to test on the next scan, and dropping it flips it back', async () => {
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?)`, [WORLD_MODEL_TEST_LANE_KEY, JSON.stringify({ extend: ['app/foo.py'] })]);
    await scan();
    assert.equal(laneOf('app/foo.py'), 'test');
    assert.equal(laneOf('pkg/foo.go'), 'product');

    db.run(`UPDATE plugin_config SET value_json = ? WHERE key = ?`, [JSON.stringify({ exclude: ['tests/**'] }), WORLD_MODEL_TEST_LANE_KEY]);
    await scan();
    assert.equal(laneOf('app/foo.py'), 'product');
    assert.equal(laneOf('tests/test_bar.py'), 'product', 'exclude removes a default match');
  });

  it('SC3: a malformed stored value scans with the defaults', async () => {
    db.run(`UPDATE plugin_config SET value_json = ? WHERE key = ?`, ['{"extend": "app/foo.py"}', WORLD_MODEL_TEST_LANE_KEY]);
    await scan();
    for (const p of TEST_FILES) assert.equal(laneOf(p), 'test', p);
    assert.equal(laneOf('app/foo.py'), 'product');
  });
});

describe('GH 2886: the v68 -> v69 migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-test-lane-migrate-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('SC4: adds wm_files.lane matching a fresh DB and backfills it by the default rules', () => {
    const dbFile = join(dir, 'trajectory.db');
    new TrajectoryDB(dbFile).close();
    const raw = new DatabaseSync(dbFile);
    const NOW = '2026-11-10T00:00:00.000Z';
    for (const path of ['pkg/foo.go', 'pkg/foo_test.go', 'app/test_foo.py', 'web/a.spec.ts', 'src/schema-v3.sql']) {
      raw.prepare(`INSERT INTO wm_files (repo, path, dir, updated_at) VALUES ('r', ?, '', ?)`).run(path, NOW);
    }
    raw.exec(`ALTER TABLE wm_files DROP COLUMN lane; UPDATE plugin_meta SET schema_version = 68 WHERE id = 1;`);
    raw.close();

    const migrated = new TrajectoryDB(dbFile, undefined, { migrate: true });
    const fresh = new TrajectoryDB(join(dir, 'fresh.db'));
    try {
      assert.equal(migrated.get<{ v: number }>('SELECT schema_version AS v FROM plugin_meta WHERE id = 1')!.v, 69);
      const cols = (d: TrajectoryDB) =>
        d.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>('PRAGMA table_info(wm_files)')
          .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }));
      assert.deepEqual(cols(migrated), cols(fresh), 'the migrated wm_files table matches a fresh one');
      assert.deepEqual(
        migrated.all<{ path: string; lane: string }>('SELECT path, lane FROM wm_files ORDER BY path').map((r) => ({ ...r })),
        [
          { path: 'app/test_foo.py', lane: 'test' },
          { path: 'pkg/foo.go', lane: 'product' },
          { path: 'pkg/foo_test.go', lane: 'test' },
          { path: 'src/schema-v3.sql', lane: 'product' },
          { path: 'web/a.spec.ts', lane: 'test' },
        ],
      );
      assert.throws(() => migrated.run(`UPDATE wm_files SET lane = 'fixture'`), /CHECK/);
    } finally {
      migrated.close();
      fresh.close();
    }
  });
});
