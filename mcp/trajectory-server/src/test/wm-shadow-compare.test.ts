// The daily shadow compare of the world model (GH 2584): startup_catchup
// starts, without awaiting it, a compare of at most one repo not compared in
// the last 24 h against a clean full index built in a temp DB; a mismatch
// writes a wm_reindex row with mode 'mismatch' that forces every reindex to
// rebuild in full until the repo's indexed_stamp changes.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { __setIndexStampForTests, ensureFresh, indexStamp, reindexIdle } from '../world-model/freshness.js';
import {
  __setShadowCompareClockForTests,
  runShadowCompare,
  SHADOW_COMPARE_INTERVAL_MS,
  shadowCompareDue,
  shadowCompareHooks,
  shadowCompareIdle,
  type ShadowCompareResult,
} from '../world-model/shadow-compare.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

interface CompareRow {
  repo: string;
  commit: string;
  stamp: string | null;
  verdict: string;
  tables: string[];
  ms: number;
  reason: string | null;
  error: string | null;
}

interface ReindexRow {
  repo: string;
  mode: string;
  reason: string;
  trigger: string;
  from_commit: string;
  to_commit: string;
}

const A = 'export function alpha(): number {\n  return 1;\n}\n';
const B = "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n";

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  delete shadowCompareHooks.beforeBuild;
  __setShadowCompareClockForTests();
  await shadowCompareIdle();
  await reindexIdle();
});

interface Fx {
  db: TrajectoryDB;
  graph: WorldModelGraph;
  dbPath: string;
  commit: (repo: string, files: Record<string, string>) => string;
  head: (repo: string) => string;
  scan: (source: string) => Promise<Record<string, unknown>>;
  cleanup: () => void;
}

