import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { isKuzuLockError, WorldModelGraph, GraphHolder } from '../graph-db.js';
import { scanTools } from '../tools/scan.js';
function parse(r) {
    return JSON.parse(r.content[0].text);
}
async function call(handlers, name, args) {
    return handlers[name](args);
}
function mkRepo(parent, name) {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'r\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    return root;
}
describe('isKuzuLockError — classification (#590/#591)', () => {
    it('matches the kuzu write-lock contention message', () => {
        assert.ok(isKuzuLockError(new Error('IO exception: Could not set lock on file: /x/world-model.kuzu')));
    });
    it('does NOT match an unrelated open failure (missing binding)', () => {
        assert.ok(!isKuzuLockError(new Error("Cannot find module 'kuzu'")));
        assert.ok(!isKuzuLockError(new Error('some other error')));
    });
});
describe('WorldModelGraph.openWithRetry — lock-contention recovery (#590)', () => {
    it('retries on lock error then succeeds once the holder releases', () => {
        let attempts = 0;
        const fakeKuzu = {
            Database: class {
                constructor() {
                    attempts++;
                    if (attempts < 3) {
                        throw new Error('IO exception: Could not set lock on file world-model.kuzu');
                    }
                }
            },
        };
        const db = WorldModelGraph.openWithRetry(fakeKuzu, '/tmp/x.kuzu', 8);
        assert.ok(db);
        assert.equal(attempts, 3, 'should retry until the lock is released');
    });
    it('rethrows a non-lock open error immediately without retrying', () => {
        let attempts = 0;
        const fakeKuzu = {
            Database: class {
                constructor() {
                    attempts++;
                    throw new Error('corrupt database file');
                }
            },
        };
        assert.throws(() => WorldModelGraph.openWithRetry(fakeKuzu, '/tmp/x.kuzu', 8), /corrupt database file/);
        assert.equal(attempts, 1, 'non-lock errors must not be retried');
    });
    it('gives up after maxAttempts and throws the last lock error', () => {
        let attempts = 0;
        const fakeKuzu = {
            Database: class {
                constructor() {
                    attempts++;
                    throw new Error('Could not set lock');
                }
            },
        };
        assert.throws(() => WorldModelGraph.openWithRetry(fakeKuzu, '/tmp/x.kuzu', 3), /Could not set lock/);
        assert.equal(attempts, 3, 'should stop at maxAttempts');
    });
});
describe('scan_run — kuzu-open failure surfaces as graph_db_open_failed (#591)', () => {
    it('reports graph_db_open_failed (NOT a phantom scan-already-running) when the server lost the lock race', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-lockfail-'));
        try {
            mkRepo(ws, 'app');
            const db = tempDB();
            const tools = scanTools(db, GraphHolder.fixed(null, 'IO exception: Could not set lock on file world-model.kuzu'), join(ws, '.claude', 'tmb', 'trajectory.db'));
            const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            assert.ok(result.isError, 'scan_run must error when kuzu open failed on a lock');
            const body = parse(result);
            assert.match(String(body['error']), /graph_db_open_failed/);
            assert.doesNotMatch(String(body['error']), /scan already running/, 'must not synthesize a phantom scan-in-progress message');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('still proceeds as a graph no-op when kuzu is genuinely absent (no lock error)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-nokuzu-'));
        try {
            mkRepo(ws, 'app');
            const db = tempDB();
            // A null holder = no graph, no lock error = kuzu binding missing/sandboxed.
            const tools = scanTools(db, null, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            assert.ok(!result.isError, `scan_run must stay clean when kuzu is absent: ${JSON.stringify(result)}`);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=kuzu-lock-race.test.js.map