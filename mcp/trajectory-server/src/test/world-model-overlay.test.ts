// The per-task world-model overlay (GH 2957): built at the author's close from
// the task's diff, read first in that task's context and never outside it,
// replaced or rebuilt when the commit moves, and dropped on supersede, cancel
// and merge.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pinScanEnv, setTaskStatus, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { taskTools } from '../tools/tasks.js';
import { compositeTools } from '../tools/composites.js';
import { escalateLiveTasksForIssueClose } from '../tools/lifecycle.js';
import { ensureFresh, reindexIdle } from '../world-model/freshness.js';
import { buildTaskOverlay, overlayView } from '../world-model/overlay.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
type Payload = Record<string, unknown>;

const parse = (r: unknown): Payload => JSON.parse((r as Raw).content[0].text) as Payload;

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  await reindexIdle();
});

const A = 'export function alpha(): number {\n  return 1;\n}\n';
const A_BRANCH = A + '\nexport function gamma(): number {\n  return alpha() + 2;\n}\n';
const B = "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n";
const C = 'export function doomed(): number {\n  return 3;\n}\n';

interface Fx {
  root: string;
  dbPath: string;
  db: TrajectoryDB;
  graph: WorldModelGraph;
  holder: GraphHolder;
  git: (...a: string[]) => string;
  mainSha: string;
  branchCommit: (changes: Record<string, string | null>, msg?: string) => string;
  tasks: Handlers;
  composites: Handlers;
  wm: Handlers;
  cleanup: () => void;
}

async function fixture(): Promise<Fx> {
  const ws = mkdtempSync(join(tmpdir(), 'wm-overlay-'));
  const root = join(ws, 'app');
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim();
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.io');
  git('config', 'user.name', 't');
  for (const [rel, body] of Object.entries({ 'a.ts': A, 'b.ts': B, 'c.ts': C })) write(rel, body);
  git('add', '-A');
  git('commit', '-qm', 'init');
  const mainSha = git('rev-parse', 'HEAD');
  git('branch', 'topic');
  const branchCommit = (changes: Record<string, string | null>, msg = 'branch change') => {
    git('checkout', '-q', 'topic');
    for (const [rel, body] of Object.entries(changes)) {
      if (body === null) git('rm', '-q', rel);
      else write(rel, body);
    }
    git('add', '-A');
    git('commit', '-qm', msg);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };

  const dbDir = mkdtempSync(join(tmpdir(), 'wm-overlay-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const holder = GraphHolder.fixed(graph);
  const scan = (await (scanTools(db, holder, dbPath).handlers as Handlers)['scan_run']({ agent: 'bro', session_dir: ws, source: 'user_manual' })) as Raw;
  assert.ok(!scan.isError, JSON.stringify(scan));
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  db.run(
    `INSERT INTO issues (id, objective, description, status, created_at, updated_at, repo)
     VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'), 'app')`,
  );
  return {
    root,
    dbPath,
    db,
    graph,
    holder,
    git,
    mainSha,
    branchCommit,
    tasks: taskTools(db).handlers,
    composites: compositeTools(db, dbPath, null).handlers,
    wm: worldModelTools(db, holder).handlers,
    cleanup: () => {
      db.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

function seedTask(fx: Fx, branch: string, opts: { status?: string; noCodeClass?: string | null } = {}): number {
  fx.db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, base_sha, no_code_class, created_at, updated_at)
     VALUES (1, ?, 't', 'd', ?, '## Description\nx', 'app', ?, ?, datetime('now'), datetime('now'))`,
    [branch, opts.status ?? 'running', fx.mainSha, opts.noCodeClass ?? null],
  );
  return fx.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
}

function openRun(fx: Fx, agent: string, taskId: number): void {
  fx.db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, ?, datetime('now'))`, [taskId, agent]);
}

async function close(fx: Fx, taskId: number, sha: string): Promise<Payload> {
  const r = (await fx.tasks['task_update_status']({ agent: 'swe', task_id: String(taskId), status: 'submitted', commit_sha: sha })) as Raw;
  assert.ok(!r.isError, r.content[0].text);
  return parse(r);
}

async function symbol(fx: Fx, agent: string, name: string, extra: Payload = {}): Promise<Payload> {
  return parse(await fx.wm['world_model_symbol']({ agent, qualified_name: name, repo: 'app', ...extra }));
}

const sharedSnapshot = (db: TrajectoryDB) => ({
  symbols: db.all<Payload>(`SELECT id, repo, path, kind, qualified_name, start_line, end_line, body_hash FROM wm_symbols ORDER BY id`).map((r) => ({ ...r })),
  edges: db.all<Payload>(`SELECT src_id, dst_id, dst_name, kind, resolution, line FROM wm_edges ORDER BY rowid`).map((r) => ({ ...r })),
});

const overlayRows = (db: TrajectoryDB, taskId: number) => ({
  overlays: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_overlays WHERE task_id = ?', [taskId])!.n,
  files: db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM wm_overlay_files f JOIN wm_overlays v ON v.id = f.overlay_id WHERE v.task_id = ?',
    [taskId],
  )!.n,
  symbols: db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM wm_overlay_symbols s JOIN wm_overlays v ON v.id = s.overlay_id WHERE v.task_id = ?',
    [taskId],
  )!.n,
  edges: db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM wm_overlay_edges e JOIN wm_overlays v ON v.id = e.overlay_id WHERE v.task_id = ?',
    [taskId],
  )!.n,
});

