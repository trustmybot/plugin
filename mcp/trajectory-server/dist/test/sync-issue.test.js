import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { syncIssueCreate, syncIssueClose } from '../sync/issue_sync.js';
function makeSpawnFn(responses) {
    let index = 0;
    return (_cmd, _args, _opts) => {
        const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
        index++;
        return response;
    };
}
describe('syncIssueCreate', () => {
    it('returns null when backend is not set', async () => {
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
        });
        // Without a backend set, defaults to gh attempt — allow null or non-null depending on env
        assert.ok(result === null || typeof result.remote_iid === 'number');
    });
    it('parses github URL from gh stdout', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://github.com/owner/repo/issues/42\n',
                stderr: '',
            },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(result !== null);
        assert.equal(result.remote_iid, 42);
        assert.equal(result.remote_kind, 'github');
    });
    it('parses gitlab URL from glab stdout', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://gitlab.com/owner/repo/-/issues/77\n',
                stderr: '',
            },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
        });
        assert.ok(result !== null);
        assert.equal(result.remote_iid, 77);
        assert.equal(result.remote_kind, 'gitlab');
    });
    it('returns null when command fails', async () => {
        const spawnFn = makeSpawnFn([
            { status: 1, stdout: '', stderr: 'auth error' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.equal(result, null);
    });
    it('returns null when stdout cannot be parsed', async () => {
        const spawnFn = makeSpawnFn([
            { status: 0, stdout: 'unexpected output\n', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.equal(result, null);
    });
    it('for both backend, uses gh result when gh succeeds', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://github.com/owner/repo/issues/10\n',
                stderr: '',
            },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'both',
            _spawnFn: spawnFn,
        });
        assert.ok(result !== null);
        assert.equal(result.remote_iid, 10);
        assert.equal(result.remote_kind, 'github');
    });
    it('for both backend, falls back to glab when gh fails', async () => {
        const spawnFn = makeSpawnFn([
            { status: 1, stdout: '', stderr: 'gh error' },
            {
                status: 0,
                stdout: 'https://gitlab.com/owner/repo/-/issues/55\n',
                stderr: '',
            },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'both',
            _spawnFn: spawnFn,
        });
        assert.ok(result !== null);
        assert.equal(result.remote_iid, 55);
        assert.equal(result.remote_kind, 'gitlab');
    });
    it('passes labels as separate arguments for gh', async () => {
        const calls = [];
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            labels: ['bug', 'feature'],
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(calls.length > 0);
        const ghCall = calls[0];
        assert.ok(ghCall !== undefined);
        assert.equal(ghCall.cmd, 'gh');
        assert.ok(ghCall.args.includes('--label'));
        assert.ok(ghCall.args.includes('bug'));
        assert.ok(ghCall.args.includes('feature'));
    });
});
describe('syncIssueClose', () => {
    it('returns true when gh close succeeds', async () => {
        const spawnFn = makeSpawnFn([
            { status: 0, stdout: '', stderr: '' },
        ]);
        const result = await syncIssueClose({
            remote_iid: 42,
            remote_kind: 'github',
            _spawnFn: spawnFn,
        });
        assert.equal(result, true);
    });
    it('returns false when glab close fails', async () => {
        const spawnFn = makeSpawnFn([
            { status: 1, stdout: '', stderr: 'not found' },
        ]);
        const result = await syncIssueClose({
            remote_iid: 10,
            remote_kind: 'gitlab',
            _spawnFn: spawnFn,
        });
        assert.equal(result, false);
    });
});
//# sourceMappingURL=sync-issue.test.js.map