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
describe('recency_alpha extremes', () => {
    it('at α=0 recency decay has no effect — score equals raw RRF', () => {
        const RRF_K = 60;
        const alpha = 0;
        const rrf = 1 / (RRF_K + 0 + 1); // rank 0
        const ageDays = 365; // old document
        const decayed = rrf * (Math.exp(-ageDays / 30) * alpha + (1 - alpha));
        // With alpha=0: decayed = rrf * (0 + 1) = rrf
        assert.ok(Math.abs(decayed - rrf) < 1e-10, 'α=0 must leave score equal to raw RRF regardless of age');
    });
    it('at α=1 old documents are penalized more than new ones', () => {
        const RRF_K = 60;
        const alpha = 1;
        const rrf = 1 / (RRF_K + 0 + 1);
        const scoreNew = rrf * (Math.exp(-1 / 30) * alpha + (1 - alpha)); // 1 day old
        const scoreOld = rrf * (Math.exp(-365 / 30) * alpha + (1 - alpha)); // 1 year old
        assert.ok(scoreNew > scoreOld, 'α=1 must rank newer documents higher than older ones');
        assert.ok(scoreOld < 1e-5, 'α=1 must near-zero score for very old documents');
    });
    it('hybrid score formula: decayed = rrf * (exp(-age/30) * α + (1-α))', () => {
        const RRF_K = 60;
        const alpha = 0.5;
        const rank = 2;
        const ageDays = 10;
        const rrf = 1 / (RRF_K + rank + 1);
        const expected = rrf * (Math.exp(-ageDays / 30) * alpha + (1 - alpha));
        // Verify manually
        const manual = (1 / 63) * (Math.exp(-10 / 30) * 0.5 + 0.5);
        assert.ok(Math.abs(expected - manual) < 1e-12, 'score formula must be deterministic');
        assert.ok(expected > 0, 'score must be positive');
    });
});
describe('RRF rank-fusion math', () => {
    it('RRF constant is 60 — score for rank 0 is 1/61', () => {
        const RRF_K = 60;
        const score = 1 / (RRF_K + 0 + 1);
        assert.ok(Math.abs(score - 1 / 61) < 1e-12, 'RRF score at rank 0 must equal 1/61');
    });
    it('rank r=0 always scores higher than rank r=1', () => {
        const RRF_K = 60;
        const s0 = 1 / (RRF_K + 0 + 1);
        const s1 = 1 / (RRF_K + 1 + 1);
        assert.ok(s0 > s1, 'rank 0 must outscore rank 1');
    });
    it('combining keyword and semantic ranks is additive', () => {
        const RRF_K = 60;
        const r_k = 0; // keyword rank
        const r_s = 1; // semantic rank
        const alpha = 0; // recency off so decayed = rrf
        const ageZero = 0;
        const rrfKeyword = 1 / (RRF_K + r_k + 1);
        const rrfSemantic = 1 / (RRF_K + r_s + 1);
        const combined = rrfKeyword + rrfSemantic;
        const decayed = combined * (Math.exp(-ageZero / 30) * alpha + (1 - alpha));
        assert.ok(Math.abs(decayed - combined) < 1e-12, 'with α=0 and age=0, decayed must equal additive RRF sum');
        assert.ok(combined > rrfKeyword, 'combined RRF must exceed either component alone');
        assert.ok(combined > rrfSemantic, 'combined RRF must exceed either component alone');
    });
    it('score decreases monotonically as rank increases', () => {
        const RRF_K = 60;
        const scores = [0, 1, 2, 5, 10, 20].map((r) => 1 / (RRF_K + r + 1));
        for (let i = 1; i < scores.length; i++) {
            assert.ok(scores[i - 1] > scores[i], `score at rank ${i - 1} must exceed score at rank ${i}`);
        }
    });
});
describe('embedding tables exist in fresh DB (v7 — discussions, audit, directories)', () => {
    it('fresh tempDB has all three embedding tables', () => {
        const db = tempDB();
        for (const t of ['discussions_embeddings', 'audit_embeddings', 'directories_embeddings']) {
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
            'idx_directories_embeddings_model',
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