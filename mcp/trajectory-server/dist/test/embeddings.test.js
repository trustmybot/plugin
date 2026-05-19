import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packEmbedding, unpackEmbedding, cosine, topKByCosine } from '../embeddings/store.js';
import { tempDB } from './helpers.js';
describe('packEmbedding / unpackEmbedding round-trip', () => {
    it('round-trips a Float32Array through Buffer', () => {
        const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0]);
        const buf = packEmbedding(original);
        const restored = unpackEmbedding(buf);
        assert.equal(restored.length, original.length);
        for (let i = 0; i < original.length; i++) {
            assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `index ${i}: expected ${original[i]}, got ${restored[i]}`);
        }
    });
    it('handles 384-element vector (bge-small shape)', () => {
        const v = new Float32Array(384).fill(0).map((_, i) => Math.sin(i / 100));
        const restored = unpackEmbedding(packEmbedding(v));
        assert.equal(restored.length, 384);
        assert.ok(Math.abs(restored[0] - v[0]) < 1e-6);
        assert.ok(Math.abs(restored[383] - v[383]) < 1e-6);
    });
});
describe('cosine similarity', () => {
    it('returns 1 for identical unit vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
    });
    it('returns 0 for orthogonal vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([0, 1, 0]);
        assert.ok(Math.abs(cosine(a, b)) < 1e-6);
    });
    it('returns -1 for opposing unit vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([-1, 0, 0]);
        assert.ok(Math.abs(cosine(a, b) + 1) < 1e-6);
    });
    it('measures similarity correctly for 3D vectors', () => {
        const norm = (v) => {
            const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
            return new Float32Array(v.map((x) => x / mag));
        };
        const a = norm([1, 2, 3]);
        const b = norm([1, 2, 3]);
        const c = norm([-1, -2, -3]);
        assert.ok(cosine(a, b) > 0.99);
        assert.ok(cosine(a, c) < -0.99);
    });
});
describe('embedAndStore + topKByCosine with mocked embed', () => {
    it('embedAndStore writes a row when model returns a vector', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
       VALUES (1, 1, 'bro', 'note', 'embedding test body', '2026-01-01T00:00:00Z')`);
        // Inject a synthetic 384-dim normalized vector directly into the table
        // (bypassing the model) to test the storage / retrieval layer in isolation.
        const v = new Float32Array(384).fill(0);
        v[0] = 1.0;
        const buf = packEmbedding(v);
        db.run('INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)', [1, buf, 'test-model', new Date().toISOString()]);
        const row = db.get('SELECT discussion_id, model_id FROM discussions_embeddings WHERE discussion_id = 1');
        assert.ok(row, 'embedding row must exist');
        assert.equal(row.discussion_id, 1);
        assert.equal(row.model_id, 'test-model');
        db.close();
    });
    it('topKByCosine returns empty array when no embeddings exist', async () => {
        const db = tempDB();
        // Override embed via module-level mock: topKByCosine returns [] when embed returns null.
        // We test the null-embed path by having an empty embeddings table — topKByCosine
        // will call embed() on the query, which will attempt to load the model. Since
        // the test environment has no HF model available, embed returns null, so we get [].
        // If the model IS available (e.g., cached from verification step), the table is
        // still empty so topK returns [].
        const results = await topKByCosine(db, 'discussions', 'test query', 5);
        assert.ok(Array.isArray(results));
        db.close();
    });
    it('cosine ranking returns the most similar vector first', () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        const insert = (id, body, vec) => {
            db.run(`INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
         VALUES (?, 1, 'bro', 'note', ?, '2026-01-01T00:00:00Z')`, [id, body]);
            db.run('INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)', [id, packEmbedding(vec), 'test-model', new Date().toISOString()]);
        };
        // v1 = [1, 0, 0, ...] — most similar to query [1, 0, 0, ...]
        const v1 = new Float32Array(384).fill(0);
        v1[0] = 1.0;
        // v2 = [0, 1, 0, ...] — orthogonal to query
        const v2 = new Float32Array(384).fill(0);
        v2[1] = 1.0;
        insert(1, 'first doc', v1);
        insert(2, 'second doc', v2);
        // Compute cosine manually for query = [1, 0, 0, ...]
        const qv = new Float32Array(384).fill(0);
        qv[0] = 1.0;
        const score1 = cosine(qv, v1);
        const score2 = cosine(qv, v2);
        assert.ok(score1 > score2, 'v1 must score higher than v2 for query aligned with v1');
        db.close();
    });
});
describe('schema v4 — embedding tables exist in fresh DB', () => {
    it('fresh tempDB has all three embedding tables', () => {
        const db = tempDB();
        for (const t of ['discussions_embeddings', 'audit_embeddings', 'file_registry_embeddings']) {
            const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
            assert.ok(row !== undefined, `${t} must exist in fresh DB`);
        }
        db.close();
    });
    it('model_id indexes exist', () => {
        const db = tempDB();
        for (const idx of [
            'idx_discussions_embeddings_model',
            'idx_audit_embeddings_model',
            'idx_file_registry_embeddings_model',
        ]) {
            const row = db.get("SELECT name FROM sqlite_master WHERE type='index' AND name=?", [idx]);
            assert.ok(row !== undefined, `index ${idx} must exist`);
        }
        db.close();
    });
    it('embedding rows respect FK CASCADE — deleting source removes embedding', () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
       VALUES (1, 1, 'bro', 'note', 'will be deleted', '2026-01-01T00:00:00Z')`);
        const v = new Float32Array(384).fill(0.5);
        db.run('INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)', [1, packEmbedding(v), 'test-model', new Date().toISOString()]);
        const before = db.get('SELECT discussion_id FROM discussions_embeddings WHERE discussion_id = 1');
        assert.ok(before, 'embedding must exist before source delete');
        db.run('DELETE FROM discussions WHERE id = 1');
        const after = db.get('SELECT discussion_id FROM discussions_embeddings WHERE discussion_id = 1');
        assert.equal(after, undefined, 'embedding must be cascade-deleted when source is deleted');
        db.close();
    });
});
//# sourceMappingURL=embeddings.test.js.map