async function fixture(repos: readonly string[] = ['app']): Promise<Fx> {
  const ws = mkdtempSync(join(tmpdir(), 'wm-shadow-'));
  const gitIn = (repo: string, ...a: string[]) =>
    execFileSync('git', ['-C', join(ws, repo), ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (repo: string, files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(ws, repo, rel)), { recursive: true });
      writeFileSync(join(ws, repo, rel), body);
    }
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'change');
    return gitIn(repo, 'rev-parse', 'HEAD');
  };
  for (const repo of repos) {
    mkdirSync(join(ws, repo));
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t.io');
    gitIn(repo, 'config', 'user.name', 't');
    commit(repo, { 'src/a.ts': A, 'src/b.ts': B });
  }
  const dbDir = mkdtempSync(join(tmpdir(), 'wm-shadow-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const handlers = scanTools(db, GraphHolder.fixed(graph), dbPath).handlers as Handlers;
  const scan = async (source: string) => {
    const r = (await handlers['scan_run']!({ agent: 'bro', session_dir: ws, source })) as Raw;
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  };
  await scan('user_manual');
  for (const repo of repos) db.run(`UPDATE repos SET target_branch = 'main' WHERE name = ?`, [repo]);
  return {
    db,
    graph,
    dbPath,
    commit,
    head: (repo) => gitIn(repo, 'rev-parse', 'HEAD'),
    scan,
    cleanup: () => {
      db.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

const compares = (db: TrajectoryDB): CompareRow[] =>
  db
    .all<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'wm_shadow_compare' ORDER BY id`)
    .map((r) => JSON.parse(r.content_json) as CompareRow);

const reindexes = (db: TrajectoryDB): ReindexRow[] =>
  db
    .all<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'wm_reindex' ORDER BY id`)
    .map((r) => JSON.parse(r.content_json) as ReindexRow);

function assertGone(r: ShadowCompareResult | null): ShadowCompareResult {
  assert.ok(r, 'the compare ran');
  assert.equal(existsSync(r.temp_dir), false, `${r.temp_dir} is removed`);
  return r;
}

describe('startup_catchup runs one compare per due repo per day (SC1, SC2)', () => {
  it('starts the compare without awaiting it, records it, and runs none again within 24 h', async () => {
    const fx = await fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      shadowCompareHooks.beforeBuild = () => gate;
      const first = await fx.scan('startup_catchup');
      assert.equal(first['shadow_compare'], 'app');
      assert.deepEqual(compares(fx.db), [], 'scan_run returned while the compare waits at the gate');
      release();
      await shadowCompareIdle();
      const rows = compares(fx.db);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.deepEqual(
        { repo: row.repo, commit: row.commit, verdict: row.verdict, tables: row.tables, reason: row.reason, error: row.error },
        { repo: 'app', commit: fx.head('app'), verdict: 'match', tables: [], reason: null, error: null },
      );
      assert.equal(typeof row.ms, 'number');

      const second = await fx.scan('startup_catchup');
      assert.equal(second['shadow_compare'], null);
      await shadowCompareIdle();
      assert.equal(compares(fx.db).length, 1, 'no second compare within 24 h');

      const later = Date.now() + SHADOW_COMPARE_INTERVAL_MS + 60_000;
      __setShadowCompareClockForTests(() => later);
      const third = await fx.scan('startup_catchup');
      assert.equal(third['shadow_compare'], 'app', 'due again once 24 h have passed');
      await shadowCompareIdle();
      assert.equal(compares(fx.db).length, 2);
      const stamped = fx.db.get<{ at: string }>(`SELECT created_at AS at FROM audit WHERE event_type = 'wm_shadow_compare' ORDER BY id DESC LIMIT 1`);
      assert.equal(stamped?.at, new Date(later).toISOString(), 'the row carries the injected clock');
      assert.equal(shadowCompareDue(fx.db, later), null);
      assert.equal(shadowCompareDue(fx.db, later + SHADOW_COMPARE_INTERVAL_MS), 'app');
      assert.equal(shadowCompareDue(fx.db, later - 1000), 'app', 'a row from the future opens the window');
    } finally {
      fx.cleanup();
    }
  });

  it('compares at most one repo per startup_catchup, the never-compared first', async () => {
    const fx = await fixture(['app', 'lib']);
    try {
      assert.equal((await fx.scan('startup_catchup'))['shadow_compare'], 'app');
      await shadowCompareIdle();
      assert.equal((await fx.scan('startup_catchup'))['shadow_compare'], 'lib');
      await shadowCompareIdle();
      assert.equal((await fx.scan('startup_catchup'))['shadow_compare'], null);
      await shadowCompareIdle();
      assert.deepEqual(
        compares(fx.db).map((r) => [r.repo, r.verdict]),
        [
          ['app', 'match'],
          ['lib', 'match'],
        ],
      );
    } finally {
      fx.cleanup();
    }
  });

  it('a repo with no indexed_commit is never due', async () => {
    const fx = await fixture();
    try {
      fx.db.run(`UPDATE repos SET indexed_commit = NULL WHERE name = 'app'`);
      assert.equal(shadowCompareDue(fx.db, Date.now()), null);
      assert.equal(await runShadowCompare(fx.db, 'app'), null);
    } finally {
      fx.cleanup();
    }
  });
});

describe('a tampered index forces a full rebuild (SC3)', () => {
  const fileRow = `WHERE repo = 'app' AND path = 'src/a.ts'`;
  for (const [label, table, tamper] of [
    ['a deleted wm_symbols row', 'wm_symbols', `DELETE FROM wm_symbols WHERE repo = 'app' AND qualified_name = 'alpha' AND kind <> 'module'`],
    ['an altered wm_symbols row', 'wm_symbols', `UPDATE wm_symbols SET signature = 'tampered' WHERE repo = 'app' AND qualified_name = 'beta' AND kind <> 'module'`],
    ['a deleted wm_files row', 'wm_files', `DELETE FROM wm_files ${fileRow}`],
    ['an altered wm_files.last_commit_sha', 'wm_files', `UPDATE wm_files SET last_commit_sha = '${'0'.repeat(40)}' ${fileRow}`],
    ['an altered wm_files.purpose', 'wm_files', `UPDATE wm_files SET purpose = 'tampered' ${fileRow}`],
    ["a wm_files.purpose_source set to 'swe'", 'wm_files', `UPDATE wm_files SET purpose_source = 'swe' ${fileRow}`],
    ['an altered wm_files.size_bytes', 'wm_files', `UPDATE wm_files SET size_bytes = size_bytes + 1 ${fileRow}`],
    ['an altered wm_files.dir', 'wm_files', `UPDATE wm_files SET dir = 'tampered' ${fileRow}`],
    ['an altered wm_files.content_md5', 'wm_files', `UPDATE wm_files SET content_md5 = 'tampered' ${fileRow}`],
    ['an altered wm_files.symbols_md5', 'wm_files', `UPDATE wm_files SET symbols_md5 = 'tampered' ${fileRow}`],
  ] as const) {
    it(`${label}: mismatch, wm_reindex mode 'mismatch', full rebuild on the next ensureFresh, then match`, async () => {
      const fx = await fixture();
      try {
        const head = fx.head('app');
        const before = reindexes(fx.db).length;
        const clean = assertGone(await runShadowCompare(fx.db, 'app'));
        assert.equal(clean.verdict, 'match');
        assert.equal(reindexes(fx.db).length, before, 'a match writes no wm_reindex row');

        const changed = fx.db.run(tamper);
        assert.equal(Number(changed.changes), 1);
        const bad = assertGone(await runShadowCompare(fx.db, 'app'));
        assert.equal(bad.verdict, 'mismatch');
        assert.ok(bad.tables.includes(table), JSON.stringify(bad.tables));
        const row = compares(fx.db).at(-1)!;
        assert.deepEqual([row.verdict, row.tables], ['mismatch', bad.tables]);
        const mismatch = reindexes(fx.db).at(-1)!;
        assert.deepEqual(
          [mismatch.repo, mismatch.mode, mismatch.reason, mismatch.trigger, mismatch.from_commit, mismatch.to_commit],
          ['app', 'mismatch', 'mismatch', 'startup_catchup', head, head],
        );

        const f = await ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'read' });
        assert.equal(f.mode, 'full');
        const rebuilt = reindexes(fx.db).at(-1)!;
        assert.deepEqual([rebuilt.mode, rebuilt.reason], ['full', 'mismatch']);

        const healed = assertGone(await runShadowCompare(fx.db, 'app'));
        assert.equal(healed.verdict, 'match');
        assert.equal(reindexes(fx.db).at(-1)!.mode, 'full', 'a match after the rebuild writes no mismatch');
      } finally {
        fx.cleanup();
      }
    });
  }
});

