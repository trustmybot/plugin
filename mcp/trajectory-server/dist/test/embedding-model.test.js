import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDB } from './helpers.js';
import { embed, embeddingStatus, embedFailThreshold, embedRetryDelayMs, resetEmbeddingModelForTests, } from '../embeddings/model.js';
import { recordEmbeddingTransitions } from '../embeddings/health.js';
const RETRY_MS = 40;
const VECTOR = [1, 0, 0];
function mockLoader() {
    const m = {
        loads: 0,
        calls: 0,
        failLoad: false,
        failCalls: false,
        loader: async () => {
            m.loads++;
            if (m.failLoad)
                throw new Error('model unavailable');
            return async () => {
                m.calls++;
                if (m.failCalls)
                    throw new Error('embed boom');
                return { data: VECTOR };
            };
        },
    };
    return m;
}
function auditRows(db, eventType) {
    return db.all('SELECT issue_id, from_node, content_json FROM audit WHERE event_type = ? ORDER BY id', [eventType]);
}
describe('embedding model state', () => {
    const savedRetry = process.env['TMB_EMBED_RETRY_MS'];
    const savedThreshold = process.env['TMB_EMBED_FAIL_THRESHOLD'];
    beforeEach(() => {
        process.env['TMB_EMBED_RETRY_MS'] = String(RETRY_MS);
        delete process.env['TMB_EMBED_FAIL_THRESHOLD'];
    });
    after(() => {
        resetEmbeddingModelForTests();
        if (savedRetry === undefined)
            delete process.env['TMB_EMBED_RETRY_MS'];
        else
            process.env['TMB_EMBED_RETRY_MS'] = savedRetry;
        if (savedThreshold === undefined)
            delete process.env['TMB_EMBED_FAIL_THRESHOLD'];
        else
            process.env['TMB_EMBED_FAIL_THRESHOLD'] = savedThreshold;
    });
    it('starts disabled and is ready after the first successful embed', async () => {
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        assert.deepEqual(embeddingStatus(), { state: 'disabled', consecutive_failures: 0 });
        const v = await embed('hello');
        assert.deepEqual(Array.from(v), VECTOR);
        const status = embeddingStatus();
        assert.equal(status.state, 'ready');
        assert.equal(typeof status.since, 'string');
        assert.equal(status.consecutive_failures, 0);
        assert.equal(status.next_retry_at, undefined);
    });
    it('a per-call error does not latch: the next call still embeds', async () => {
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        m.failCalls = true;
        assert.equal(await embed('a'), null);
        assert.equal(embeddingStatus().consecutive_failures, 1);
        assert.equal(embeddingStatus().state, 'ready');
        m.failCalls = false;
        assert.ok(await embed('b'));
        assert.equal(m.calls, 2);
        assert.equal(m.loads, 1, 'the loaded model is reused');
        assert.equal(embeddingStatus().consecutive_failures, 0, 'a success resets the count');
    });
    it('5 consecutive failures degrade once, audit once and schedule a re-attempt', async () => {
        const db = tempDB();
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        m.failCalls = true;
        for (let i = 0; i < 4; i++)
            assert.equal(await embed(`x${i}`), null);
        assert.equal(embeddingStatus().state, 'ready');
        assert.equal(await embed('x4'), null);
        const status = embeddingStatus();
        assert.equal(status.state, 'degraded');
        assert.equal(status.consecutive_failures, 5);
        assert.match(status.reason, /5 consecutive embed failures: embed boom/);
        assert.ok(Date.parse(status.next_retry_at) > Date.now(), 'a re-attempt is scheduled');
        const callsBefore = m.calls;
        assert.equal(await embed('skipped'), null);
        assert.equal(m.calls, callsBefore, 'no call while the re-attempt is not due');
        const rows = auditRows(db, 'embeddings_degraded');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].issue_id, -1);
        assert.equal(rows[0].from_node, 'trajectory-server');
        const content = JSON.parse(rows[0].content_json);
        assert.equal(content.consecutive_failures, 5);
        assert.match(content.reason, /embed boom/);
    });
    it('TMB_EMBED_FAIL_THRESHOLD overrides the threshold', async () => {
        process.env['TMB_EMBED_FAIL_THRESHOLD'] = '2';
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        m.failCalls = true;
        await embed('a');
        assert.equal(embeddingStatus().state, 'ready');
        await embed('b');
        assert.equal(embeddingStatus().state, 'degraded');
    });
    it('a successful re-attempt recovers and audits once', async () => {
        const db = tempDB();
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        m.failCalls = true;
        for (let i = 0; i < 5; i++)
            await embed(`x${i}`);
        assert.equal(embeddingStatus().state, 'degraded');
        m.failCalls = false;
        await sleep(RETRY_MS + 20);
        const v = await embed('back');
        assert.deepEqual(Array.from(v), VECTOR);
        assert.equal(m.loads, 2, 'the re-attempt rebuilds the model');
        const status = embeddingStatus();
        assert.equal(status.state, 'ready');
        assert.equal(status.consecutive_failures, 0);
        assert.equal(auditRows(db, 'embeddings_degraded').length, 1);
        const recovered = auditRows(db, 'embeddings_recovered');
        assert.equal(recovered.length, 1);
        const content = JSON.parse(recovered[0].content_json);
        assert.equal(content.retries, 1);
        assert.equal(typeof content.degraded_since, 'string');
        await embed('again');
        assert.equal(auditRows(db, 'embeddings_recovered').length, 1);
    });
    it('a load failure degrades at once with a re-attempt; a failed re-attempt stays degraded without a second audit row', async () => {
        const db = tempDB();
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        m.failLoad = true;
        assert.equal(await embed('a'), null);
        const first = embeddingStatus();
        assert.equal(first.state, 'degraded');
        assert.match(first.reason, /model load failed: model unavailable/);
        assert.equal(first.consecutive_failures, 1);
        assert.ok(first.next_retry_at);
        assert.equal(auditRows(db, 'embeddings_degraded').length, 1);
        await sleep(RETRY_MS + 20);
        assert.equal(await embed('b'), null);
        assert.equal(m.loads, 2);
        const second = embeddingStatus();
        assert.equal(second.state, 'degraded');
        assert.equal(second.since, first.since);
        assert.ok(Date.parse(second.next_retry_at) > Date.parse(first.next_retry_at));
        assert.equal(auditRows(db, 'embeddings_degraded').length, 1);
        m.failLoad = false;
        await sleep(RETRY_MS + 20);
        assert.ok(await embed('c'));
        assert.equal(embeddingStatus().state, 'ready');
        const recovered = auditRows(db, 'embeddings_recovered');
        assert.equal(recovered.length, 1);
        assert.equal(JSON.parse(recovered[0].content_json).retries, 2);
    });
    it('concurrent callers share one load and one degraded transition', async () => {
        const db = tempDB();
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        m.failLoad = true;
        const results = await Promise.all([embed('a'), embed('b'), embed('c')]);
        assert.deepEqual(results, [null, null, null]);
        assert.equal(m.loads, 1);
        assert.equal(auditRows(db, 'embeddings_degraded').length, 1);
    });
    it('re-attempt schedule is 1 min, 5 min, then every 10 min; TMB_EMBED_RETRY_MS overrides it', () => {
        const env = {};
        assert.equal(embedRetryDelayMs(0, env), 60_000);
        assert.equal(embedRetryDelayMs(1, env), 300_000);
        assert.equal(embedRetryDelayMs(2, env), 600_000);
        assert.equal(embedRetryDelayMs(9, env), 600_000);
        assert.equal(embedRetryDelayMs(3, { TMB_EMBED_RETRY_MS: '250' }), 250);
        assert.equal(embedFailThreshold({}), 5);
        assert.equal(embedFailThreshold({ TMB_EMBED_FAIL_THRESHOLD: 'nope' }), 5);
        assert.equal(embedFailThreshold({ TMB_EMBED_FAIL_THRESHOLD: '3' }), 3);
    });
});
//# sourceMappingURL=embedding-model.test.js.map