// The world model indexed from git objects at repos.indexed_commit and brought
// to the target by the git-range reindex on every read and spawn (GH 2584).
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { reindexHooks, scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { compositeTools } from '../tools/composites.js';
import { __setTargetFetchForTests, ensureFresh, reindexIdle, type Freshness } from '../world-model/freshness.js';
import { sweepStaleAtStartup } from '../startup-catchup.js';
import { releaseLock, scanLockPath, tryLock } from '../utils/scan-lock.js';
import { CommitContent, resolveRefCommit } from '../utils/git-objects.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const parse = (r: unknown): Record<string, unknown> => JSON.parse((r as Raw).content[0]!.text);

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  delete reindexHooks.afterGraph;
  delete reindexHooks.afterIndex;
  await reindexIdle();
});

interface Fx {
  ws: string;
  root: string;
  dbPath: string;
  db: TrajectoryDB;
  graph: WorldModelGraph;
  holder: GraphHolder;
  git: (...a: string[]) => string;
  commit: (files: Record<string, string | null>, msg?: string) => string;
  fresh: (opts?: { trigger?: 'read' | 'spawn'; db?: TrajectoryDB; graph?: WorldModelGraph }) => Promise<Freshness>;
  scan: (source: string) => Promise<Record<string, unknown>>;
  cleanup: () => void;
}

const A = 'export function alpha(): number {\n  return 1;\n}\n';
const B = "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n";