describe('the race guard and the temp DB (SC4)', () => {
  it('indexed_commit moving during the compare records skipped and writes no mismatch', async () => {
    const fx = await fixture();
    try {
      const head = fx.head('app');
      let tip = '';
      shadowCompareHooks.beforeBuild = async () => {
        tip = fx.commit('app', { 'src/a.ts': 'export function alpha(): number {\n  return 2;\n}\n' });
        await ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'read' });
      };
      const r = assertGone(await runShadowCompare(fx.db, 'app'));
      assert.notEqual(tip, head);
      assert.equal(fx.db.get<{ c: string }>(`SELECT indexed_commit AS c FROM repos WHERE name = 'app'`)?.c, tip);
      assert.deepEqual([r.verdict, r.reason, r.commit], ['skipped', 'moved', head]);
      assert.deepEqual(
        compares(fx.db).map((c) => [c.verdict, c.reason, c.commit]),
        [['skipped', 'moved', head]],
      );
      assert.equal(reindexes(fx.db).filter((x) => x.mode === 'mismatch').length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('a thrown build error is caught, recorded as skipped, and leaves no temp DB', async () => {
    const fx = await fixture();
    try {
      shadowCompareHooks.beforeBuild = () => {
        throw new Error('boom in the clean build');
      };
      const r = assertGone(await runShadowCompare(fx.db, 'app'));
      assert.deepEqual([r.verdict, r.reason, r.error], ['skipped', 'error', 'boom in the clean build']);
      const row = compares(fx.db).at(-1)!;
      assert.deepEqual([row.verdict, row.reason, row.error], ['skipped', 'error', 'boom in the clean build']);
      assert.equal(reindexes(fx.db).filter((x) => x.mode === 'mismatch').length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('a background compare that fails never reaches scan_run', async () => {
    const fx = await fixture();
    try {
      shadowCompareHooks.beforeBuild = () => {
        throw new Error('boom in the background');
      };
      const r = await fx.scan('startup_catchup');
      assert.equal(r['shadow_compare'], 'app');
      await shadowCompareIdle();
      assert.deepEqual(
        compares(fx.db).map((c) => [c.verdict, c.reason]),
        [['skipped', 'error']],
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe('a mismatch holds until the repo stamp changes (GH 2584)', () => {
  afterEach(() => __setIndexStampForTests());
  const tamper = (db: TrajectoryDB) =>
    db.run(`UPDATE wm_symbols SET signature = 'tampered' WHERE repo = 'app' AND qualified_name = 'beta' AND kind <> 'module'`);
  const alpha = (n: number) => `export function alpha(): number {\n  return ${n};\n}\n`;
  const fresh = (fx: Fx) => ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'read' });
  const last = (fx: Fx) => {
    const r = reindexes(fx.db).at(-1)! as ReindexRow & { files_parsed: number };
    return [r.mode, r.reason, r.files_parsed] as const;
  };

  async function mismatched(): Promise<Fx> {
    const fx = await fixture();
    tamper(fx.db);
    assert.equal(assertGone(await runShadowCompare(fx.db, 'app')).verdict, 'mismatch');
    const row = reindexes(fx.db).at(-1)! as ReindexRow & { stamp: string };
    assert.deepEqual([row.mode, row.stamp], ['mismatch', indexStamp()]);
    assert.equal(compares(fx.db).at(-1)!.stamp, indexStamp());
    return fx;
  }

  it('two ref moves after the mismatch rebuild in full; after a stamp bump the next move is incremental', async () => {
    const fx = await mismatched();
    try {
      assert.equal((await fresh(fx)).mode, 'full');
      assert.deepEqual(last(fx), ['full', 'mismatch', 2]);
      const settled = reindexes(fx.db).length;
      await fresh(fx);
      assert.equal(reindexes(fx.db).length, settled, 'a read at the rebuilt commit is a no-op');

      for (const n of [2, 3]) {
        fx.commit('app', { 'src/a.ts': alpha(n) });
        assert.equal((await fresh(fx)).mode, 'full');
        assert.deepEqual(last(fx), ['full', 'mismatch', 2], `ref move ${n - 1}`);
      }

      __setIndexStampForTests('bumped:0');
      assert.equal((await fresh(fx)).mode, 'full');
      assert.deepEqual(last(fx).slice(0, 2), ['full', 'stamp_changed']);
      fx.commit('app', { 'src/a.ts': alpha(4) });
      assert.equal((await fresh(fx)).mode, 'incremental');
      assert.deepEqual(last(fx).slice(0, 2), ['incremental', 'ref_moved']);
    } finally {
      fx.cleanup();
    }
  });

  it('back on the mismatched stamp it holds again, unless a clean compare under another stamp came after it', async () => {
    for (const compared of [false, true]) {
      const fx = await mismatched();
      try {
        const original = indexStamp();
        __setIndexStampForTests('bumped:0');
        await fresh(fx);
        assert.deepEqual(last(fx).slice(0, 2), ['full', 'stamp_changed']);
        if (compared) assert.equal(assertGone(await runShadowCompare(fx.db, 'app')).verdict, 'match');

        __setIndexStampForTests(original);
        await fresh(fx);
        assert.deepEqual(last(fx).slice(0, 2), ['full', 'stamp_changed']);
        fx.commit('app', { 'src/a.ts': alpha(5) });
        await fresh(fx);
        assert.deepEqual(last(fx).slice(0, 2), compared ? ['incremental', 'ref_moved'] : ['full', 'mismatch'], `compared=${compared}`);
      } finally {
        fx.cleanup();
      }
    }
  });
});
