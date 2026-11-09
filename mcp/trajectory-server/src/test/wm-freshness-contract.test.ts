// The decision-2487 freshness block every world-model read returns (GH 2584
// task D): its exact keys, value types, enums and stale rule on each of the
// four tools, and equality with the dashboard reader's SQL semantics
// (dashboard/server/freshness.ts) for the same DB.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { compositeTools } from '../tools/composites.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { reindexIdle } from '../world-model/freshness.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;

const parse = (r: unknown): Row => {
  assert.ok(!(r as Raw).isError, JSON.stringify((r as Raw).content));
  return JSON.parse((r as Raw).content[0]!.text) as Row;
};

const TOP_KEYS = ['indexed_commit', 'needs_review_count', 'reindex', 'stale', 'target_commit', 'target_ref'];
const REINDEX_KEYS = ['elapsed_ms', 'finished_at', 'mode', 'outcome', 'started_at', 'state', 'trigger'];
const STATES = ['idle', 'running', 'failed'];
const MODES = ['incremental', 'full'];
const TRIGGERS = ['read', 'spawn', 'startup', 'scan', 'hook', 'fetch'];
const OUTCOMES = ['ok', 'error'];

// The dashboard reader's semantics, restated over a raw connection.
function dashboardBlock(raw: DatabaseSync, repo: string): Row {
  const one = (sql: string): Row | undefined => raw.prepare(sql).get(repo) as Row | undefined;
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const indexed = text(one('SELECT indexed_commit FROM repos WHERE name = ?')?.['indexed_commit']);
  const f = one('SELECT * FROM wm_freshness WHERE repo = ?') ?? {};
  const concepts = one(`SELECT COUNT(*) AS n FROM wm_concepts WHERE repo = ? AND status IN ('suspect','broken')`);
  const readmes = one('SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ? AND readme_review_pending = 1');
  const targetCommit = text(f['target_commit']);
  const state = text(f['reindex_state']) ?? 'idle';
  return {
    indexed_commit: indexed,
    target_ref: text(f['target_ref']),
    target_commit: targetCommit,
    stale: indexed === null || indexed !== targetCommit || state === 'running',
    reindex: {
      state,
      mode: text(f['reindex_mode']),
      trigger: text(f['reindex_trigger']),
      started_at: text(f['reindex_started_at']),
      finished_at: text(f['reindex_finished_at']),
      elapsed_ms: num(f['reindex_elapsed_ms']),
      outcome: text(f['reindex_outcome']),
    },
    needs_review_count: Number(concepts?.['n'] ?? 0) + Number(readmes?.['n'] ?? 0),
  };
}

function assertShape(block: unknown, label: string): Row {
  assert.ok(block && typeof block === 'object', `${label}: freshness is an object`);
  const b = block as Row;
  assert.deepEqual(Object.keys(b).sort(), TOP_KEYS, `${label}: top-level keys`);
  const r = b['reindex'] as Row;
  assert.deepEqual(Object.keys(r).sort(), REINDEX_KEYS, `${label}: reindex keys`);
  for (const k of ['indexed_commit', 'target_ref', 'target_commit']) {
    assert.ok(b[k] === null || typeof b[k] === 'string', `${label}: ${k} string|null`);
  }
  assert.equal(typeof b['stale'], 'boolean', `${label}: stale boolean`);
  assert.ok(Number.isInteger(b['needs_review_count']) && (b['needs_review_count'] as number) >= 0, `${label}: needs_review_count`);
  assert.ok(STATES.includes(r['state'] as string), `${label}: state enum`);
  assert.ok(r['mode'] === null || MODES.includes(r['mode'] as string), `${label}: mode enum`);
  assert.ok(r['trigger'] === null || TRIGGERS.includes(r['trigger'] as string), `${label}: trigger enum`);
  assert.ok(r['outcome'] === null || OUTCOMES.includes(r['outcome'] as string), `${label}: outcome enum`);
  for (const k of ['started_at', 'finished_at']) assert.ok(r[k] === null || typeof r[k] === 'string', `${label}: ${k}`);
  assert.ok(r['elapsed_ms'] === null || Number.isInteger(r['elapsed_ms']), `${label}: elapsed_ms`);
  const stale = b['indexed_commit'] === null || b['indexed_commit'] !== b['target_commit'] || r['state'] === 'running';
  assert.equal(b['stale'], stale, `${label}: stale rule`);
  return b;
}

