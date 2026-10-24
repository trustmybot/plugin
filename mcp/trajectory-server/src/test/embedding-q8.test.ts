import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import {
  MODEL_DTYPE,
  MODEL_ID,
  MODEL_REPO,
  resetEmbeddingModelForTests,
  type EmbeddingLoader,
} from '../embeddings/model.js';
import { embedAndStore, packEmbedding } from '../embeddings/store.js';
import { backfillMissing, countMissing } from '../embeddings/backfill.js';

const Q8_ID = 'Xenova/bge-small-en-v1.5@q8';
const FP32_ID = 'Xenova/bge-small-en-v1.5';
const TS = '2026-01-01T00:00:00Z';

const mockLoader: EmbeddingLoader = async () => async () => ({ data: [1, 0, 0] });

function seedIssue(db: TrajectoryDB): void {
  db.run(
    `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'test', '', 'open', ?, ?)`,
    [TS, TS],
  );
}

const STORED_SQL = {
  discussions: 'SELECT model_id FROM discussions_embeddings WHERE discussion_id = ?',
  wm_files: 'SELECT model_id FROM wm_files_embeddings WHERE file_id = ?',
} as const;

function storedModelIds(db: TrajectoryDB, table: keyof typeof STORED_SQL, id: number): string[] {
  return db.all<{ model_id: string }>(STORED_SQL[table], [id]).map((r) => r.model_id);
}

beforeEach(() => resetEmbeddingModelForTests(mockLoader));
after(() => resetEmbeddingModelForTests(null));

describe('bge-small q8 model constants (GH 1697)', () => {
  it('keys vectors by repo and dtype', () => {
    assert.equal(MODEL_REPO, FP32_ID);
    assert.equal(MODEL_DTYPE, 'q8');
    assert.equal(MODEL_ID, Q8_ID);
  });

  it('embedAndStore stores the q8 model id', async () => {
    const db = tempDB();
    seedIssue(db);
    db.run(
      `INSERT INTO discussions (id, issue_id, author, kind, body, created_at) VALUES (1, 1, 'bro', 'note', 'body', ?)`,
      [TS],
    );
    await embedAndStore(db, 'discussions', 1, 'body');
    assert.deepEqual(storedModelIds(db, 'discussions', 1), [Q8_ID]);
    db.close();
  });
});

describe('backfill re-embeds vectors stored under the fp32 id (GH 1697)', () => {
  it('discussions: an fp32-only row counts as missing and is overwritten with one q8 row', async () => {
    const db = tempDB();
    seedIssue(db);
    db.run(
      `INSERT INTO discussions (id, issue_id, author, kind, body, created_at) VALUES (1, 1, 'bro', 'note', 'body', ?)`,
      [TS],
    );
    db.run(
      'INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
      [1, packEmbedding(new Float32Array([0, 1, 0])), FP32_ID, TS],
    );

    assert.equal(countMissing(db, 'discussions'), 1);
    await backfillMissing(db, 'discussions', -1);
    assert.equal(countMissing(db, 'discussions'), 0);
    assert.deepEqual(storedModelIds(db, 'discussions', 1), [Q8_ID]);
    db.close();
  });

  it('wm_files: an fp32-only row counts as missing and is overwritten with one q8 row', async () => {
    const db = tempDB();
    db.run(
      `INSERT INTO wm_files (id, repo, path, dir, purpose, updated_at) VALUES (1, 'plugin', 'src/a.ts', 'src', 'does a', ?)`,
      [TS],
    );
    db.run(
      'INSERT INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
      [1, packEmbedding(new Float32Array([0, 1, 0])), FP32_ID, TS],
    );

    assert.equal(countMissing(db, 'wm_files'), 1);
    await backfillMissing(db, 'wm_files', -1);
    assert.equal(countMissing(db, 'wm_files'), 0);
    assert.deepEqual(storedModelIds(db, 'wm_files', 1), [Q8_ID]);
    db.close();
  });

  it('a row already embedded under the q8 id is not missing', () => {
    const db = tempDB();
    seedIssue(db);
    db.run(
      `INSERT INTO discussions (id, issue_id, author, kind, body, created_at) VALUES (1, 1, 'bro', 'note', 'body', ?)`,
      [TS],
    );
    db.run(
      'INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
      [1, packEmbedding(new Float32Array([1, 0, 0])), Q8_ID, TS],
    );
    assert.equal(countMissing(db, 'discussions'), 0);
    db.close();
  });
});