async function fixture(files: Record<string, string>, opts: { remote?: boolean } = {}): Promise<Fx> {
  const ws = mkdtempSync(join(tmpdir(), 'wm-fresh-'));
  const root = join(ws, 'app');
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.io');
  git('config', 'user.name', 't');
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git('add', '-A');
  git('commit', '-qm', 'init');
  if (opts.remote) git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  const commit = (changes: Record<string, string | null>, msg = 'change') => {
    for (const [rel, body] of Object.entries(changes)) {
      if (body === null) git('rm', '-q', rel);
      else write(rel, body);
    }
    git('add', '-A');
    git('commit', '-qm', msg);
    const sha = git('rev-parse', 'HEAD');
    if (opts.remote) git('update-ref', 'refs/remotes/origin/main', sha);
    return sha;
  };
  const dbDir = mkdtempSync(join(tmpdir(), 'wm-fresh-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const holder = GraphHolder.fixed(graph);
  const scanHandlers = scanTools(db, holder, dbPath).handlers as Handlers;
  const scan = async (source: string) => {
    const r = (await scanHandlers['scan_run']!({ agent: 'bro', session_dir: ws, source })) as Raw;
    assert.ok(!r.isError, JSON.stringify(r));
    return parse(r);
  };
  await scan('user_manual');
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  return {
    ws,
    root,
    dbPath,
    db,
    graph,
    holder,
    git,
    commit,
    scan,
    fresh: (o = {}) => ensureFresh(o.db ?? db, o.graph ?? graph, 'app', { dbPath, trigger: o.trigger ?? 'read' }),
    cleanup: () => {
      db.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

interface Row {
  repo: string;
  mode: string;
  reason: string;
  trigger: string;
  from_commit: string;
  to_commit: string;
  files_diffed: number;
  files_parsed: number;
  dirs_touched: number;
  concepts_flagged: number;
  ms: number;
}

const rows = (db: TrajectoryDB): Row[] =>
  db
    .all<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'wm_reindex' ORDER BY id`)
    .map((r) => JSON.parse(r.content_json) as Row);

const stamp = (db: TrajectoryDB) => db.get<{ c: string | null }>(`SELECT indexed_commit AS c FROM repos WHERE name = 'app'`)!.c;

const symbol = (db: TrajectoryDB, name: string) =>
  db.get<{ id: number; path: string; start_line: number; signature: string }>(
    `SELECT id, path, start_line, signature FROM wm_symbols WHERE repo = 'app' AND qualified_name = ? AND kind <> 'module'`,
    [name],
  );

const callEdge = (db: TrajectoryDB, from: string, to: string) =>
  db.get<{ dst_id: number | null; resolution: string; dst_path: string | null }>(
    `SELECT e.dst_id, e.resolution, d.path AS dst_path
       FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
      WHERE s.repo = 'app' AND s.qualified_name = ? AND e.kind = 'calls' AND e.dst_name = ?`,
    [from, to],
  );

const danglingEdges = (db: TrajectoryDB) =>
  db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM wm_edges e LEFT JOIN wm_symbols d ON d.id = e.dst_id
      WHERE e.kind = 'calls' AND ((e.dst_id IS NOT NULL AND d.id IS NULL) OR (e.dst_id IS NULL AND e.resolution <> 'unresolved'))`,
  )!.c;

const snapshot = (db: TrajectoryDB) => ({
  symbols: db.all(`SELECT id, path, qualified_name, start_line, end_line, body_hash FROM wm_symbols ORDER BY id`),
  edges: db.all(`SELECT src_id, dst_id, dst_name, kind, resolution FROM wm_edges ORDER BY rowid`),
  dirs: db.all(`SELECT path, file_count FROM wm_directories ORDER BY path`),
  files: db.all(`SELECT path, content_md5 FROM wm_files ORDER BY path`),
  indexed_commit: stamp(db),
});

describe('index at the commit (SC1)', () => {
  it('indexes the target commit, not the working tree', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.commit({ 'src/a.ts': '// moved\n\n\nexport function alpha(): number {\n  return 2;\n}\n' });
      writeFileSync(join(fx.root, 'src/a.ts'), 'export function gamma(): number {\n  return 3;\n}\nexport function alpha(): number {\n  return 9;\n}\n');
      const wm = worldModelTools(fx.db, fx.holder).handlers as Handlers;
      const card = parse(await wm['world_model_symbol']!({ agent: 'swe', qualified_name: 'alpha', repo: 'app' }));
      assert.equal(card['indexed_commit'], head);
      assert.equal(stamp(fx.db), fx.git('rev-parse', 'main'));
      assert.equal(symbol(fx.db, 'alpha')!.start_line, 4, 'line range from the commit');
      assert.equal(symbol(fx.db, 'gamma'), undefined, 'working-tree-only symbol not indexed');
    } finally {
      fx.cleanup();
    }
  });
});

describe('the git-range reindex on every ref move (SC2)', () => {
  it('a 3-file range over a 520-file repo parses exactly 3 files and walks only their dirs', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 26; d++) {
      for (let f = 0; f < 20; f++) files[`d${d}/f${f}.ts`] = `export const v${d}_${f} = ${f};\n`;
    }
    const fx = await fixture(files);
    try {
      assert.ok(fx.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM wm_files WHERE repo = 'app'`)!.c >= 520);
      const head = fx.commit({ 'd0/f0.ts': 'export const v0_0 = 100;\n', 'd0/f1.ts': 'export const v0_1 = 101;\n', 'd0/f2.ts': 'export const v0_2 = 102;\n' });
      const before = rows(fx.db).length;
      const f = await fx.fresh();
      assert.equal(f.mode, 'incremental');
      assert.equal(f.indexed_commit, head);
      const all = rows(fx.db);
      assert.equal(all.length, before + 1);
      const row = all.at(-1)!;
      assert.equal(row.mode, 'incremental');
      assert.equal(row.reason, 'ref_moved');
      assert.equal(row.files_diffed, 3);
      assert.equal(row.files_parsed, 3);
      assert.equal(row.dirs_touched, 2, 'd0 and the repo root only');
    } finally {
      fx.cleanup();
    }
  });

  it('a signature change, a rename and a delete leave callers resolved or unresolved, never dangling', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      assert.equal(callEdge(fx.db, 'beta', 'alpha')?.dst_path, 'src/a.ts');

      fx.commit({ 'src/a.ts': 'export function alpha(n = 0): number {\n  return n;\n}\n' });
      await fx.fresh();
      const sig = callEdge(fx.db, 'beta', 'alpha')!;
      assert.equal(sig.dst_id, symbol(fx.db, 'alpha')!.id, 'relinked to the new alpha');
      assert.notEqual(sig.resolution, 'unresolved');
      assert.equal(danglingEdges(fx.db), 0);

      fx.git('mv', 'src/a.ts', 'src/c.ts');
      fx.commit({ 'src/b.ts': B.replace("'./a.js'", "'./c.js'") });
      await fx.fresh();
      const moved = callEdge(fx.db, 'beta', 'alpha')!;
      assert.equal(moved.dst_path, 'src/c.ts', JSON.stringify(moved));
      assert.equal(moved.dst_id, symbol(fx.db, 'alpha')!.id);
      assert.notEqual(moved.resolution, 'unresolved');
      assert.equal(danglingEdges(fx.db), 0);

      fx.commit({ 'src/c.ts': null });
      await fx.fresh();
      const gone = callEdge(fx.db, 'beta', 'alpha')!;
      assert.equal(gone.dst_id, null);
      assert.equal(gone.resolution, 'unresolved');
      assert.equal(danglingEdges(fx.db), 0);
      assert.ok(rows(fx.db).slice(-3).every((r) => r.mode === 'incremental'));
    } finally {
      fx.cleanup();
    }
  });

  it('a rename that leaves its callers unchanged makes them unresolved when the name has another definition', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B, 'lib/d.ts': A });
    try {
      assert.equal(callEdge(fx.db, 'beta', 'alpha')?.dst_path, 'src/a.ts');
      fx.git('mv', 'src/a.ts', 'src/c.ts');
      fx.commit({});
      await fx.fresh();
      assert.equal(rows(fx.db).at(-1)!.mode, 'incremental');
      const left = callEdge(fx.db, 'beta', 'alpha')!;
      assert.equal(left.dst_id, null, JSON.stringify(left));
      assert.equal(left.resolution, 'unresolved');
      assert.equal(danglingEdges(fx.db), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('no-guess: a rename that leaves its callers importing the old path unlinks them, though the name is unique', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      fx.git('mv', 'src/a.ts', 'src/c.ts');
      fx.commit({});
      await fx.fresh();
      assert.equal(rows(fx.db).at(-1)!.mode, 'incremental');
      const left = callEdge(fx.db, 'beta', 'alpha')!;
      assert.deepEqual({ ...left }, { dst_id: null, resolution: 'unresolved', dst_path: null });
      assert.equal(danglingEdges(fx.db), 0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('reads (SC3)', () => {
  it('resolveRefCommit reads loose, packed, symbolic and worktree refs as git rev-parse does', () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-refs-'));
    try {
      const root = join(ws, 'r');
      mkdirSync(root);
      const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      git(root, 'init', '-q', '-b', 'main');
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
      const one = git(root, 'rev-parse', 'HEAD');
      git(root, 'update-ref', 'refs/remotes/origin/main', one);
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      assert.equal(resolveRefCommit(root, 'HEAD'), one);
      assert.equal(resolveRefCommit(root, 'refs/remotes/origin/main'), one);
      assert.equal(resolveRefCommit(root, 'refs/remotes/origin/HEAD'), one);
      assert.equal(resolveRefCommit(root, 'refs/remotes/origin/missing'), null);
      git(root, 'pack-refs', '--all');
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two');
      const two = git(root, 'rev-parse', 'HEAD');
      assert.equal(resolveRefCommit(root, 'refs/remotes/origin/main'), one, 'packed');
      assert.equal(resolveRefCommit(root, 'HEAD'), two, 'loose wins over packed');
      const wt = join(ws, 'wt');
      git(root, 'worktree', 'add', '-q', '--detach', wt, one);
      assert.equal(resolveRefCommit(wt, 'HEAD'), one, 'linked worktree HEAD');
      assert.equal(resolveRefCommit(wt, 'refs/heads/main'), two, 'linked worktree reads the common dir');
      assert.equal(resolveRefCommit(root, 'HEAD~1'), one, 'a non-ref name asks git');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a no-op read has p95 under 50 ms over 1,000 reads and writes no row', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const before = rows(fx.db).length;
      const times: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const t = performance.now();
        await fx.fresh();
        times.push(performance.now() - t);
      }
      times.sort((x, y) => x - y);
      const p95 = times[Math.floor(times.length * 0.95)]!;
      assert.ok(p95 < 50, `p95 ${p95.toFixed(1)} ms`);
      assert.equal(rows(fx.db).length, before);
    } finally {
      fx.cleanup();
    }
  });

  it('a read while another session holds the lock returns stale:true without waiting', { timeout: 60_000 }, async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const lock = scanLockPath(fx.dbPath, 'app');
    try {
      const old = stamp(fx.db);
      fx.commit({ 'src/a.ts': 'export function alpha(): number {\n  return 7;\n}\n' });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      const before = rows(fx.db).length;
      const f = await fx.fresh();
      assert.ok(existsSync(lock), 'answered while the lock is still held, far inside the 10-minute lock wait');
      assert.equal(f.indexed_commit, old);
      assert.ok(f.stale !== 'all' && f.stale.has('src/a.ts'), JSON.stringify([...(f.stale === 'all' ? [] : f.stale)]));
      const wm = worldModelTools(fx.db, fx.holder).handlers as Handlers;
      const card = parse(await wm['world_model_symbol']!({ agent: 'swe', qualified_name: 'alpha', repo: 'app' }));
      assert.equal((card['symbol'] as { stale?: boolean }).stale, true);
      assert.equal(rows(fx.db).length, before);
      assert.equal(stamp(fx.db), old);
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // already gone
      }
      fx.cleanup();
    }
  });

  it('two concurrent readers on two connections run one reindex', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const db2 = new TrajectoryDB(fx.dbPath);
    try {
      const head = fx.commit({ 'src/a.ts': 'export function alpha(): number {\n  return 8;\n}\n' });
      const before = rows(fx.db).length;
      const [f1, f2] = await Promise.all([fx.fresh(), fx.fresh({ db: db2, graph: new WorldModelGraph(db2) })]);
      assert.equal(f1.indexed_commit, head);
      assert.equal(f2.indexed_commit, head);
      assert.equal(rows(fx.db).length, before + 1);
    } finally {
      db2.close();
      fx.cleanup();
    }
  });
});

describe('full rebuild triggers (SC4) and the wm_reindex row (SC5)', () => {
  it('rebuilds on a NULL stamp, an unreachable commit, an extractor bump, a mismatch row and /scan; startup_catchup runs the range', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.git('rev-parse', 'HEAD');
      const last = () => rows(fx.db).at(-1)!;
      assert.deepEqual([last().mode, last().reason, last().trigger], ['full', 'scan', 'scan']);

      fx.db.run(`UPDATE repos SET indexed_commit = NULL WHERE name = 'app'`);
      assert.equal((await fx.fresh()).mode, 'full');
      assert.deepEqual([last().mode, last().reason, last().from_commit, last().to_commit], ['full', 'null_stamp', '', head]);

      fx.db.run(`UPDATE repos SET indexed_commit = ? WHERE name = 'app'`, ['0123456789abcdef0123456789abcdef01234567']);
      await fx.fresh();
      assert.deepEqual([last().mode, last().reason], ['full', 'unreachable']);

      fx.db.run(`UPDATE repos SET indexed_stamp = '0:0' WHERE name = 'app'`);
      await fx.fresh();
      assert.deepEqual([last().mode, last().reason], ['full', 'stamp_changed']);

      fx.db.run(
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at, repo)
         VALUES (-1, NULL, 'system', 'wm_reindex', 'shadow mismatch', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'app')`,
        [JSON.stringify({ repo: 'app', mode: 'mismatch' })],
      );
      await fx.fresh();
      assert.deepEqual([last().mode, last().reason], ['full', 'mismatch']);
      const count = rows(fx.db).length;
      await fx.fresh();
      assert.equal(rows(fx.db).length, count, 'the full rebuild clears the mismatch');

      fx.commit({ 'src/a.ts': 'export function alpha(): number {\n  return 5;\n}\n' });
      const tip = fx.commit({ 'src/b.ts': B.replace('alpha();', 'alpha() + 1;') });
      await fx.scan('startup_catchup');
      assert.deepEqual([last().mode, last().reason, last().trigger, last().from_commit, last().to_commit], ['incremental', 'ref_moved', 'startup_catchup', head, tip]);
      assert.equal(last().files_diffed, 2);

      await fx.scan('user_manual');
      assert.deepEqual([last().mode, last().reason, last().trigger], ['full', 'scan', 'scan']);

      const keys = ['repo', 'mode', 'reason', 'trigger', 'from_commit', 'to_commit', 'files_diffed', 'files_parsed', 'dirs_touched', 'concepts_flagged', 'ms'] as const;
      const written = rows(fx.db).filter((r) => r.mode !== 'mismatch');
      assert.ok(written.length > 0);
      for (const r of written) for (const k of keys) assert.ok(r[k] !== null && r[k] !== undefined, `${k} in ${JSON.stringify(r)}`);
      for (const r of written) assert.ok(Number.isInteger(r.concepts_flagged), `concepts_flagged in ${JSON.stringify(r)}`);
    } finally {
      fx.cleanup();
    }
  });
});

