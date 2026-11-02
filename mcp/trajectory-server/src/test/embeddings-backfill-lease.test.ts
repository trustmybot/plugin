import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { MODEL_ID, resetEmbeddingModelForTests, type EmbeddingLoader } from '../embeddings/model.js';
import { packEmbedding } from '../embeddings/store.js';
import {
  BACKFILL_HEARTBEAT_MS,
  BACKFILL_LEASE_STALE_MIN,
  backfillMissing,
  countMissing,
  startBackfill,
  startWorldModelBackfill,
} from '../embeddings/backfill.js';
import { resolveClaudeLogDir } from '../platform.js';
import { tempDB } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'tmb-backfill-lease-'));
const savedDbEnv = process.env['TRAJECTORY_DB_PATH'];
process.env['TRAJECTORY_DB_PATH'] = join(root, 'logs-home', '.claude', 'tmb', 'trajectory.db');
const serverLogPath = join(resolveClaudeLogDir(), 'mcp-server.log');

const TABLES = ['discussions', 'audit', 'wm_directories', 'wm_files'] as const;

let embedCalls: string[] = [];
let gate: Promise<void> | null = null;
let failText: string | null = null;

const countingLoader: EmbeddingLoader = async () => async (text: string) => {
  embedCalls.push(text);
  if (gate) await gate;
  if (text === failText) throw new Error('stub embed failure');
  return { data: [1, 0, 0] };
};

function hold(): () => void {
  let open!: () => void;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    gate = null;
    open();
  };
}

let n = 0;
function fileDbPath(): string {
  const dir = join(root, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'trajectory.db');
}

function seedDiscussions(db: TrajectoryDB, count: number): void {
  db.run(
    `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'lease', '', 'open', '2026-01-01', '2026-01-01')`,
  );
  for (let i = 1; i <= count; i++) {
    db.run(
      `INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
       VALUES (?, 1, 'bro', 'note', ?, '2026-01-01T00:00:00Z')`,
      [i, `row ${i}`],
    );
  }
}

function totalMissing(db: TrajectoryDB): number {
  return TABLES.reduce((sum, t) => sum + countMissing(db, t), 0);
}

function loggedEvents(event: string): Array<Record<string, unknown>> {
  if (!existsSync(serverLogPath)) return [];
  return readFileSync(serverLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e['event'] === event);
}

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function writeLease(lock: string, owner: string, mtime: Date): void {
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), owner);
  utimesSync(lock, mtime, mtime);
}