describe('the freshness block contract (GH 2584 task D, SC4/SC5)', () => {
  let pin: ScanEnvPin;
  let ws: string;
  let dbDir: string;
  let db: TrajectoryDB;
  let raw: DatabaseSync;
  let tools: Record<string, Handler>;
  let taskId: number;
  let symbolId: number;
  let savedTarget: string | undefined;

  before(async () => {
    pin = pinScanEnv();
    resetEmbeddingModelForTests(async () => {
      throw new Error('no model in tests');
    });
    ws = mkdtempSync(join(tmpdir(), 'wm-contract-'));
    const root = join(ws, 'app');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), '// Quokka entry point.\nexport function alpha(): number {\n  return 1;\n}\n');
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'init');
    dbDir = mkdtempSync(join(tmpdir(), 'wm-contract-db-'));
    const dbPath = join(dbDir, 'trajectory.db');
    db = tempDB({ path: dbPath });
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    parse(await scanTools(db, holder, dbPath).handlers['scan_run']!({ agent: 'bro', session_dir: ws, source: 'user_manual' }));
    tools = { ...worldModelTools(db, holder).handlers, task_brief: compositeTools(db, dbPath, holder).handlers['task_brief'] } as Record<string, Handler>;
    symbolId = db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND qualified_name = 'alpha'`)!.id;
    db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`);
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, repo, created_at, updated_at)
       VALUES (last_insert_rowid(), 'fix/2584-contract', 't', 'd', 'pending', '## Description', '["src/a.ts"]', 'app', datetime('now'), datetime('now'))`,
    );
    taskId = db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
    db.run(
      `INSERT INTO wm_concepts (repo, kind, name, status, created_at, updated_at) VALUES
         ('app', 'flow', 'c1', 'suspect', 't', 't'), ('app', 'flow', 'c2', 'broken', 't', 't'), ('app', 'flow', 'c3', 'verified', 't', 't')`,
    );
    raw = new DatabaseSync(dbPath);
    // Reads would bring the index to the target and rewrite the row each case
    // sets; an unresolvable pinned target leaves the DB as the case wrote it.
    savedTarget = process.env['TMB_WM_INDEX_TARGET'];
    process.env['TMB_WM_INDEX_TARGET'] = 'refs/heads/no-such-branch';
  });

  after(async () => {
    if (savedTarget === undefined) delete process.env['TMB_WM_INDEX_TARGET'];
    else process.env['TMB_WM_INDEX_TARGET'] = savedTarget;
    await reindexIdle();
    raw.close();
    db.close();
    resetEmbeddingModelForTests();
    pin.restore();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  const calls = (): Array<[string, () => Promise<unknown>]> => [
    ['world_model_get', () => tools['world_model_get']!({ agent: 'bro', repo: 'app' })],
    ['world_model_search', () => tools['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka', mode: 'keyword' })],
    ['world_model_symbol', () => tools['world_model_symbol']!({ agent: 'bro', id: symbolId })],
    ['task_brief', () => tools['task_brief']!({ agent: 'swe', task_id: taskId })],
  ];

  const indexed = (): string => db.get<{ c: string }>(`SELECT indexed_commit AS c FROM repos WHERE name = 'app'`)!.c;
  const markReadme = (path: string) => db.run(`UPDATE wm_directories SET readme_review_pending = 1 WHERE repo = 'app' AND path = ?`, [path]);
  const pendingReadmes = (): number =>
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_directories WHERE repo = 'app' AND readme_review_pending = 1`)!.n;
  const flagged = () =>
    db.all<Row>(`SELECT id, name, status, status_reason FROM wm_concepts WHERE repo = 'app' AND status IN ('suspect','broken') ORDER BY id`).map((c) => ({ ...c }));
  const COLUMNS = [
    'target_ref', 'target_commit', 'reindex_state', 'reindex_mode', 'reindex_trigger', 'reindex_started_at',
    'reindex_finished_at', 'reindex_elapsed_ms', 'reindex_outcome',
  ] as const;
  const upsert = (cols: Partial<Record<(typeof COLUMNS)[number], string | number>>) => {
    db.run(`DELETE FROM wm_freshness WHERE repo = 'app'`);
    db.run(
      `INSERT INTO wm_freshness (repo, target_ref, target_commit, reindex_state, reindex_mode, reindex_trigger,
         reindex_started_at, reindex_finished_at, reindex_elapsed_ms, reindex_outcome, updated_at)
       VALUES ('app', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-08T00:00:00.000Z')`,
      COLUMNS.map((k) => cols[k] ?? null),
    );
  };
  const finished = { reindex_started_at: '2026-11-08T00:00:00.000Z', reindex_finished_at: '2026-11-08T00:00:01.000Z', reindex_elapsed_ms: 1000 };

  const cases: Array<{ name: string; setup: () => void; stale: boolean; state: string }> = [
    { name: 'no row', setup: () => db.run(`DELETE FROM wm_freshness WHERE repo = 'app'`), stale: true, state: 'idle' },
    {
      name: 'idle at the target',
      setup: () => upsert({ target_ref: 'HEAD', target_commit: indexed(), reindex_state: 'idle', reindex_mode: 'full', reindex_trigger: 'scan', reindex_outcome: 'ok', ...finished }),
      stale: false,
      state: 'idle',
    },
    {
      name: 'running',
      setup: () => upsert({ target_ref: 'HEAD', target_commit: indexed(), reindex_state: 'running', reindex_mode: 'incremental', reindex_trigger: 'read', reindex_started_at: '2026-11-08T00:00:00.000Z' }),
      stale: true,
      state: 'running',
    },
    {
      name: 'failed',
      setup: () => upsert({ target_ref: 'HEAD', target_commit: indexed(), reindex_state: 'failed', reindex_mode: 'full', reindex_trigger: 'startup', reindex_outcome: 'error', ...finished }),
      stale: false,
      state: 'failed',
    },
    {
      name: 'stale target',
      setup: () => upsert({ target_ref: 'origin/main', target_commit: 'f'.repeat(40), reindex_state: 'idle', reindex_mode: 'incremental', reindex_trigger: 'spawn', reindex_outcome: 'ok', ...finished }),
      stale: true,
      state: 'idle',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: each of the four tools returns the 2487 block the dashboard SQL gives`, async () => {
      c.setup();
      for (const [tool, call] of calls()) {
        markReadme('src');
        const expected = dashboardBlock(raw, 'app');
        const out = parse(await call());
        const block = assertShape(out['freshness'], `${c.name} / ${tool}`);
        assert.deepEqual(block, expected, `${c.name} / ${tool}: equals the dashboard block`);
        assert.equal(block['stale'], c.stale, `${c.name} / ${tool}: stale`);
        assert.equal((block['reindex'] as Row)['state'], c.state, `${c.name} / ${tool}: state`);
        assert.equal(block['needs_review_count'], 3, `${c.name} / ${tool}: suspect and broken concepts plus the pending README`);
        if (tool !== 'task_brief') {
          assert.deepEqual(out['needs_review'], { concepts: flagged(), readmes: [{ repo: 'app', path: 'src' }] }, `${c.name} / ${tool}: needs_review`);
          assert.ok(!('needs_review_truncated' in out), `${c.name} / ${tool}: nothing cut`);
          assert.equal(pendingReadmes(), 0, `${c.name} / ${tool}: a bro read clears the README it lists`);
          assert.deepEqual(dashboardBlock(raw, 'app')['needs_review_count'], 2, `${c.name} / ${tool}: the dashboard count drops with it`);
        }
        if (c.name === 'no row') {
          assert.deepEqual(
            { ...(block['reindex'] as Row), target_ref: block['target_ref'], target_commit: block['target_commit'] },
            { state: 'idle', mode: null, trigger: null, started_at: null, finished_at: null, elapsed_ms: null, outcome: null, target_ref: null, target_commit: null },
          );
        }
      }
    });
  }

  it('task_brief carries the block in core and all, not in the other sections', async () => {
    for (const section of ['core', 'all']) {
      assertShape(parse(await tools['task_brief']!({ agent: 'swe', task_id: taskId, section }))['freshness'], section);
    }
    for (const section of ['verification', 'scope', 'history']) {
      assert.ok(!('freshness' in parse(await tools['task_brief']!({ agent: 'swe', task_id: taskId, section }))), section);
    }
  });

  it('needs_review lists at most 20 of each kind, needs_review_truncated gives the totals, the count all of them', async () => {
    db.run(`UPDATE wm_directories SET readme_review_pending = 0 WHERE repo = 'app'`);
    for (let i = 0; i < 23; i++) {
      db.run(`INSERT INTO wm_concepts (repo, kind, name, status, created_at, updated_at) VALUES ('app', 'flow', ?, 'suspect', 't', 't')`, [`cap${i}`]);
    }
    for (let i = 0; i < 22; i++) {
      const path = `cap/d${String(i).padStart(2, '0')}`;
      db.run(
        `INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count, readme_review_pending)
         VALUES ('app', ?, 'cap', 's', 'readme', 0, 1)`,
        [path],
      );
    }
    const allFlagged = flagged();
    assert.equal(allFlagged.length, 25);
    const swe = parse(await tools['world_model_get']!({ agent: 'swe', repo: 'app' }));
    const review = swe['needs_review'] as { concepts: Row[]; readmes: Row[] };
    assert.deepEqual(review.concepts, allFlagged.slice(0, 20), 'the first 20 flagged concepts by id');
    assert.deepEqual(
      review.readmes,
      Array.from({ length: 20 }, (_, i) => ({ repo: 'app', path: `cap/d${String(i).padStart(2, '0')}` })),
      'the first 20 pending READMEs by path',
    );
    assert.deepEqual(swe['needs_review_truncated'], { concepts: 25, readmes: 22 });
    assert.equal((swe['freshness'] as Row)['needs_review_count'], 47);
    assert.deepEqual(dashboardBlock(raw, 'app')['needs_review_count'], 47);
    assert.equal(pendingReadmes(), 22, 'a swe read clears nothing');

    const bro = parse(await tools['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka', mode: 'keyword' }));
    assert.equal((bro['needs_review'] as { readmes: Row[] }).readmes.length, 20);
    assert.equal(pendingReadmes(), 2, 'a bro read clears exactly the 20 it lists');
    const next = parse(await tools['world_model_symbol']!({ agent: 'bro', id: symbolId }));
    assert.deepEqual((next['needs_review'] as { readmes: Row[] }).readmes, [
      { repo: 'app', path: 'cap/d20' },
      { repo: 'app', path: 'cap/d21' },
    ]);
    assert.deepEqual(next['needs_review_truncated'], { concepts: 25, readmes: 2 });
    assert.equal((next['freshness'] as Row)['needs_review_count'], 27);
    assert.equal(pendingReadmes(), 0);
  });
});
