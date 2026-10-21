import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { embed, embeddingStatus, embedFailThreshold, embedRetryDelayMs, resetEmbeddingModelForTests, __setClockForTests, } from '../embeddings/model.js';
import { recordEmbeddingTransitions } from '../embeddings/health.js';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const VECTOR = [1, 0, 0];
let clock = T0;
function advance(ms) {
    clock += ms;
}
function iso(ms) {
    return new Date(ms).toISOString();
}
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
    return db.all('SELECT issue_id, from_node, content_json FROM audit WHERE event_type = ? AND issue_id = -1 ORDER BY id', [eventType]);
}
function auditCount(db, eventType) {
    return db.get('SELECT COUNT(*) AS n FROM audit WHERE event_type = ? AND issue_id = -1', [eventType]).n;
}
describe('embedding model state', () => {
    const savedRetry = process.env['TMB_EMBED_RETRY_MS'];
    const savedThreshold = process.env['TMB_EMBED_FAIL_THRESHOLD'];
    beforeEach(() => {
        delete process.env['TMB_EMBED_RETRY_MS'];
        delete process.env['TMB_EMBED_FAIL_THRESHOLD'];
        clock = T0;
        __setClockForTests(() => clock);
    });
    after(() => {
        resetEmbeddingModelForTests();
        __setClockForTests();
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
        assert.equal(status.since, iso(T0));
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
        assert.equal(status.since, iso(T0));
        assert.equal(status.consecutive_failures, 5);
        assert.match(status.reason, /5 consecutive embed failures: embed boom/);
        assert.equal(status.next_retry_at, iso(T0 + 60_000), 'the first re-attempt is due 1 min after degrading');
        const callsBefore = m.calls;
        advance(59_999);
        assert.equal(await embed('skipped'), null);
        assert.equal(m.calls, callsBefore, 'no call while the re-attempt is not due');
        assert.equal(m.loads, 1);
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
        assert.equal(auditCount(db, 'embeddings_recovered'), 0);
        const [row] = auditRows(db, 'embeddings_degraded');
        assert.equal(row.from_node, 'trajectory-server');
        const content = JSON.parse(row.content_json);
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
        advance(60_000);
        const v = await embed('back');
        assert.deepEqual(Array.from(v), VECTOR);
        assert.equal(m.loads, 2, 'the re-attempt rebuilds the model');
        const status = embeddingStatus();
        assert.equal(status.state, 'ready');
        assert.equal(status.since, iso(T0 + 60_000));
        assert.equal(status.consecutive_failures, 0);
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
        assert.equal(auditCount(db, 'embeddings_recovered'), 1);
        const content = JSON.parse(auditRows(db, 'embeddings_recovered')[0].content_json);
        assert.equal(content.retries, 1);
        assert.equal(content.degraded_since, iso(T0));
        await embed('again');
        assert.equal(auditCount(db, 'embeddings_recovered'), 1);
    });
    it('a healthy start closes a degraded episode an earlier process left open, once', async () => {
        const db = tempDB();
        const openSince = '2026-01-01T00:00:00.000Z';
        for (const createdAt of ['2025-12-31T23:00:00.000Z', openSince]) {
            db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
         VALUES (-1, 'trajectory-server', 'embeddings_degraded', 's', '{}', ?)`, [createdAt]);
        }
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        assert.ok(await embed('warmup'));
        assert.ok(await embed('again'));
        const rows = auditRows(db, 'embeddings_recovered');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].from_node, 'trajectory-server');
        assert.deepEqual(JSON.parse(rows[0].content_json), { degraded_since: openSince, reason: 'process_start', retries: 0 });
    });
    it('a healthy start with no open degraded episode writes no recovered row', async () => {
        const db = tempDB();
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        recordEmbeddingTransitions(db);
        assert.ok(await embed('warmup'));
        assert.equal(auditCount(db, 'embeddings_recovered'), 0);
        assert.equal(auditCount(db, 'embeddings_degraded'), 0);
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
        assert.equal(first.next_retry_at, iso(T0 + 60_000));
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
        advance(60_000);
        assert.equal(await embed('b'), null);
        assert.equal(m.loads, 2);
        const second = embeddingStatus();
        assert.equal(second.state, 'degraded');
        assert.equal(second.since, first.since);
        assert.equal(second.next_retry_at, iso(T0 + 60_000 + 300_000));
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
        m.failLoad = false;
        advance(299_999);
        assert.equal(await embed('early'), null);
        assert.equal(m.loads, 2, 'no re-attempt before it is due');
        advance(1);
        assert.ok(await embed('c'));
        assert.equal(embeddingStatus().state, 'ready');
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
        assert.equal(auditCount(db, 'embeddings_recovered'), 1);
        assert.equal(JSON.parse(auditRows(db, 'embeddings_recovered')[0].content_json).retries, 2);
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
        assert.equal(auditCount(db, 'embeddings_degraded'), 1);
    });
    it('failed re-attempts follow the 1 min, 5 min, then every 10 min schedule', async () => {
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        m.failLoad = true;
        await embed('a');
        let due = T0 + 60_000;
        assert.equal(embeddingStatus().next_retry_at, iso(due));
        for (const delay of [300_000, 600_000, 600_000]) {
            clock = due;
            assert.equal(await embed('retry'), null);
            due += delay;
            assert.equal(embeddingStatus().next_retry_at, iso(due));
        }
        assert.equal(m.loads, 4);
    });
    it('TMB_EMBED_RETRY_MS sets one fixed re-attempt delay', async () => {
        process.env['TMB_EMBED_RETRY_MS'] = '250';
        const m = mockLoader();
        resetEmbeddingModelForTests(m.loader);
        m.failLoad = true;
        await embed('a');
        assert.equal(embeddingStatus().next_retry_at, iso(T0 + 250));
        advance(250);
        await embed('b');
        assert.equal(embeddingStatus().next_retry_at, iso(T0 + 500));
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