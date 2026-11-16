// No symbols for paths the world model does not index (GH 3031): a built
// bundle inside a nested checkout is never listed, and a scan or reindex
// deletes every symbol whose path has no wm_files row and is not a listed
// bundle, along with its edges.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { builtBundleMaps } from '../symbol-index.js';
import { scanTools } from '../tools/scan.js';
import { ensureFresh, reindexIdle } from '../world-model/freshness.js';
import { inWorktreesDir, nestedCheckoutFilter } from '../world-model/nested-checkouts.js';
import { pinScanEnv, tempDB } from './helpers.js';

const MAP = (sources: string[]) => JSON.stringify({ version: 3, file: 'x.js', sources, names: [], mappings: '' });
const ROOT_BUNDLE = 'dist/b.js';

describe('orphan bundle symbols (GH 3031)', () => {
  const pin = pinScanEnv();
  const ws = mkdtempSync(join(tmpdir(), 'wm-orphan-'));
  const root = join(ws, 'app');
  const dbDir = mkdtempSync(join(tmpdir(), 'wm-orphan-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  let db: TrajectoryDB;
  let graph: WorldModelGraph;
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim();
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const scan = async () => {
    const r = await scanTools(db, GraphHolder.fixed(graph), dbPath).handlers['scan_run']({ agent: 'bro', session_dir: ws });
    assert.ok(!r.isError, JSON.stringify(r));
  };
  const orphanCount = () =>
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_symbols s LEFT JOIN wm_files f ON f.repo = s.repo AND f.path = s.path
        WHERE f.path IS NULL AND s.path NOT IN (?)`,
      [ROOT_BUNDLE],
    )!.n;
  const symbolsUnder = (prefix: string) =>
    db.all<{ path: string }>(`SELECT path FROM wm_symbols WHERE repo = 'app' AND path LIKE ? || '%'`, [prefix]).map((r) => r.path);
  const danglingEdges = () =>
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges e LEFT JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
        WHERE s.id IS NULL OR (e.dst_id IS NOT NULL AND d.id IS NULL)`,
    )!.n;
  const seedOrphan = (path: string): number => {
    db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES ('app', ?, 'module', ?, 'h')`, [path, path]);
    const id = db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = ?`, [path])!.id;
    db.run(`INSERT INTO wm_edges (src_id, dst_name, kind, resolution, line) VALUES (?, 'src/a.ts', 'bundles', 'unresolved', 1)`, [id]);
    return id;
  };
  const edgesFrom = (id: number) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_edges WHERE src_id = ?`, [id])!.n;

  let seeded = 0;

  before(async () => {
    mkdirSync(root, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 't');
    write('.gitignore', 'dist/\n.claude/\n');
    write('src/a.ts', 'export function alpha(): number {\n  return 1;\n}\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('worktree', 'add', '-q', '-b', 'x', '.claude/worktrees/x');
    for (const dir of ['.claude/worktrees/x', '.claude/worktrees/stale', '']) {
      const prefix = dir ? `${dir}/` : '';
      const name = dir ? 'a' : 'b';
      write(`${prefix}dist/${name}.js`, 'export const alpha = () => 1;\n');
      write(`${prefix}dist/${name}.js.map`, MAP(['../src/a.ts']));
    }
    db = tempDB({ path: dbPath });
    graph = new WorldModelGraph(db);
    await scan();
    db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
    seeded = seedOrphan('gone/old.js');
    assert.equal(edgesFrom(seeded), 1);
    await scan();
  });

  after(async () => {
    await reindexIdle();
    db.close();
    pin.restore();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('builtBundleMaps lists the root bundle and nothing under a worktree', async () => {
    assert.deepEqual((await builtBundleMaps(root)).map((m) => m.path), [`${ROOT_BUNDLE}.map`]);
  });

  it('stores no symbol for a worktree path and keeps the root bundle module row', () => {
    assert.deepEqual(symbolsUnder('.claude/'), []);
    const bundle = db.all<{ kind: string }>(`SELECT kind FROM wm_symbols WHERE repo = 'app' AND path = ?`, [ROOT_BUNDLE]);
    assert.deepEqual(bundle.map((r) => r.kind), ['module']);
    assert.equal(orphanCount(), 0);
  });

  it('a scan deletes a pre-seeded orphan module row and its edge', () => {
    assert.deepEqual(symbolsUnder('gone/'), []);
    assert.equal(edgesFrom(seeded), 0);
    assert.equal(danglingEdges(), 0);
  });

  it('an incremental reindex deletes an orphan too', async () => {
    const id = seedOrphan('gone/later.js');
    write('src/a.ts', 'export function alpha(): number {\n  return 2;\n}\n');
    git('commit', '-qam', 'change');
    const f = await ensureFresh(db, graph, 'app', { dbPath, trigger: 'read' });
    assert.equal(f.mode, 'incremental');
    assert.deepEqual(symbolsUnder('gone/'), []);
    assert.equal(edgesFrom(id), 0);
    assert.equal(orphanCount(), 0);
    assert.equal(danglingEdges(), 0);
    assert.deepEqual(symbolsUnder(ROOT_BUNDLE), [ROOT_BUNDLE]);
  });
});

describe('nested checkout paths (GH 3031)', () => {
  it('inWorktreesDir matches a .claude/worktrees segment only', () => {
    for (const p of ['.claude/worktrees/x/dist/a.js.map', 'pkg/.claude/worktrees/y/a.js', './a/.claude/worktrees']) assert.ok(inWorktreesDir(p), p);
    for (const p of ['dist/a.js.map', '.claude/worktreesx/a.js', 'x.claude/worktrees/a.js', '.claude/rules/a.md']) assert.ok(!inWorktreesDir(p), p);
  });

  it('nestedCheckoutFilter flags a path below a directory with its own .git, not the repo root', (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'wm-nested-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'vendor/sub/dist'), { recursive: true });
    writeFileSync(join(repo, 'vendor/sub/.git'), 'gitdir: /elsewhere\n');
    const inNested = nestedCheckoutFilter(repo);
    assert.ok(inNested('vendor/sub/dist/a.js.map'));
    assert.ok(inNested('.claude/worktrees/z/dist/a.js.map'));
    assert.ok(!inNested('dist/a.js.map'));
    assert.ok(!inNested('vendor/dist/a.js.map'));
  });
});