describe('a full rebuild for another reason reparses while a mismatch is pending (GH 2639)', () => {
  const pendMismatch = (db: TrajectoryDB) =>
    db.run(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at, repo)
       VALUES (-1, NULL, 'system', 'wm_reindex', 'shadow mismatch', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'app')`,
      [JSON.stringify({ repo: 'app', mode: 'mismatch' })],
    );
  const tamper = (db: TrajectoryDB) =>
    db.run(`UPDATE wm_symbols SET signature = 'tampered' WHERE repo = 'app' AND qualified_name = 'beta' AND kind <> 'module'`);
  const forces: ReadonlyArray<readonly [string, string, string | null]> = [
    ['null_stamp', `UPDATE repos SET indexed_commit = ? WHERE name = 'app'`, null],
    ['unreachable', `UPDATE repos SET indexed_commit = ? WHERE name = 'app'`, '0123456789abcdef0123456789abcdef01234567'],
    ['stamp_changed', `UPDATE repos SET indexed_stamp = ? WHERE name = 'app'`, '0:0'],
  ];

  for (const [reason, force, value] of forces) {
    it(`${reason} with a mismatch pending: the rebuild reparses every file and clears the mismatch`, async () => {
      const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
      try {
        tamper(fx.db);
        pendMismatch(fx.db);
        fx.db.run(force, [value]);
        assert.equal((await fx.fresh()).mode, 'full');
        const row = rows(fx.db).at(-1)!;
        assert.deepEqual([row.mode, row.reason], ['full', reason]);
        assert.equal(row.files_parsed, 2);
        assert.notEqual(symbol(fx.db, 'beta')!.signature, 'tampered');
        const count = rows(fx.db).length;
        await fx.fresh();
        assert.equal(rows(fx.db).length, count, 'the full rebuild clears the mismatch');
      } finally {
        fx.cleanup();
      }
    });
  }

  it('stamp_changed with no mismatch pending keeps the stored stamps and parses nothing', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      tamper(fx.db);
      fx.db.run(`UPDATE repos SET indexed_stamp = '0:0' WHERE name = 'app'`);
      assert.equal((await fx.fresh()).mode, 'full');
      const row = rows(fx.db).at(-1)!;
      assert.deepEqual([row.mode, row.reason, row.files_parsed], ['full', 'stamp_changed', 0]);
      assert.equal(symbol(fx.db, 'beta')!.signature, 'tampered');
    } finally {
      fx.cleanup();
    }
  });

  it('/scan with a mismatch pending reparses every file and clears the mismatch', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      tamper(fx.db);
      pendMismatch(fx.db);
      await fx.scan('user_manual');
      const row = rows(fx.db).at(-1)!;
      assert.deepEqual([row.mode, row.reason, row.files_parsed], ['full', 'scan', 2]);
      assert.notEqual(symbol(fx.db, 'beta')!.signature, 'tampered');
      const count = rows(fx.db).length;
      await fx.fresh();
      assert.equal(rows(fx.db).length, count, 'the scan clears the mismatch');
    } finally {
      fx.cleanup();
    }
  });

  it('/scan with no mismatch pending parses nothing', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      tamper(fx.db);
      await fx.scan('user_manual');
      const row = rows(fx.db).at(-1)!;
      assert.deepEqual([row.mode, row.reason, row.files_parsed], ['full', 'scan', 0]);
      assert.equal(symbol(fx.db, 'beta')!.signature, 'tampered');
    } finally {
      fx.cleanup();
    }
  });
});

describe('every successful scan stamps the target commit (SC8)', () => {
  it('(a) a no-op scan_run over an already-stamped repo', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.git('rev-parse', 'main');
      assert.equal(stamp(fx.db), head);
      for (const source of ['user_manual', 'bro_auto_initial', 'startup_catchup']) {
        await fx.scan(source);
        assert.equal(stamp(fx.db), head, source);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('(b) a scan_run after the stamp is set to NULL with no file changes', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.git('rev-parse', 'main');
      for (const source of ['user_manual', 'bro_auto_initial', 'startup_catchup']) {
        fx.db.run(`UPDATE repos SET indexed_commit = NULL WHERE name = 'app'`);
        await fx.scan(source);
        assert.equal(stamp(fx.db), head, source);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('(c) a scan that skips the repo as unchanged, or moves to a commit that changes no file', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.git('rev-parse', 'main');
      const count = rows(fx.db).length;
      await fx.scan('startup_catchup');
      assert.equal(rows(fx.db).length, count, 'the current repo is skipped');
      assert.equal(stamp(fx.db), head);

      fx.git('commit', '-q', '--allow-empty', '-m', 'empty');
      const empty = fx.git('rev-parse', 'main');
      await fx.scan('startup_catchup');
      assert.equal(stamp(fx.db), empty);
      assert.deepEqual([rows(fx.db).at(-1)!.mode, rows(fx.db).at(-1)!.files_diffed], ['incremental', 0]);

      fx.git('commit', '-q', '--allow-empty', '-m', 'empty again');
      const read = fx.git('rev-parse', 'main');
      await fx.fresh();
      assert.equal(stamp(fx.db), read);
    } finally {
      fx.cleanup();
    }
  });

  it('a repo git gave no commit keeps a NULL stamp', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-fresh-unborn-'));
    const db = tempDB({ path: join(ws, 'trajectory.db') });
    try {
      execFileSync('git', ['-C', ws, 'init', '-q', '-b', 'main']);
      writeFileSync(join(ws, 'x.ts'), A);
      const handlers = scanTools(db, GraphHolder.fixed(new WorldModelGraph(db)), join(ws, 'trajectory.db')).handlers as Handlers;
      const r = (await handlers['scan_run']!({ agent: 'bro', session_dir: ws, source: 'user_manual' })) as Raw;
      assert.ok(!r.isError, JSON.stringify(r));
      const repos = db.all<{ c: string | null }>(`SELECT indexed_commit AS c FROM repos`);
      assert.equal(repos.length, 1, 'the unborn repo is registered');
      assert.equal(repos[0]!.c, null);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('spawns (SC6)', () => {
  it('task_provision brings the index to the moved base tip and writes a trigger=spawn row', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B }, { remote: true });
    try {
      fx.db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
                 VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const tip = fx.commit({ 'src/a.ts': 'export function alpha(): number {\n  return 6;\n}\n' });
      assert.notEqual(stamp(fx.db), tip);
      const composites = compositeTools(fx.db, fx.dbPath, fx.holder, { host: 'claude', projectRoot: fx.ws }).handlers as Handlers;
      const r = parse(
        await composites['task_provision']!({
          agent: 'bro',
          issue_id: 1,
          branch_id: 'feat/spawn-reindex',
          decision_body: 'Chosen approach: provision after the base moved.',
          task: {
            description: 'd',
            spec_body: ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n'),
            files: ['src/a.ts'],
            verification: ['true'],
            repo: 'app',
          },
        }),
      );
      assert.equal(typeof r['task_id'], 'number', JSON.stringify(r));
      assert.equal(stamp(fx.db), tip);
      const spawn = rows(fx.db).filter((x) => x.trigger === 'spawn');
      assert.equal(spawn.length, 1);
      assert.equal(spawn[0]!.to_commit, tip);
      assert.equal(spawn[0]!.mode, 'incremental');
    } finally {
      fx.cleanup();
    }
  });

  it('task_brief locations show the moved line range after task_provision, task_reopen and task_retry', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B }, { remote: true });
    try {
      fx.db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
                 VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(fx.db, fx.dbPath, fx.holder, { host: 'claude', projectRoot: fx.ws }).handlers as Handlers;
      const spec = ['## Description', 'Change `alpha` in `src/a.ts`.', '', '## Success Criteria', '- SC1: works'].join('\n');
      const moveAlpha = (pad: number) => fx.commit({ 'src/a.ts': `${'//\n'.repeat(pad)}${A}` });
      const alphaRange = async (taskId: number) => {
        const brief = parse(await composites['task_brief']({ agent: 'bro', task_id: taskId, section: 'core' }));
        const files = (brief['locations'] as { files: Array<{ path: string; symbols: Array<{ qualified_name: string; start_line: number; end_line: number }> }> }).files;
        const alpha = files.find((f) => f.path === 'src/a.ts')?.symbols.find((s) => s.qualified_name === 'alpha');
        assert.ok(alpha, JSON.stringify(brief['locations']));
        return [alpha.start_line, alpha.end_line];
      };
      const spawnRows = () => rows(fx.db).filter((x) => x.trigger === 'spawn');

      const first = moveAlpha(3);
      const provisioned = parse(
        await composites['task_provision']({
          agent: 'bro',
          issue_id: 1,
          branch_id: 'feat/brief-lines',
          decision_body: 'Chosen approach: provision after the base moved.',
          task: { description: 'd', spec_body: spec, files: ['src/a.ts'], verification: ['true'], repo: 'app' },
        }),
      );
      const taskId = provisioned['task_id'] as number;
      assert.equal(typeof taskId, 'number', JSON.stringify(provisioned));
      assert.deepEqual(await alphaRange(taskId), [4, 6]);
      assert.deepEqual(spawnRows().map((r) => r.to_commit), [first]);

      const second = moveAlpha(7);
      const reopened = parse(await composites['task_reopen']({ agent: 'bro', task_id: taskId, reason: 'rework after the base moved' }));
      assert.equal(reopened['status'], 'running', JSON.stringify(reopened));
      assert.deepEqual(await alphaRange(taskId), [8, 10]);
      assert.deepEqual(spawnRows().map((r) => r.to_commit), [first, second]);

      fx.db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [taskId]);
      const third = moveAlpha(12);
      const retried = parse(
        await composites['task_retry']({
          agent: 'bro',
          failed_task_id: String(taskId),
          new_branch_id: 'feat/brief-lines-retry',
          corrected_spec_body: spec,
          retry_rationale: 'retry after the base moved',
          description: 'd',
        }),
      );
      const retryId = retried['task_id'] as number;
      assert.equal(typeof retryId, 'number', JSON.stringify(retried));
      assert.deepEqual(await alphaRange(retryId), [13, 15]);
      assert.deepEqual(spawnRows().map((r) => r.to_commit), [first, second, third]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('a main checkout behind the target', () => {
  it('with HEAD 5 commits behind origin/main, world_model_symbol answers from indexed_commit', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B }, { remote: true });
    try {
      const base = fx.git('rev-parse', 'HEAD');
      let tip = base;
      for (let n = 1; n <= 5; n++) tip = fx.commit({ 'src/a.ts': `${'//\n'.repeat(n)}${A.replace('1', String(n))}` });
      fx.git('reset', '-q', '--hard', base);
      assert.equal(fx.git('rev-list', '--count', 'HEAD..origin/main'), '5');

      const wm = worldModelTools(fx.db, fx.holder).handlers as Handlers;
      const card = parse(await wm['world_model_symbol']({ agent: 'bro', qualified_name: 'alpha', repo: 'app', source: true }));
      assert.equal(card['indexed_commit'], tip);
      assert.equal(stamp(fx.db), tip);
      const sym = card['symbol'] as { start_line: number; end_line: number };
      assert.deepEqual([sym.start_line, sym.end_line], [6, 8]);
      const source = card['source'] as { start_line: number; text: string };
      assert.equal(source.start_line, 6);
      assert.match(source.text, /return 5;/);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the startup catch-up fetches the target first', () => {
  afterEach(() => __setTargetFetchForTests());

  async function withOrigin(): Promise<Fx & { origin: string }> {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const origin = `${fx.ws}-origin.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    fx.git('remote', 'add', 'origin', origin);
    fx.git('push', '-q', '-u', 'origin', 'main');
    await fx.fresh();
    const cleanup = fx.cleanup;
    return { ...fx, origin, cleanup: () => (cleanup(), rmSync(origin, { recursive: true, force: true })) };
  }
  const fetchedAt = (db: TrajectoryDB) => db.get<{ at: string | null }>(`SELECT target_fetched_at AS at FROM wm_freshness WHERE repo = 'app'`)?.at ?? null;

  it('a commit pushed from another clone is indexed by startup_catchup with no other fetch', async () => {
    const fx = await withOrigin();
    const peer = `${fx.ws}-peer`;
    try {
      execFileSync('git', ['clone', '-q', fx.origin, peer]);
      const inPeer = (...a: string[]) => execFileSync('git', ['-C', peer, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...a]).toString().trim();
      writeFileSync(join(peer, 'src/a.ts'), A.replace('1', '7'));
      inPeer('commit', '-qam', 'pushed from a peer');
      inPeer('push', '-q', 'origin', 'main');
      const pushed = inPeer('rev-parse', 'HEAD');
      const before = stamp(fx.db);
      assert.notEqual(before, pushed);
      assert.equal(fx.git('rev-parse', 'refs/remotes/origin/main'), before, 'nothing fetched yet');
      assert.equal(fetchedAt(fx.db), null);

      await fx.scan('startup_catchup');
      assert.equal(fx.git('rev-parse', 'refs/remotes/origin/main'), pushed);
      assert.equal(stamp(fx.db), pushed);
      assert.notEqual(fetchedAt(fx.db), null);
      const row = rows(fx.db).at(-1)!;
      assert.deepEqual([row.mode, row.trigger, row.from_commit, row.to_commit], ['incremental', 'startup_catchup', before, pushed]);
    } finally {
      rmSync(peer, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  it('a failed fetch still reindexes to the local origin/<target branch>', async () => {
    const fx = await withOrigin();
    try {
      const local = fx.commit({ 'src/a.ts': A.replace('1', '8') });
      fx.git('update-ref', 'refs/remotes/origin/main', local);
      const fetches: string[][] = [];
      __setTargetFetchForTests({
        runner: (args) => {
          fetches.push(args);
          return Promise.reject(new Error('remote unreachable'));
        },
      });
      await fx.scan('startup_catchup');
      assert.equal(fetches.length, 1);
      assert.deepEqual(fetches[0].slice(-4), ['fetch', '-q', 'origin', 'main']);
      assert.notEqual(fetchedAt(fx.db), null, 'the attempt is stamped');
      assert.equal(stamp(fx.db), local);
      assert.equal(rows(fx.db).at(-1)!.trigger, 'startup_catchup');
    } finally {
      fx.cleanup();
    }
  });
});

describe('one transaction (SC7)', () => {
  const change = { 'src/a.ts': 'export function alpha(): number {\n  return 4;\n}\n', 'lib/d.ts': 'export function delta(): number {\n  return 4;\n}\n' };

  for (const seam of ['afterGraph', 'afterIndex'] as const) {
    it(`a throw ${seam === 'afterGraph' ? 'after the file writes' : 'after the symbols and stamp'} leaves symbols, edges, dirs and indexed_commit unchanged`, async () => {
      const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
      try {
        const before = snapshot(fx.db);
        fx.commit(change);
        reindexHooks[seam] = () => {
          throw new Error('injected');
        };
        await assert.rejects(fx.fresh(), /injected/);
        assert.deepEqual(snapshot(fx.db), before);
        delete reindexHooks[seam];
        const f = await fx.fresh();
        assert.equal(f.mode, 'incremental');
        assert.ok(symbol(fx.db, 'delta'));
      } finally {
        fx.cleanup();
      }
    });
  }

  it('a second connection reading while a reindex is held open sees only the old snapshot', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const reader = new TrajectoryDB(fx.dbPath);
    try {
      const before = snapshot(reader);
      const head = fx.commit(change);
      let seen: { writer: string | null; reader: ReturnType<typeof snapshot> } | null = null;
      reindexHooks.afterIndex = () => {
        seen = { writer: stamp(fx.db), reader: snapshot(reader) };
      };
      await fx.fresh();
      assert.ok(seen, 'the seam ran inside the reindex');
      const held = seen as { writer: string | null; reader: ReturnType<typeof snapshot> };
      assert.equal(held.writer, head, 'the writer sees its own stamp');
      assert.deepEqual(held.reader, before, 'the reader sees the old snapshot');
      assert.equal(stamp(reader), head);
      assert.ok(symbol(reader, 'delta'));
    } finally {
      reader.close();
      fx.cleanup();
    }
  });

  // F642-1: the reindex's transaction must not span its git reads, or a write
  // another tool call makes on the same connection meanwhile joins it and is
  // lost when it rolls back.
  it('a write another caller makes during the git reads of a failed reindex persists', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = `export function f${i}(): number {\n  return ${i};\n}\n`;
    const fx = await fixture(files);
    const read = CommitContent.prototype.read;
    try {
      fx.db.run('CREATE TABLE concurrent_marks (v INTEGER)');
      const changed: Record<string, string> = {};
      for (let i = 0; i < 60; i++) changed[`src/f${i}.ts`] = `export function f${i}(): number {\n  return ${i + 100};\n}\n`;
      fx.commit(changed);
      const before = snapshot(fx.db);
      let acknowledged = 0;
      let duringReads = 0;
      const write = () => fx.db.transaction(() => fx.db.run('INSERT INTO concurrent_marks VALUES (?)', [acknowledged++]));
      CommitContent.prototype.read = function (this: CommitContent, rel: string) {
        duringReads++;
        write();
        return read.call(this, rel);
      };
      const tick = setInterval(write, 0);
      reindexHooks.afterIndex = () => {
        throw new Error('injected');
      };
      try {
        await assert.rejects(fx.fresh(), /injected/);
      } finally {
        clearInterval(tick);
        CommitContent.prototype.read = read;
      }
      assert.ok(duringReads > 0, 'writes ran during the git reads');
      const kept = fx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM concurrent_marks')!.c;
      assert.equal(kept, acknowledged, 'every acknowledged write persisted');
      assert.deepEqual(snapshot(fx.db), before, 'the reindex itself rolled back');
    } finally {
      CommitContent.prototype.read = read;
      fx.cleanup();
    }
  });

  it('two concurrent reindexes of two repos commit and roll back independently', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const libRoot = join(fx.ws, 'lib');
    const libGit = (...a: string[]) => execFileSync('git', ['-C', libRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const libCommit = (rel: string, body: string) => {
      mkdirSync(dirname(join(libRoot, rel)), { recursive: true });
      writeFileSync(join(libRoot, rel), body);
      libGit('add', '-A');
      libGit('commit', '-qm', 'c');
      return libGit('rev-parse', 'HEAD');
    };
    try {
      mkdirSync(libRoot);
      libGit('init', '-q', '-b', 'main');
      libGit('config', 'user.email', 't@t.io');
      libGit('config', 'user.name', 't');
      libCommit('src/l.ts', 'export function lambda(): number {\n  return 1;\n}\n');
      await fx.scan('user_manual');
      fx.db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'lib'`);
      const libStamp = () => fx.db.get<{ c: string | null }>(`SELECT indexed_commit AS c FROM repos WHERE name = 'lib'`)!.c;
      const libSymbols = () => fx.db.all(`SELECT path, qualified_name, body_hash FROM wm_symbols WHERE repo = 'lib' ORDER BY id`);
      const libBefore = { stamp: libStamp(), symbols: libSymbols() };
      const appTip = fx.commit(change);
      const libTip = libCommit('src/m.ts', 'export function mu(): number {\n  return 2;\n}\n');
      reindexHooks.afterIndex = () => {
        if (libStamp() === libTip) throw new Error('injected');
      };
      const [app, lib] = await Promise.allSettled([
        fx.fresh(),
        ensureFresh(fx.db, fx.graph, 'lib', { dbPath: fx.dbPath, trigger: 'read' }),
      ]);
      assert.equal(app.status, 'fulfilled', String((app as PromiseRejectedResult).reason));
      assert.equal(lib.status, 'rejected');
      assert.equal(stamp(fx.db), appTip, 'the app reindex committed');
      assert.ok(symbol(fx.db, 'delta'), 'with its symbols');
      assert.deepEqual({ stamp: libStamp(), symbols: libSymbols() }, libBefore, 'the lib reindex rolled back alone');
      delete reindexHooks.afterIndex;
      await ensureFresh(fx.db, fx.graph, 'lib', { dbPath: fx.dbPath, trigger: 'read' });
      assert.equal(libStamp(), libTip);
      assert.equal(stamp(fx.db), appTip, 'the lib reindex left the app stamp alone');
    } finally {
      fx.cleanup();
    }
  });
});

interface FreshnessDbRow {
  repo: string;
  target_ref: string | null;
  target_commit: string | null;
  target_fetched_at: string | null;
  reindex_state: string;
  reindex_mode: string | null;
  reindex_trigger: string | null;
  reindex_started_at: string | null;
  reindex_finished_at: string | null;
  reindex_elapsed_ms: number | null;
  reindex_outcome: string | null;
  updated_at: string;
}

const freshnessRow = (db: TrajectoryDB, repo = 'app'): FreshnessDbRow | undefined =>
  db.get<FreshnessDbRow>(`SELECT * FROM wm_freshness WHERE repo = ?`, [repo]);

const fileCount = (db: TrajectoryDB) => db.get<{ n: number }>(`SELECT file_count AS n FROM repos WHERE name = 'app'`)!.n;

describe('a full scan applies in one transaction (GH 2584 task D, SC1)', () => {
  const change = { 'src/a.ts': 'export function alpha(): number {\n  return 11;\n}\n', 'lib/d.ts': 'export function delta(): number {\n  return 11;\n}\n' };
  const scanRaw = async (fx: Fx): Promise<{ error: string | null }> => {
    const handlers = scanTools(fx.db, fx.holder, fx.dbPath).handlers as Handlers;
    try {
      const r = (await handlers['scan_run']!({ agent: 'bro', session_dir: fx.ws, source: 'user_manual' })) as Raw;
      return { error: r.isError ? r.content[0]!.text : null };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  for (const seam of ['afterGraph', 'afterIndex'] as const) {
    it(`a second connection reading at ${seam} sees the pre-scan snapshot, then the new one after commit`, async () => {
      const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
      const reader = new TrajectoryDB(fx.dbPath);
      try {
        const before = { ...snapshot(reader), file_count: fileCount(reader) };
        assert.ok(before.files.length > 0 && before.symbols.length > 0, 'the fixture scan indexed rows');
        const head = fx.commit(change);
        let seen: (ReturnType<typeof snapshot> & { file_count: number }) | null = null;
        reindexHooks[seam] = () => {
          seen = { ...snapshot(reader), file_count: fileCount(reader) };
        };
        assert.equal((await scanRaw(fx)).error, null);
        assert.ok(seen, 'the seam ran inside the scan');
        assert.deepEqual(seen, before, 'the reader saw only the old snapshot, never zero rows');
        assert.equal(stamp(reader), head);
        assert.equal(fileCount(reader), 3);
        assert.ok(symbol(reader, 'delta'), 'the new symbols');
        assert.ok(reader.get(`SELECT 1 AS ok FROM wm_files WHERE repo = 'app' AND path = 'lib/d.ts'`), 'the new files');
      } finally {
        reader.close();
        fx.cleanup();
      }
    });

    it(`a throw at ${seam} rolls back repos, the graph, symbols and the stamp, and marks the reindex failed`, async () => {
      const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
      try {
        const before = { ...snapshot(fx.db), file_count: fileCount(fx.db) };
        fx.commit(change);
        reindexHooks[seam] = () => {
          throw new Error('injected');
        };
        assert.match((await scanRaw(fx)).error ?? '', /injected/);
        assert.deepEqual({ ...snapshot(fx.db), file_count: fileCount(fx.db) }, before);
        const row = freshnessRow(fx.db)!;
        assert.equal(row.reindex_state, 'failed');
        assert.equal(row.reindex_outcome, 'error');
        assert.equal(row.reindex_trigger, 'scan');
        assert.equal(row.reindex_mode, 'full');
        assert.ok(row.reindex_finished_at);
        assert.equal(typeof row.reindex_elapsed_ms, 'number');
      } finally {
        fx.cleanup();
      }
    });
  }
});

describe('wm_freshness (GH 2584 task D, SC3)', () => {
  const tip = { 'src/a.ts': 'export function alpha(): number {\n  return 12;\n}\n' };

  it('a reindex writes running with mode, trigger and started_at before its work, then idle/ok with the target', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B }, { remote: true });
    const reader = new TrajectoryDB(fx.dbPath);
    try {
      const head = fx.commit(tip);
      let during: FreshnessDbRow | undefined;
      reindexHooks.afterGraph = () => {
        during = freshnessRow(reader);
      };
      await fx.fresh();
      assert.equal(during?.reindex_state, 'running', 'a reader sees running while the reindex works');
      assert.equal(during?.reindex_mode, 'incremental');
      assert.equal(during?.reindex_trigger, 'read');
      assert.ok(during?.reindex_started_at);
      assert.equal(during?.reindex_finished_at, null);
      const row = freshnessRow(fx.db)!;
      for (const key of [
        'target_commit', 'reindex_state', 'reindex_mode', 'reindex_trigger', 'reindex_started_at',
        'reindex_finished_at', 'reindex_elapsed_ms', 'reindex_outcome', 'updated_at',
      ] as const) {
        assert.notEqual(row[key], null, key);
      }
      assert.equal(row.target_fetched_at, null, 'ensureFresh alone never fetches, so target_fetched_at stays NULL');
      assert.deepEqual(
        [row.target_ref, row.target_commit, row.reindex_state, row.reindex_mode, row.reindex_trigger, row.reindex_outcome],
        ['origin/main', head, 'idle', 'incremental', 'read', 'ok'],
      );
      assert.equal(typeof row.reindex_elapsed_ms, 'number');
      assert.ok(row.reindex_finished_at! >= row.reindex_started_at!);
    } finally {
      reader.close();
      fx.cleanup();
    }
  });

  it('a failed reindex ends failed/error with finished_at and elapsed_ms', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      fx.commit(tip);
      reindexHooks.afterIndex = () => {
        throw new Error('injected');
      };
      await assert.rejects(fx.fresh(), /injected/);
      const row = freshnessRow(fx.db)!;
      assert.deepEqual([row.reindex_state, row.reindex_outcome, row.reindex_mode], ['failed', 'error', 'incremental']);
      assert.ok(row.reindex_finished_at);
      assert.equal(typeof row.reindex_elapsed_ms, 'number');
    } finally {
      fx.cleanup();
    }
  });

  it('a full scan records mode full, trigger scan and the target in its transaction', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      const head = fx.commit(tip);
      await fx.scan('user_manual');
      const row = freshnessRow(fx.db)!;
      assert.deepEqual(
        [row.reindex_state, row.reindex_mode, row.reindex_trigger, row.reindex_outcome, row.target_ref, row.target_commit],
        ['idle', 'full', 'scan', 'ok', 'HEAD', head],
      );
      assert.equal(stamp(fx.db), head);
    } finally {
      fx.cleanup();
    }
  });

  it('startup_catchup is stored as startup; the audit row keeps startup_catchup', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      fx.commit(tip);
      await ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'startup_catchup' });
      assert.equal(freshnessRow(fx.db)!.reindex_trigger, 'startup');
      assert.equal(rows(fx.db).at(-1)!.trigger, 'startup_catchup');
    } finally {
      fx.cleanup();
    }
  });

  it('the target is written only when it changes', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    try {
      await fx.fresh();
      fx.db.run(`UPDATE wm_freshness SET updated_at = 'sentinel' WHERE repo = 'app'`);
      await fx.fresh();
      assert.equal(freshnessRow(fx.db)!.updated_at, 'sentinel', 'an unchanged target writes nothing');
      const head = fx.commit(tip);
      await fx.fresh();
      const row = freshnessRow(fx.db)!;
      assert.equal(row.target_commit, head);
      assert.notEqual(row.updated_at, 'sentinel');
    } finally {
      fx.cleanup();
    }
  });

  it('the startup sweep fails a running row no live lock holds and keeps one a live lock holds', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B });
    const running = `UPDATE wm_freshness SET reindex_state = 'running', reindex_outcome = NULL, reindex_finished_at = NULL, reindex_elapsed_ms = NULL WHERE repo = 'app'`;
    const repoLock = scanLockPath(fx.dbPath, 'app');
    const workspaceLock = scanLockPath(fx.dbPath);
    try {
      fx.db.run(running);
      assert.ok(tryLock(repoLock));
      assert.deepEqual(sweepStaleAtStartup(fx.db, fx.dbPath), [], 'a live repo lock keeps the row');
      releaseLock(repoLock);
      assert.ok(tryLock(workspaceLock));
      assert.deepEqual(sweepStaleAtStartup(fx.db, fx.dbPath), [], 'a live workspace lock keeps the row');
      releaseLock(workspaceLock);
      assert.equal(freshnessRow(fx.db)!.reindex_state, 'running');
      assert.deepEqual(sweepStaleAtStartup(fx.db, fx.dbPath), ['app']);
      const row = freshnessRow(fx.db)!;
      assert.deepEqual([row.reindex_state, row.reindex_outcome], ['failed', 'error']);
      assert.ok(row.reindex_finished_at);
    } finally {
      releaseLock(repoLock);
      releaseLock(workspaceLock);
      fx.cleanup();
    }
  });
});