before(() => rmSync(serverLogPath, { force: true }));
beforeEach(() => {
  resetEmbeddingModelForTests(countingLoader);
  embedCalls = [];
  gate = null;
  failText = null;
});
after(() => {
  resetEmbeddingModelForTests(null);
  if (savedDbEnv === undefined) delete process.env['TRAJECTORY_DB_PATH'];
  else process.env['TRAJECTORY_DB_PATH'] = savedDbEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('boot backfill lease (GH 2257)', () => {
  it('exports a 5 min stale timeout and a 60 s heartbeat', () => {
    assert.equal(BACKFILL_LEASE_STALE_MIN, 5);
    assert.equal(BACKFILL_HEARTBEAT_MS, 60_000);
  });

  it('SC1: two connections started together embed each missing row once; the second skips with lease_held', async () => {
    const path = fileDbPath();
    const db1 = tempDB({ path });
    seedDiscussions(db1, 120);
    const db2 = new TrajectoryDB(path);
    const missing = totalMissing(db1);
    assert.ok(missing >= 120);
    const lock = `${path}.backfill.lock`;

    const release = hold();
    const first = startBackfill(db1, path);
    const second = startBackfill(db2, path);
    await second;
    await waitFor(() => embedCalls.length > 0);
    assert.ok(existsSync(lock), 'lock dir exists mid-backfill');
    assert.ok(readFileSync(join(lock, 'owner'), 'utf8').length > 0, 'owner file written mid-backfill');
    const skipped = loggedEvents('embeddings_backfill_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!['reason'], 'lease_held');
    assert.equal(skipped[0]!['total'], missing);
    release();
    await first;

    assert.equal(embedCalls.length, missing);
    assert.equal(totalMissing(db2), 0);
    assert.ok(!existsSync(lock), 'lease released after the run');
    db1.close();
    db2.close();
  });

  it('SC2: a stale lease is taken over and released after the run', async () => {
    const path = fileDbPath();
    const db = tempDB({ path });
    seedDiscussions(db, 3);
    const lock = `${path}.backfill.lock`;
    writeLease(lock, 'crashed-holder', new Date(Date.now() - (BACKFILL_LEASE_STALE_MIN + 1) * 60_000));
    const missing = totalMissing(db);

    await startBackfill(db, path);

    assert.equal(embedCalls.length, missing);
    assert.equal(totalMissing(db), 0);
    assert.ok(!existsSync(lock), 'lease gone after the run');
    db.close();
  });

  it('SC2: a fresh lease is left alone and the boot backfill skips', async () => {
    const path = fileDbPath();
    const db = tempDB({ path });
    seedDiscussions(db, 3);
    const lock = `${path}.backfill.lock`;
    writeLease(lock, 'live-holder', new Date());
    const missing = totalMissing(db);
    const before = loggedEvents('embeddings_backfill_skipped').length;

    await startBackfill(db, path);

    assert.equal(embedCalls.length, 0);
    assert.equal(totalMissing(db), missing);
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'live-holder');
    assert.equal(loggedEvents('embeddings_backfill_skipped').length, before + 1);
    rmSync(lock, { recursive: true, force: true });
    db.close();
  });

  it('SC2: the heartbeat advances the lock dir mtime while the run is in progress', async () => {
    const path = fileDbPath();
    const db = tempDB({ path });
    seedDiscussions(db, 3);
    const lock = `${path}.backfill.lock`;

    const release = hold();
    const run = startBackfill(db, path, { heartbeatMs: 20 });
    await waitFor(() => embedCalls.length > 0);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lock, old, old);
    const oldMtime = statSync(lock).mtimeMs;
    await waitFor(() => statSync(lock).mtimeMs > oldMtime + 30 * 60_000);
    release();
    await run;

    assert.ok(!existsSync(lock), 'lease gone after the run');
    db.close();
  });
});

describe('backfillMissing re-check (GH 2257)', () => {
  it('SC3: rows embedded through another connection between batches are not re-embedded', async () => {
    const path = fileDbPath();
    const db = tempDB({ path, seedScan: false });
    seedDiscussions(db, 100);
    const other = new TrajectoryDB(path);
    const vec = packEmbedding(new Float32Array([1, 0, 0]));
    let rows = 0;
    const onRow = () => {
      if (++rows !== 50) return;
      for (let id = 1; id <= 10; id++) {
        other.run(
          'INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
          [id, vec, MODEL_ID, new Date().toISOString()],
        );
      }
    };

    const attempted = await backfillMissing(db, 'discussions', -1, onRow);

    assert.equal(attempted, 90);
    assert.equal(embedCalls.length, 90);
    for (let id = 1; id <= 10; id++) assert.ok(!embedCalls.includes(`row ${id}`), `row ${id} not re-embedded`);
    assert.equal(countMissing(db, 'discussions'), 0);
    db.close();
    other.close();
  });

  it('SC3: a failing embed is attempted once per call and the call returns', async () => {
    const db = tempDB({ seedScan: false });
    seedDiscussions(db, 60);
    failText = 'row 5';

    const attempted = await backfillMissing(db, 'discussions', -1);

    assert.equal(attempted, 60);
    assert.equal(embedCalls.filter((t) => t === 'row 5').length, 1);
    assert.equal(countMissing(db, 'discussions'), 1);
    db.close();
  });
});

describe('unleased paths (GH 2257)', () => {
  for (const dbPath of [':memory:', '']) {
    it(`SC4: an in-memory DB (dbPath ${JSON.stringify(dbPath)}) backfills with no lease`, async () => {
      const db = tempDB();
      seedDiscussions(db, 3);
      const missing = totalMissing(db);
      const release = hold();
      const run = startBackfill(db, dbPath);
      await waitFor(() => embedCalls.length > 0);
      assert.ok(!existsSync(`${dbPath}.backfill.lock`), 'no lock dir for an in-memory DB');
      release();
      await run;
      assert.equal(embedCalls.length, missing);
      assert.equal(totalMissing(db), 0);
      db.close();
    });
  }

  it('SC4: the lazy tick embeds at most 50 rows with no lease', async () => {
    const path = fileDbPath();
    const db = tempDB({ path, seedScan: false });
    seedDiscussions(db, 60);
    writeLease(`${path}.backfill.lock`, 'live-holder', new Date());

    assert.equal(await backfillMissing(db, 'discussions'), 50);
    assert.equal(countMissing(db, 'discussions'), 10);
    db.close();
  });

  it('SC4: startWorldModelBackfill embeds world-model rows with no lease', async () => {
    const db = tempDB();
    db.run(
      `INSERT INTO wm_directories (repo, path, summary, summary_source, file_count) VALUES ('app', 'src', 'sources', 'readme', 1)`,
    );
    startWorldModelBackfill(db);
    await waitFor(() => countMissing(db, 'wm_directories') === 0);
    db.close();
  });
});
