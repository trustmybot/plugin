import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { syncIssueCreate, syncIssueClose, isSyncFailure, verifyRemoteIssue } from '../sync/issue_sync.js';
export function makeSpawnFn(responses) {
    let index = 0;
    return (_cmd, args, _opts) => {
        // Label-taxonomy probes (#36) are auto-answered as "unavailable" so a
        // positional response array [create, verify] stays aligned — a null
        // taxonomy makes the sync path pass every requested label through
        // unchanged. Tests that exercise label splitting supply an explicit,
        // taxonomy-aware spawnFn instead of this positional helper.
        if (args[0] === 'label' && args[1] === 'list') {
            return { status: 1, stdout: '', stderr: 'no taxonomy (test helper)' };
        }
        const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
        index++;
        return response;
    };
}
const GH_VERIFY_OK = { status: 0, stdout: '{"number":42,"url":"https://github.com/owner/repo/issues/42"}', stderr: '' };
const GLAB_VERIFY_OK = { status: 0, stdout: 'issue 77 details', stderr: '' };
describe('syncIssueCreate', () => {
    it('returns SyncFailure(no_backend) when backend is not set', async () => {
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
        });
        assert.ok(isSyncFailure(result));
        assert.equal(result.reason, 'no_backend');
    });
    it('parses github URL from gh stdout', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://github.com/owner/repo/issues/42\n',
                stderr: '',
            },
            { status: 0, stdout: '{"number":42,"url":"https://github.com/owner/repo/issues/42"}', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
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
            GLAB_VERIFY_OK,
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
        assert.equal(result.remote_iid, 77);
        assert.equal(result.remote_kind, 'gitlab');
    });
    it('parses gitlab work_items URL from glab stdout (current glab ≥1.40, #2875)', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://gitlab.com/trustmybot/plugin/-/work_items/2874\n',
                stderr: '',
            },
            { status: 0, stdout: 'work_item 2874 details', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
        assert.equal(result.remote_iid, 2874);
        assert.equal(result.remote_kind, 'gitlab');
    });
    it('parses bare-iid `#42` stdout form (older gh/glab, #2875)', async () => {
        const spawnFn = makeSpawnFn([
            { status: 0, stdout: '#42\n', stderr: '' },
            { status: 0, stdout: '{"number":42,"url":"https://github.com/owner/repo/issues/42"}', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
        assert.equal(result.remote_iid, 42);
        assert.equal(result.remote_kind, 'github');
    });
    it('returns SyncFailure with stderr+exit_code when command fails (#2871)', async () => {
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
        assert.ok(isSyncFailure(result));
        assert.equal(result.reason, 'non_zero_exit');
        assert.equal(result.exit_code, 1);
        assert.equal(result.stderr, 'auth error');
        assert.equal(result.backend, 'gh');
    });
    it('returns SyncFailure with parse_failed reason when stdout is unrecognised (#2871)', async () => {
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
        assert.ok(isSyncFailure(result));
        assert.equal(result.reason, 'parse_failed');
        assert.equal(result.stdout, 'unexpected output\n');
    });
    it('parses gitlab subgroup URL (3-segment) from glab stdout (#345)', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://gitlab.com/group/sub/proj/-/issues/5\n',
                stderr: '',
            },
            { status: 0, stdout: 'issue 5 details', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result), `Expected success, got: ${JSON.stringify(result)}`);
        assert.equal(result.remote_iid, 5);
        assert.equal(result.remote_kind, 'gitlab');
    });
    it('subgroup remote URL passes extractRemoteHostAndRepo verify (#345)', async () => {
        const subgroupRemoteUrl = 'https://gitlab.com/group/sub/proj.git';
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://gitlab.com/group/sub/proj/-/issues/5\n',
                stderr: '',
            },
            { status: 0, stdout: 'issue 5 details', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
            _remoteUrl: subgroupRemoteUrl,
        });
        assert.ok(!isSyncFailure(result), `Expected success for subgroup URL, got: ${JSON.stringify(result)}`);
        assert.equal(result.remote_iid, 5);
    });
    it('both backend is rejected by syncIssueCreate — dual-create is issue_create only (#345)', async () => {
        const spawnFn = makeSpawnFn([]);
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'both',
            _spawnFn: spawnFn,
        });
        assert.ok(isSyncFailure(result));
        assert.equal(result.reason, 'no_backend');
        assert.ok((result.message ?? '').includes('issue_create'));
    });
    it('passes labels as separate arguments for gh', async () => {
        const calls = [];
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
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
        const ghCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
        assert.ok(ghCall !== undefined);
        assert.equal(ghCall.cmd, 'gh');
        assert.ok(ghCall.args.includes('--label'));
        assert.ok(ghCall.args.includes('bug'));
        assert.ok(ghCall.args.includes('feature'));
    });
    it('passes milestone as a --milestone argument for gh (#83/#763)', async () => {
        const calls = [];
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            milestone: 'v0.10.0',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        const ghCall = calls[0];
        assert.ok(ghCall !== undefined);
        assert.equal(ghCall.cmd, 'gh');
        const mIdx = ghCall.args.indexOf('--milestone');
        assert.ok(mIdx >= 0, 'gh create must include --milestone');
        assert.equal(ghCall.args[mIdx + 1], 'v0.10.0');
    });
    it('passes milestone as a --milestone argument for glab (#83/#763)', async () => {
        const calls = [];
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            return { status: 0, stdout: 'https://gitlab.com/owner/repo/-/issues/1\n', stderr: '' };
        };
        await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            milestone: 'v0.10.0',
            _backend: 'glab',
            _spawnFn: spawnFn,
        });
        const glabCall = calls[0];
        assert.ok(glabCall !== undefined);
        assert.equal(glabCall.cmd, 'glab');
        const mIdx = glabCall.args.indexOf('--milestone');
        assert.ok(mIdx >= 0, 'glab create must include --milestone');
        assert.equal(glabCall.args[mIdx + 1], 'v0.10.0');
    });
    it('omits --milestone when no milestone is given (#83/#763)', async () => {
        const calls = [];
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        const ghCall = calls[0];
        assert.ok(ghCall !== undefined);
        assert.ok(!ghCall.args.includes('--milestone'), 'no --milestone when milestone omitted');
    });
    it('rejects iid from incidental #N in stdout; only the created-URL iid is used (#314)', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'Mentioned in #30 and also see PR #15\nhttps://github.com/owner/repo/issues/310\n',
                stderr: '',
            },
            { status: 0, stdout: '{"number":310,"url":"https://github.com/owner/repo/issues/310"}', stderr: '' },
        ]);
        const result = await syncIssueCreate({
            issueId: 5,
            title: 'Real issue',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result), `Expected success, got failure: ${JSON.stringify(result)}`);
        assert.equal(result.remote_iid, 310, 'should use URL iid 310, not incidental #30 or #15');
        assert.equal(result.remote_kind, 'github');
    });
    it('returns verify_failed when read-back shows url contains /pull/ (#314)', async () => {
        const spawnFn = makeSpawnFn([
            {
                status: 0,
                stdout: 'https://github.com/owner/repo/issues/30\n',
                stderr: '',
            },
            {
                status: 0,
                stdout: '{"number":30,"url":"https://github.com/owner/repo/pull/30"}',
                stderr: '',
            },
        ]);
        const result = await syncIssueCreate({
            issueId: 5,
            title: 'Real issue',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(isSyncFailure(result), 'Expected failure when read-back shows PR');
        assert.equal(result.reason, 'verify_failed');
    });
    it('syncIssueCreate writes logs to TMB_SYNC_LOG_DIR, not ~/.claude/ (log-isolation, #314)', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-test-sync-'));
        const savedLogDir = process.env.TMB_SYNC_LOG_DIR;
        process.env.TMB_SYNC_LOG_DIR = tmpDir;
        // Use a sentinel string unique to this test invocation so we can check the
        // real log was NOT written to even if it already contains prior entries.
        const sentinel = `blast-radius-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try {
            const spawnFn = (_cmd, args, _opts) => {
                if (args[0] === 'issue' && args[1] === 'view') {
                    return { status: 0, stdout: '{"number":42,"url":"https://github.com/x/y/issues/42"}', stderr: '' };
                }
                return {
                    status: 0,
                    stdout: 'https://github.com/x/y/issues/42\n',
                    stderr: '',
                };
            };
            await syncIssueCreate({
                issueId: 99,
                title: sentinel,
                body: 'Body',
                _backend: 'gh',
                _spawnFn: spawnFn,
            });
            const logPath = join(tmpDir, 'issue-sync.log');
            assert.ok(existsSync(logPath), 'issue-sync.log should exist in the temp dir, not elsewhere');
            const content = readFileSync(logPath, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            assert.ok(lines.length > 0, 'at least one log line should be written');
            const entries = lines.map((line) => JSON.parse(line));
            const warningEntry = entries.find((e) => e['kind'] === 'issue_sync_active');
            assert.ok(warningEntry !== undefined, 'issue_sync_active entry should be present');
            assert.equal(warningEntry['backend'], 'gh');
            assert.equal(warningEntry['issue_id'], 99);
            assert.equal(warningEntry['title'], sentinel);
            const successEntry = entries.find((e) => e['event'] === 'issue_create_success');
            assert.ok(successEntry !== undefined, 'issue_create_success entry must be present on success path');
            assert.equal(successEntry['iid'], 42, 'success log must include parsed iid');
            assert.ok(typeof successEntry['stdout'] === 'string', 'success log must include raw stdout');
            // The sentinel title must NOT appear in the real ~/.claude/ log — that's the
            // blast-radius check. The real log may already have unrelated entries; only
            // the sentinel (unique to this run) would indicate a live leak.
            const realLogDir = join(homedir(), '.claude');
            const tmbLogDir = join(realLogDir, 'tmb', 'logs', 'issue-sync.log');
            assert.ok(!existsSync(tmbLogDir) || !readFileSync(tmbLogDir, 'utf8').includes(sentinel), 'should NOT write test entries to the real ~/.claude/ log path');
        }
        finally {
            if (savedLogDir === undefined) {
                delete process.env.TMB_SYNC_LOG_DIR;
            }
            else {
                process.env.TMB_SYNC_LOG_DIR = savedLogDir;
            }
        }
    });
});
describe('syncIssueCreate cwd injection', () => {
    it('passes _cwd to spawnOpts for both create and verify calls', async () => {
        const capturedOpts = [];
        const spawnFn = (_cmd, args, opts) => {
            capturedOpts.push(opts);
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
            _cwd: '/workspace/plugin',
        });
        assert.ok(result !== null);
        assert.ok(capturedOpts.length >= 1, 'at least one spawn call should be made');
        assert.ok(capturedOpts[0] !== undefined);
        assert.ok(typeof capturedOpts[0].cwd === 'string' && capturedOpts[0].cwd.endsWith('/plugin'), `expected cwd to end with /plugin, got: ${String(capturedOpts[0].cwd)}`);
    });
    it('leaves spawnOpts.cwd undefined when _cwd is not provided', async () => {
        const capturedOpts = [];
        const spawnFn = (_cmd, args, opts) => {
            capturedOpts.push(opts);
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":2,"url":"https://github.com/owner/repo/issues/2"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/2\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 2,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(result !== null);
        assert.ok(capturedOpts.length >= 1, 'at least one spawn call should be made');
        assert.ok(capturedOpts[0] !== undefined);
        assert.equal(capturedOpts[0].cwd, undefined, 'cwd should be undefined when _cwd is not provided');
    });
});
describe('syncIssueCreate readBackVerify repo slug (#1029)', () => {
    it('threads _repoSlug into the gh issue view verify call', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":9,"url":"https://github.com/owner/repo/issues/9"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/9\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
            _repoSlug: 'github.com/owner/repo',
        });
        assert.ok(!isSyncFailure(result));
        const viewCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'view');
        assert.ok(viewCall !== undefined, 'gh issue view must be called for readback verify');
        const rIdx = viewCall.args.indexOf('--repo');
        assert.ok(rIdx >= 0, 'verify view must carry --repo');
        assert.equal(viewCall.args[rIdx + 1], 'github.com/owner/repo');
    });
    it('threads _repoSlug into the glab issue view verify call', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: 'issue 9 details', stderr: '' };
            }
            return { status: 0, stdout: 'https://gitlab.com/owner/repo/-/issues/9\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'glab',
            _spawnFn: spawnFn,
            _repoSlug: 'gitlab.com/owner/repo',
        });
        assert.ok(!isSyncFailure(result));
        const viewCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'view');
        assert.ok(viewCall !== undefined, 'glab issue view must be called for readback verify');
        const rIdx = viewCall.args.indexOf('-R');
        assert.ok(rIdx >= 0, 'verify view must carry -R');
        assert.equal(viewCall.args[rIdx + 1], 'gitlab.com/owner/repo');
    });
    it('omits the repo flag on verify when _repoSlug is not set', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":9,"url":"https://github.com/owner/repo/issues/9"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/9\n', stderr: '' };
        };
        await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        const viewCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'view');
        assert.ok(viewCall !== undefined);
        assert.ok(!viewCall.args.includes('--repo'), 'no --repo on verify when _repoSlug unset');
    });
});
describe('syncIssueClose', () => {
    it('returns ok=true when gh close succeeds', async () => {
        const spawnFn = makeSpawnFn([
            { status: 0, stdout: '', stderr: '' },
        ]);
        const result = await syncIssueClose({
            remote_iid: 42,
            remote_kind: 'github',
            _spawnFn: spawnFn,
        });
        assert.equal(result.ok, true);
    });
    it('returns ok=false with stderr+exit_code when glab close fails (#2871)', async () => {
        const spawnFn = makeSpawnFn([
            { status: 1, stdout: '', stderr: 'not found' },
        ]);
        const result = await syncIssueClose({
            remote_iid: 10,
            remote_kind: 'gitlab',
            _spawnFn: spawnFn,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'non_zero_exit');
        assert.equal(result.exit_code, 1);
        assert.equal(result.stderr, 'not found');
    });
});
describe('verifyRemoteIssue (#36)', () => {
    it('ok when gh issue view returns a numbered issue', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0, stdout: '{"number":42,"title":"t","state":"OPEN"}', stderr: '' };
        };
        const result = await verifyRemoteIssue('gh', 42, { spawnFn, repoSlug: 'github.com/owner/repo' });
        assert.equal(result.ok, true);
        const call = calls[0];
        assert.equal(call.cmd, 'gh');
        assert.deepEqual(call.args.slice(0, 3), ['issue', 'view', '42']);
        assert.ok(call.args.includes('--json'));
        const rIdx = call.args.indexOf('--repo');
        assert.equal(call.args[rIdx + 1], 'github.com/owner/repo');
    });
    it('fails when gh view exits non-zero (nonexistent / PR iid)', async () => {
        const spawnFn = () => ({ status: 1, stdout: '', stderr: 'not found' });
        const result = await verifyRemoteIssue('gh', 999999, { spawnFn });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'not_found_or_error');
    });
    it('fails when gh view stdout is unparseable', async () => {
        const spawnFn = () => ({ status: 0, stdout: 'not json', stderr: '' });
        const result = await verifyRemoteIssue('gh', 5, { spawnFn });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'parse_failed');
    });
    it('glab uses status-only verification with -R', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0, stdout: 'issue 7 details', stderr: '' };
        };
        const result = await verifyRemoteIssue('glab', 7, { spawnFn, repoSlug: 'gitlab.com/owner/repo' });
        assert.equal(result.ok, true);
        const call = calls[0];
        assert.equal(call.cmd, 'glab');
        const rIdx = call.args.indexOf('-R');
        assert.equal(call.args[rIdx + 1], 'gitlab.com/owner/repo');
    });
});
describe('syncIssueCreate label pre-validation (#36)', () => {
    it('creates with the valid subset and reports unknown_labels', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === 'label' && args[1] === 'list') {
                return { status: 0, stdout: JSON.stringify([{ name: 'bug' }, { name: 'urgent' }]), stderr: '' };
            }
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            labels: ['bug', 'urgent', 'ghost'],
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
        assert.deepEqual(result.unknown_labels, ['ghost']);
        const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
        const labelValues = [];
        for (let i = 0; i < createCall.args.length; i++) {
            if (createCall.args[i] === '--label')
                labelValues.push(createCall.args[i + 1]);
        }
        assert.deepEqual(labelValues, ['bug', 'urgent']);
    });
    it('passes all labels through when the taxonomy fetch fails', async () => {
        const calls = [];
        const spawnFn = (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === 'label' && args[1] === 'list') {
                return { status: 1, stdout: '', stderr: 'unavailable' };
            }
            if (args[0] === 'issue' && args[1] === 'view') {
                return { status: 0, stdout: '{"number":1,"url":"https://github.com/owner/repo/issues/1"}', stderr: '' };
            }
            return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
        };
        const result = await syncIssueCreate({
            issueId: 1,
            title: 'Test',
            body: 'Body',
            labels: ['bug', 'ghost'],
            _backend: 'gh',
            _spawnFn: spawnFn,
        });
        assert.ok(!isSyncFailure(result));
        assert.equal(result.unknown_labels, undefined);
        const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
        assert.ok(createCall.args.includes('ghost'), 'unknown label passes through when taxonomy is unavailable');
    });
});
describe('defaultSpawnFn live-CLI guard', () => {
    it('refuses to spawn under TMB_FORBID_LIVE_SYNC=1 and surfaces a SyncFailure', async () => {
        const savedForbid = process.env.TMB_FORBID_LIVE_SYNC;
        const savedTestCtx = process.env.NODE_TEST_CONTEXT;
        process.env.TMB_FORBID_LIVE_SYNC = '1';
        delete process.env.NODE_TEST_CONTEXT;
        try {
            const result = await syncIssueCreate({
                issueId: 1,
                title: 'guard test',
                body: 'must never reach a real gh binary',
                _backend: 'gh',
            });
            assert.ok(isSyncFailure(result), 'guarded create must fail');
            assert.match(result.stderr ?? '', /live CLI blocked in test context/);
            assert.match(result.stderr ?? '', /TMB_FORBID_LIVE_SYNC=1/);
        }
        finally {
            if (savedForbid !== undefined)
                process.env.TMB_FORBID_LIVE_SYNC = savedForbid;
            else
                delete process.env.TMB_FORBID_LIVE_SYNC;
            if (savedTestCtx !== undefined)
                process.env.NODE_TEST_CONTEXT = savedTestCtx;
        }
    });
    it('refuses to spawn under the node test runner (NODE_TEST_CONTEXT)', async () => {
        assert.ok(process.env.NODE_TEST_CONTEXT, 'suite must run under node --test');
        const savedForbid = process.env.TMB_FORBID_LIVE_SYNC;
        delete process.env.TMB_FORBID_LIVE_SYNC;
        try {
            const result = await syncIssueClose({
                remote_iid: 999999,
                remote_kind: 'github',
            });
            assert.equal(result.ok, false);
            assert.match(result.stderr ?? '', /live CLI blocked in test context/);
            assert.match(result.stderr ?? '', /NODE_TEST_CONTEXT/);
        }
        finally {
            if (savedForbid !== undefined)
                process.env.TMB_FORBID_LIVE_SYNC = savedForbid;
        }
    });
});
//# sourceMappingURL=sync-issue.test.js.map