const overlayAudits = (db: TrajectoryDB) =>
  db
    .all<{ issue_id: number; from_node: string; repo: string | null; content_json: string }>(
      `SELECT issue_id, from_node, repo, content_json FROM audit WHERE event_type = 'wm_reindex' AND json_extract(content_json, '$.trigger') = 'overlay' ORDER BY id`,
    )
    .map((r) => ({ ...r, content: JSON.parse(r.content_json) as Payload }));

describe('world model overlay: task-context reads (SC1)', () => {
  it('a symbol added only on the branch resolves in its task context, not in another task or with no context, and the shared index is untouched', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH, 'c.ts': null });
      const own = seedTask(fx, 'feat/overlay');
      const other = seedTask(fx, 'feat/other');
      const shared = sharedSnapshot(fx.db);
      await close(fx, own, sha);
      assert.deepEqual(sharedSnapshot(fx.db), shared, 'the close leaves wm_symbols and wm_edges unchanged');

      openRun(fx, 'code-reviewer', own);
      openRun(fx, 'consultant', other);
      const inTask = await symbol(fx, 'code-reviewer', 'gamma', { impact: 1, source: true });
      const card = inTask['symbol'] as Payload;
      assert.equal(card['path'], 'a.ts');
      assert.ok(Number(card['id']) < 0, 'an overlay symbol carries a negative id');
      assert.equal(card['stale'], false);
      assert.deepEqual(inTask['overlay'], { task_id: own, commit_sha: sha });
      const callees = (inTask['callees'] as { refs: Array<{ qualified_name: string; id: number }> }).refs;
      assert.deepEqual(callees.map((r) => r.qualified_name), ['alpha'], 'gamma calls the branch alpha');
      assert.ok(String((inTask['source'] as Payload)['text']).includes('alpha() + 2'), 'source reads the task commit');

      const alpha = await symbol(fx, 'code-reviewer', 'alpha');
      const callers = (alpha['callers'] as { refs: Array<{ qualified_name: string }> }).refs.map((r) => r.qualified_name).sort();
      assert.deepEqual(callers, ['beta', 'gamma'], 'a shared caller of a re-parsed symbol follows it into the overlay');

      const doomed = parse(await fx.wm['world_model_symbol']({ agent: 'code-reviewer', qualified_name: 'doomed', repo: 'app' }));
      assert.notEqual(doomed['symbol'] !== null && typeof doomed['symbol'] === 'object' ? (doomed['symbol'] as Payload)['path'] : null, 'c.ts', 'a deleted path is hidden');

      for (const agent of ['consultant', 'bro']) {
        const r = (await fx.wm['world_model_symbol']({ agent, qualified_name: 'gamma', repo: 'app' })) as Raw;
        const out = r.isError ? null : parse(r);
        assert.ok(r.isError || out!['symbol'] === null, `${agent} does not see the overlay symbol`);
        assert.equal(out?.['overlay'], undefined);
      }
      const doomedShared = await symbol(fx, 'bro', 'doomed');
      assert.equal((doomedShared['symbol'] as Payload)['path'], 'c.ts', 'with no task context the deleted path still reads from the shared index');
    } finally {
      fx.cleanup();
    }
  });

  it('a shared id from world_model_search resolves in a task context whose overlay re-parsed or deleted its file', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH, 'c.ts': null });
      const task = seedTask(fx, 'feat/overlay-ids');
      const sharedId = (name: string) =>
        fx.db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE qualified_name = ? AND kind != 'module'`, [name])!.id;
      const alphaId = sharedId('alpha');
      const doomedId = sharedId('doomed');
      await close(fx, task, sha);
      openRun(fx, 'code-reviewer', task);

      const searched = parse(await fx.wm['world_model_search']({ agent: 'code-reviewer', query: 'alpha', repo: 'app', mode: 'keyword', k: 20 }));
      const hitIds = (searched['results'] as Array<{ kind: string; id?: number }>).filter((h) => h.kind === 'symbol').map((h) => h.id);
      assert.ok(hitIds.includes(alphaId), 'world_model_search hands out the shared id');

      const alpha = (await fx.wm['world_model_symbol']({ agent: 'code-reviewer', id: alphaId })) as Raw;
      assert.ok(!alpha.isError, alpha.content[0].text);
      const alphaCard = parse(alpha);
      assert.equal((alphaCard['symbol'] as Payload)['qualified_name'], 'alpha');
      assert.ok(Number((alphaCard['symbol'] as Payload)['id']) < 0, 'a re-parsed shared id resolves to its overlay counterpart');
      assert.equal(alphaCard['warning'], undefined);
      const callers = (alphaCard['callers'] as { refs: Array<{ qualified_name: string }> }).refs.map((r) => r.qualified_name).sort();
      assert.deepEqual(callers, ['beta', 'gamma']);

      const doomed = (await fx.wm['world_model_symbol']({ agent: 'code-reviewer', id: doomedId })) as Raw;
      assert.ok(!doomed.isError, doomed.content[0].text);
      const doomedCard = parse(doomed);
      assert.equal((doomedCard['symbol'] as Payload)['id'], doomedId, 'a symbol the branch removed reads the shared row');
      assert.equal((doomedCard['symbol'] as Payload)['path'], 'c.ts');
      assert.equal(doomedCard['warning'], 'removed_on_branch');

      const missing = (await fx.wm['world_model_symbol']({ agent: 'code-reviewer', id: 999_999 })) as Raw;
      assert.ok(missing.isError, 'an id in neither index is still refused');
    } finally {
      fx.cleanup();
    }
  });

  it('a non-code task overlay holds file rows only', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH, 'notes.md': '# notes\n' });
      const task = seedTask(fx, 'docs/overlay', { noCodeClass: 'docs' });
      await close(fx, task, sha);
      const rows = overlayRows(fx.db, task);
      assert.deepEqual(rows, { overlays: 1, files: 2, symbols: 0, edges: 0 });
      assert.equal(fx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_overlay_files f JOIN wm_overlays v ON v.id = f.overlay_id WHERE v.task_id = ? AND f.symbols_md5 IS NOT NULL', [task])!.n, 0);
      openRun(fx, 'code-reviewer', task);
      assert.equal(((await symbol(fx, 'code-reviewer', 'alpha'))['symbol'] as Payload)['path'], 'a.ts');
    } finally {
      fx.cleanup();
    }
  });
});

describe('world model overlay: replace and rebuild (SC2)', () => {
  it('a second close replaces the overlay and removes the old commit rows', async () => {
    const fx = await fixture();
    try {
      const first = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, first);
      assert.ok(overlayRows(fx.db, task).symbols > 0);

      const second = fx.branchCommit({ 'a.ts': A, 'd.ts': 'export function delta(): number {\n  return 4;\n}\n' });
      setTaskStatus(fx.db, task, 'running', 'rework on a second commit');
      await close(fx, task, second);
      assert.equal(fx.db.get<{ c: string }>(`SELECT commit_sha AS c FROM wm_overlays WHERE task_id = ?`, [task])!.c, second);
      const names = fx.db.all<{ qualified_name: string }>('SELECT s.qualified_name FROM wm_overlay_symbols s JOIN wm_overlays v ON v.id = s.overlay_id WHERE v.task_id = ? ORDER BY s.qualified_name', [task]);
      assert.ok(names.some((r) => r.qualified_name === 'delta'));
      assert.ok(!names.some((r) => r.qualified_name === 'gamma'), 'the old commit symbol is gone');
      assert.deepEqual(overlayRows(fx.db, task).overlays, 1);
      assert.equal(overlayAudits(fx.db).length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it('a read after the task commit moved (a rebase) rebuilds the overlay at the new commit', async () => {
    const fx = await fixture();
    try {
      const first = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, first);
      const moved = fx.branchCommit({ 'b.ts': B + '\nexport function epsilon(): number {\n  return 5;\n}\n' });
      fx.db.run(`UPDATE tasks SET commit_sha = ? WHERE id = ?`, [moved, task]);
      openRun(fx, 'code-reviewer', task);
      const out = await symbol(fx, 'code-reviewer', 'epsilon');
      assert.equal((out['symbol'] as Payload)['path'], 'b.ts');
      assert.deepEqual(out['overlay'], { task_id: task, commit_sha: moved });
      assert.equal(fx.db.get<{ c: string }>(`SELECT commit_sha AS c FROM wm_overlays WHERE task_id = ?`, [task])!.c, moved);
      assert.equal(overlayAudits(fx.db).length, 2, 'the rebuild writes its own wm_reindex row');
    } finally {
      fx.cleanup();
    }
  });
});

describe('world model overlay: drops (SC3)', () => {
  it('task_retry of a failed task drops its overlay', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);
      assert.equal(overlayRows(fx.db, task).overlays, 1);
      setTaskStatus(fx.db, task, 'failed', 'the work failed');
      const r = (await fx.composites['task_retry']({
        agent: 'bro',
        failed_task_id: String(task),
        new_branch_id: 'feat/overlay-v2',
        corrected_spec_body: 'retry',
        retry_rationale: 'superseded by a corrected approach',
        description: 'retry',
      })) as Raw;
      assert.ok(!r.isError, r.content[0].text);
      assert.deepEqual(overlayRows(fx.db, task), { overlays: 0, files: 0, symbols: 0, edges: 0 });
    } finally {
      fx.cleanup();
    }
  });

  it('task_retry of a submitted task supersedes it and drops its overlay', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);
      const r = (await fx.composites['task_retry']({
        agent: 'bro',
        failed_task_id: String(task),
        new_branch_id: 'feat/overlay-v2',
        corrected_spec_body: 'retry',
        retry_rationale: 'superseded by a corrected approach',
        description: 'retry',
      })) as Raw;
      assert.ok(!r.isError, r.content[0].text);
      assert.equal(fx.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task])!.status, 'superseded');
      assert.deepEqual(overlayRows(fx.db, task), { overlays: 0, files: 0, symbols: 0, edges: 0 });
    } finally {
      fx.cleanup();
    }
  });

  it('the issue_close cascade drops each cancelled task overlay', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);
      escalateLiveTasksForIssueClose(fx.db, [{ id: task, issue_id: 1, branch_id: 'feat/overlay', status: 'submitted', commit_sha: sha }], 'test', new Date().toISOString());
      assert.equal(overlayRows(fx.db, task).overlays, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('a reindex whose target holds the task commit drops the overlay; one that does not keeps it', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);

      fx.git('commit', '-q', '--allow-empty', '-m', 'unrelated');
      await ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'read' });
      assert.equal(overlayRows(fx.db, task).overlays, 1, 'an unrelated target move keeps the overlay');

      fx.git('merge', '-q', '--no-edit', 'topic');
      await ensureFresh(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, trigger: 'read' });
      assert.equal(overlayRows(fx.db, task).overlays, 0, 'the merged overlay is dropped');
    } finally {
      fx.cleanup();
    }
  });
});

describe('world model overlay: audit (SC4)', () => {
  it('each build writes one wm_reindex row with trigger overlay, task_id, path count and duration_ms', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH, 'c.ts': null });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);
      const rows = overlayAudits(fx.db);
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.issue_id, -1);
      assert.equal(row.from_node, 'system');
      assert.equal(row.repo, 'app');
      assert.equal(row.content['trigger'], 'overlay');
      assert.equal(row.content['mode'], 'overlay');
      assert.equal(row.content['task_id'], task);
      assert.equal(row.content['path_count'], 2);
      assert.equal(row.content['commit_sha'], sha);
      assert.equal(row.content['base_sha'], fx.mainSha);
      assert.equal(typeof row.content['duration_ms'], 'number');
      assert.ok(Number(row.content['duration_ms']) >= 0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('world model overlay: columns populated (SC5)', () => {
  // Writer of every column: buildTaskOverlay (world-model/overlay.ts).
  // Nullable as documented in schema.sql: wm_overlay_files.content_md5 and
  // size_bytes on a deleted path, symbols_md5 on a path not parsed;
  // wm_overlay_symbols.run_order and params_json where the extractor emits
  // none; wm_overlay_edges.dst_overlay_id / dst_symbol_id on an unresolved
  // edge, line and hint where the extractor emits none.
  it('every overlay column is written, null only where documented', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'a.ts': A_BRANCH, 'c.ts': null });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);

      const overlay = fx.db.get<Payload>(`SELECT * FROM wm_overlays WHERE task_id = ?`, [task])!;
      for (const col of ['id', 'task_id', 'repo', 'base_sha', 'commit_sha', 'built_at', 'path_count']) assert.notEqual(overlay[col], null, `wm_overlays.${col}`);
      assert.equal(overlay['path_count'], 2);

      const files = fx.db.all<Payload>('SELECT * FROM wm_overlay_files WHERE overlay_id = ? ORDER BY path', [overlay['id']]);
      for (const f of files) assert.equal(f['overlay_id'], overlay['id'], 'wm_overlay_files.overlay_id');
      assert.deepEqual(files.map((f) => [f['path'], f['status']]), [['a.ts', 'present'], ['c.ts', 'deleted']]);
      const present = files[0];
      for (const col of ['content_md5', 'size_bytes', 'symbols_md5']) assert.notEqual(present[col], null, `wm_overlay_files.${col} on a parsed path`);
      const deleted = files[1];
      for (const col of ['content_md5', 'size_bytes', 'symbols_md5']) assert.equal(deleted[col], null, `wm_overlay_files.${col} on a deleted path`);

      const symbols = fx.db.all<Payload>('SELECT * FROM wm_overlay_symbols WHERE overlay_id = ?', [overlay['id']]);
      assert.ok(symbols.some((s) => s['qualified_name'] === 'gamma'));
      for (const s of symbols) {
        for (const col of ['id', 'overlay_id', 'path', 'kind', 'qualified_name', 'signature', 'doc', 'start_line', 'end_line', 'body_hash', 'exported']) {
          assert.notEqual(s[col], null, `wm_overlay_symbols.${col}`);
        }
      }
      assert.ok(symbols.some((s) => s['params_json'] !== null), 'wm_overlay_symbols.params_json is written for a TS function');

      const edges = fx.db.all<Payload>('SELECT * FROM wm_overlay_edges WHERE overlay_id = ?', [overlay['id']]);
      for (const e of edges) for (const col of ['overlay_id', 'src_id', 'dst_name', 'kind', 'resolution']) assert.notEqual(e[col], null, `wm_overlay_edges.${col}`);
      assert.ok(edges.some((e) => e['dst_overlay_id'] !== null), 'an edge into an overlay symbol fills dst_overlay_id');
      assert.ok(edges.some((e) => e['line'] !== null), 'wm_overlay_edges.line is written');
    } finally {
      fx.cleanup();
    }
  });

  it('an edge into an unchanged shared symbol fills dst_symbol_id', async () => {
    const fx = await fixture();
    try {
      const sha = fx.branchCommit({ 'e.ts': "import { beta } from './b.js';\n\nexport function eta(): number {\n  return beta();\n}\n" });
      const task = seedTask(fx, 'feat/overlay');
      await close(fx, task, sha);
      const betaId = fx.db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE qualified_name = 'beta' AND kind <> 'module'`)!.id;
      const edge = fx.db.get<{ dst_symbol_id: number | null; dst_overlay_id: number | null }>(
        `SELECT dst_symbol_id, dst_overlay_id FROM wm_overlay_edges WHERE dst_name = 'beta' AND kind = 'calls'`,
      );
      assert.deepEqual({ ...edge }, { dst_symbol_id: betaId, dst_overlay_id: null });
      const view = overlayView(task);
      const viaView = fx.db.get<{ dst_id: number }>(`SELECT dst_id FROM ${view.edges} WHERE dst_name = 'beta' AND kind = 'calls' AND src_id < 0`);
      assert.equal(viaView?.dst_id, betaId);
    } finally {
      fx.cleanup();
    }
  });

  it('buildTaskOverlay returns null for a task with no commit', async () => {
    const fx = await fixture();
    try {
      const task = seedTask(fx, 'feat/overlay');
      assert.equal(await buildTaskOverlay(fx.db, task), null);
      assert.equal(overlayRows(fx.db, task).overlays, 0);
    } finally {
      fx.cleanup();
    }
  });
});
