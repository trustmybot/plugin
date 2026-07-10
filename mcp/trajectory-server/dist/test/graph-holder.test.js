import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GraphHolder, GRAPH_REOPEN_THROTTLE_MS, } from '../graph-db.js';
// The holder is unit-tested with a dependency-injected opener + clock — no real
// kuzu lock is simulated (that stays out of L2, as with the rest of the graph
// suite). A fake graph is any non-null sentinel: the holder only ever stores
// and returns it.
const fakeGraph = { __fake: true };
const LOCK_MSG = 'IO exception: Could not set lock on file world-model.kuzu';
describe('GraphHolder — lazy re-open (GH #1077)', () => {
    it('(a) fail-once-then-succeed: recovers on the next ensureGraph past the throttle window', () => {
        let now = 1000;
        let calls = 0;
        const holder = new GraphHolder({
            open: () => {
                calls++;
                if (calls === 1)
                    throw new Error(LOCK_MSG);
                return fakeGraph;
            },
            now: () => now,
        });
        // First attempt fails on the lock → null graph, lock message recorded.
        assert.equal(holder.ensureGraph(), null, 'first open fails');
        assert.equal(holder.openError, LOCK_MSG, 'lock error surfaced via openError');
        assert.equal(calls, 1);
        // Past the throttle window the holder re-attempts and recovers.
        now += GRAPH_REOPEN_THROTTLE_MS + 1;
        assert.equal(holder.ensureGraph(), fakeGraph, 'recovers once the lock frees');
        assert.equal(calls, 2, 'exactly one retry');
        assert.equal(holder.openError, null, 'recovery clears openError');
        // Subsequent calls return the cached graph without re-opening.
        assert.equal(holder.ensureGraph(), fakeGraph);
        assert.equal(calls, 2, 'no further opens once the graph is live');
    });
    it('(b) throttle: repeated ensureGraph within the window attempts only one open', () => {
        let now = 0;
        let calls = 0;
        const holder = new GraphHolder({
            open: () => {
                calls++;
                throw new Error(LOCK_MSG);
            },
            now: () => now,
        });
        holder.ensureGraph(); // attempt 1 (fails)
        now += 100;
        holder.ensureGraph(); // within window — no attempt
        now += GRAPH_REOPEN_THROTTLE_MS - 200;
        holder.ensureGraph(); // still within window — no attempt
        assert.equal(calls, 1, 'a persistent lock holder must not add per-call open latency');
        // Crossing the window boundary permits the next attempt.
        now += 200;
        holder.ensureGraph();
        assert.equal(calls, 2, 'one more attempt past the throttle window');
    });
    it('(c) persistent failure keeps returning null with an updated openError', () => {
        let now = 0;
        let calls = 0;
        const messages = ['Could not set lock on file A', 'Could not set lock on file B'];
        const holder = new GraphHolder({
            open: () => {
                const msg = messages[Math.min(calls, messages.length - 1)];
                calls++;
                throw new Error(msg);
            },
            now: () => now,
            throttleMs: 100,
        });
        assert.equal(holder.ensureGraph(), null);
        assert.equal(holder.openError, messages[0]);
        now += 200;
        assert.equal(holder.ensureGraph(), null, 'still down');
        assert.equal(holder.openError, messages[1], 'openError tracks the latest failure');
        assert.equal(holder.graph, null);
    });
    it('logs graph_db_open_failed only when the message changes, and graph_db_open on recovery', () => {
        let now = 0;
        let calls = 0;
        const events = [];
        const holder = new GraphHolder({
            open: () => {
                calls++;
                if (calls <= 3)
                    throw new Error(LOCK_MSG); // same message three times
                return fakeGraph;
            },
            now: () => now,
            throttleMs: 100,
            log: (e) => events.push(e),
        });
        holder.attemptOpen(); // fail — logs graph_db_open_failed
        now += 200;
        holder.attemptOpen(); // fail, same message — no new log
        now += 200;
        holder.attemptOpen(); // fail, same message — no new log
        const failLogs = events.filter((e) => e['kind'] === 'graph_db_open_failed');
        assert.equal(failLogs.length, 1, 'repeated identical failures log once (no spam)');
        now += 200;
        holder.attemptOpen(); // success — logs graph_db_open with recovered:true
        const openLogs = events.filter((e) => e['kind'] === 'graph_db_open');
        assert.equal(openLogs.length, 1);
        assert.equal(openLogs[0]['recovered'], true, 'recovery is flagged');
    });
    it('a non-lock failure leaves openError null (scan_run falls through to the no-op path)', () => {
        const holder = new GraphHolder({
            open: () => {
                throw new Error("Cannot find module 'kuzu'");
            },
            now: () => 0,
        });
        assert.equal(holder.ensureGraph(), null);
        assert.equal(holder.openError, null, 'a missing binding is not a lock error');
    });
    it('GraphHolder.fixed(graph) is inert: returns the graph, never invokes an opener', () => {
        const holder = GraphHolder.fixed(fakeGraph);
        assert.equal(holder.ensureGraph(), fakeGraph);
        assert.equal(holder.ensureGraph(), fakeGraph, 'stable across calls');
        assert.equal(holder.openError, null);
    });
    it('GraphHolder.fixed(null, msg) reports the error and never re-opens', () => {
        const holder = GraphHolder.fixed(null, LOCK_MSG);
        assert.equal(holder.ensureGraph(), null);
        assert.equal(holder.openError, LOCK_MSG);
        // Would throw if the fixed opener were ever called.
        assert.doesNotThrow(() => holder.ensureGraph());
    });
});
//# sourceMappingURL=graph-holder.test.js.map