// Idempotent remote issue create (GH 1863): every remote body carries the
// issue's sync marker, a create whose result was lost reports outcome
// 'unknown', and issue_sync_retry adopts the remote issue that lost create made
// instead of opening a duplicate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';
import { findIssuesByMarker, isSyncFailure, issueSyncMarker, syncIssueCreate, } from '../sync/issue_sync.js';
const VALID_LABELS = ['Bug', 'Priority: High'];
const LOST = { status: null, stdout: '', stderr: '' };
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
const REMOTES = {
    gh: { name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' },
    glab: { name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' },
};
async function syncedDb(cli) {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    upsertRepoRemotes(db, 'app', [REMOTES[cli]]);
    setRemoteSync(db, 'app', [REMOTES[cli].provider]);
    await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: cli });
    return db;
}
function bodyArg(cli, args) {
    const i = args.indexOf(cli === 'gh' ? '--body' : '--description');
    assert.ok(i >= 0, `create args carry a body: ${JSON.stringify(args)}`);
    return args[i + 1];
}
function urlFor(cli, iid) {
    return cli === 'gh' ? `https://github.com/owner/repo/issues/${iid}` : `https://gitlab.com/owner/repo/-/issues/${iid}`;
}
// An in-memory remote: `issue create` records the issue (unless `rejectCreate`)
// and answers with `createReply` or the issue URL; `issue list` answers the
// newest `newest` issues, or every issue whose body holds the --search token.
function fakeRemote(cli, opts = {}) {
    const issues = [...(opts.seed ?? [])];
    const calls = [];
    let nextIid = 100;
    const spawnFn = (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === 'label' && args[1] === 'list')
            return { status: 1, stdout: '', stderr: 'no taxonomy (test)' };
        if (args[0] === 'issue' && args[1] === 'create') {
            if (opts.rejectCreate)
                return opts.rejectCreate;
            const iid = nextIid++;
            issues.push({ iid, body: bodyArg(cli, args) });
            return opts.createReply ?? { status: 0, stdout: `${urlFor(cli, iid)}\n`, stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'view') {
            const iid = Number(args[2]);
            return cli === 'gh'
                ? { status: 0, stdout: JSON.stringify({ number: iid, url: urlFor(cli, iid) }), stderr: '' }
                : { status: 0, stdout: `issue ${iid} details`, stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'list') {
            if (opts.listReply)
                return opts.listReply;
            const s = args.indexOf('--search');
            const visible = s >= 0
                ? issues.filter((i) => i.body.includes(args[s + 1].replace(/^"(.*)" in:body$/, '$1')))
                : issues.slice(-(opts.newest ?? 50));
            const rows = visible.map((i) => (cli === 'gh' ? { number: i.iid, body: i.body } : { iid: i.iid, description: i.body }));
            return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    const creates = () => calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    const lists = () => calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'list');
    return { spawnFn, calls, issues, creates, lists };
}
function issueRow(db, id) {
    return db.get('SELECT description, created_at, gh_iid, gl_iid FROM issues WHERE id = ?', [id]);
}
const iidColumn = (cli) => (cli === 'gh' ? 'gh_iid' : 'gl_iid');
const DESCRIPTION = '# Goal\n- keep this text exactly\n';
for (const cli of ['gh', 'glab']) {
    describe(`issue sync marker on every remote create (${cli}) — SC1`, () => {
        it('issue_create stamps the marker on the remote body and leaves the local description alone', async () => {
            const db = await syncedDb(cli);
            const remote = fakeRemote(cli);
            const created = parseResult(await call(issueTools(db).handlers, 'issue_create', {
                agent: 'bro', objective: `marker on create ${cli}`, description: DESCRIPTION, labels: VALID_LABELS, _spawnFn: remote.spawnFn,
            }));
            const row = issueRow(db, created.id);
            const marker = `<!-- tmb-issue:${created.id}:${row.created_at} -->`;
            assert.equal(issueSyncMarker(created.id, row.created_at), marker);
            assert.equal(remote.creates().length, 1);
            const body = bodyArg(cli, remote.creates()[0].args);
            assert.ok(body.endsWith(marker), body);
            assert.equal(body, `${DESCRIPTION}\n\n${marker}`);
            assert.equal(row.description, DESCRIPTION);
            assert.equal(row[iidColumn(cli)], 100);
            db.close();
        });
        it('issue_sync_retry stamps the same marker on its create', async () => {
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `marker on retry ${cli}`, description: DESCRIPTION, labels: VALID_LABELS,
                _spawnFn: fakeRemote(cli, { rejectCreate: { status: 1, stdout: '', stderr: 'HTTP 502' } }).spawnFn,
            }));
            assert.equal(created._sync.outcome, 'failed');
            const remote = fakeRemote(cli);
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: remote.spawnFn,
            }));
            assert.equal(retried.success, true, JSON.stringify(retried));
            const row = issueRow(db, created.id);
            const body = bodyArg(cli, remote.creates()[0].args);
            assert.ok(body.endsWith(`<!-- tmb-issue:${created.id}:${row.created_at} -->`), body);
            assert.equal(row.description, DESCRIPTION);
            db.close();
        });
    });
    describe(`a lost create result is adopted on retry (${cli}) — SC2`, () => {
        it('issue_create reports outcome unknown, then issue_sync_retry adopts the issue the lost create made', async () => {
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const remote = fakeRemote(cli, { createReply: LOST });
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `lost create ${cli}`, description: DESCRIPTION, labels: VALID_LABELS, _spawnFn: remote.spawnFn,
            }));
            assert.equal(created._sync.sync_failed, true);
            assert.equal(created._sync.outcome, 'unknown');
            assert.equal(created._sync.reason, 'non_zero_exit');
            assert.match(created._sync.hint, /issue_sync_retry.*looks for the issue.*before it creates/);
            assert.equal(remote.issues.length, 1, 'the remote holds the issue the lost create made');
            assert.equal(issueRow(db, created.id)[iidColumn(cli)], null);
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: remote.spawnFn,
            }));
            assert.equal(retried.success, true, JSON.stringify(retried));
            assert.equal(retried.adopted, true);
            assert.equal(retried.remote_iid, 100);
            assert.deepEqual(retried.duplicates, []);
            assert.equal(issueRow(db, created.id)[iidColumn(cli)], 100);
            assert.equal(remote.creates().length, 1, 'exactly one issue create across both calls');
            assert.equal(remote.lists().length, 1, 'the newest-50 list found it; no --search list ran');
            const audit = db.get(`SELECT content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_adopted'`, [created.id]);
            assert.ok(audit, 'an issue_adopted audit row');
            assert.deepEqual(JSON.parse(audit.content_json), {
                issue_id: created.id,
                backend: cli === 'gh' ? 'github' : 'gitlab',
                remote_iid: 100,
                via: 'issue_sync_retry',
            });
            db.close();
        });
    });
    describe(`retry with no remote counterpart (${cli}) — SC3`, () => {
        it('both lists come back empty, so retry creates exactly one issue and links it', async () => {
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `no counterpart ${cli}`, labels: VALID_LABELS,
                _spawnFn: fakeRemote(cli, { rejectCreate: { status: 1, stdout: '', stderr: 'HTTP 502' } }).spawnFn,
            }));
            const remote = fakeRemote(cli);
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: remote.spawnFn,
            }));
            assert.equal(retried.success, true, JSON.stringify(retried));
            assert.equal(retried.adopted, undefined);
            assert.equal(retried.remote_iid, 100);
            assert.equal(remote.lists().length, 2, 'the newest-50 list, then the --search list');
            assert.ok(remote.lists()[1].args.includes('--search'));
            assert.equal(remote.creates().length, 1);
            assert.equal(issueRow(db, created.id)[iidColumn(cli)], 100);
            db.close();
        });
        it('a lookup that exits non-zero creates nothing and reports lookup_failed', async () => {
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `lookup fails ${cli}`, labels: VALID_LABELS,
                _spawnFn: fakeRemote(cli, { createReply: LOST }).spawnFn,
            }));
            const remote = fakeRemote(cli, { listReply: { status: 1, stdout: '', stderr: 'HTTP 503' } });
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: remote.spawnFn,
            }));
            assert.equal(retried.success, false, JSON.stringify(retried));
            assert.equal(retried.errors.length, 1);
            assert.equal(retried.errors[0].reason, 'lookup_failed');
            assert.equal(retried.errors[0].backend, cli);
            assert.equal(remote.creates().length, 0);
            assert.equal(issueRow(db, created.id)[iidColumn(cli)], null);
            db.close();
        });
        it('a lookup whose output is not JSON also fails closed', async () => {
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `lookup unparseable ${cli}`, labels: VALID_LABELS,
                _spawnFn: fakeRemote(cli, { createReply: LOST }).spawnFn,
            }));
            const remote = fakeRemote(cli, { listReply: { status: 0, stdout: 'not json', stderr: '' } });
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: remote.spawnFn,
            }));
            assert.equal(retried.success, false);
            assert.equal(retried.errors[0].reason, 'lookup_failed');
            assert.equal(remote.creates().length, 0);
            db.close();
        });
    });
}
describe('syncIssueCreate outcome classification — SC4', () => {
    async function outcomeOf(cli, reply, remoteUrl) {
        const spawnFn = (_cmd, args) => reply(args);
        const result = await syncIssueCreate({
            issueId: 1, title: 't', body: 'b', _backend: cli, _spawnFn: spawnFn, _remoteUrl: remoteUrl,
        });
        assert.ok(isSyncFailure(result), JSON.stringify(result));
        return result;
    }
    const createThen = (cli, view) => (args) => args[1] === 'create' ? { status: 0, stdout: `${urlFor(cli, 7)}\n`, stderr: '' } : view;
    for (const cli of ['gh', 'glab']) {
        it(`${cli}: a timed-out create (status null) is unknown`, async () => {
            const r = await outcomeOf(cli, () => LOST);
            assert.deepEqual([r.reason, r.outcome], ['non_zero_exit', 'unknown']);
        });
        it(`${cli}: a non-zero exit with empty stdout and stderr is unknown`, async () => {
            const r = await outcomeOf(cli, () => ({ status: 1, stdout: '', stderr: '' }));
            assert.deepEqual([r.reason, r.outcome], ['non_zero_exit', 'unknown']);
        });
        it(`${cli}: a non-zero exit with stderr text is failed`, async () => {
            const r = await outcomeOf(cli, () => ({ status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a Repository' }));
            assert.deepEqual([r.reason, r.outcome], ['non_zero_exit', 'failed']);
        });
        it(`${cli}: a non-zero exit with stdout text is failed`, async () => {
            const r = await outcomeOf(cli, () => ({ status: 1, stdout: 'something went wrong', stderr: '' }));
            assert.deepEqual([r.reason, r.outcome], ['non_zero_exit', 'failed']);
        });
        it(`${cli}: a create whose output holds no iid is unknown`, async () => {
            const r = await outcomeOf(cli, () => ({ status: 0, stdout: 'Creating issue…\n', stderr: '' }));
            assert.deepEqual([r.reason, r.outcome], ['parse_failed', 'unknown']);
        });
        it(`${cli}: a read-back that fails after an iid was parsed is unknown`, async () => {
            const r = await outcomeOf(cli, createThen(cli, { status: 1, stdout: '', stderr: 'timeout' }));
            assert.deepEqual([r.reason, r.outcome], ['verify_failed', 'unknown']);
        });
        it(`${cli}: a host/repo mismatch is failed`, async () => {
            const r = await outcomeOf(cli, createThen(cli, { status: 0, stdout: '{}', stderr: '' }), cli === 'gh' ? 'https://github.com/other/place.git' : 'https://gitlab.com/other/place.git');
            assert.deepEqual([r.reason, r.outcome], ['verify_failed', 'failed']);
        });
        it(`${cli}: a spawn that throws is failed`, async () => {
            const r = await outcomeOf(cli, (args) => {
                if (args[1] === 'create')
                    throw new Error('ENOENT');
                return { status: 0, stdout: '', stderr: '' };
            });
            assert.deepEqual([r.reason, r.outcome], ['spawn_error', 'failed']);
        });
    }
    it('no backend is failed', async () => {
        const r = await syncIssueCreate({ issueId: 1, title: 't', body: 'b' });
        assert.ok(isSyncFailure(r));
        assert.deepEqual([r.reason, r.outcome], ['no_backend', 'failed']);
    });
});
describe('findIssuesByMarker matching — SC4', () => {
    const CREATED = '2026-10-26T00:53:47.519Z';
    const marker = issueSyncMarker(7, CREATED);
    for (const cli of ['gh', 'glab']) {
        it(`${cli}: two newest-50 matches give the lowest iid first, and a retry adopts it and lists the other as a duplicate`, async () => {
            const remote = fakeRemote(cli, {
                seed: [
                    { iid: 105, body: `dup\n\n${marker}` },
                    { iid: 104, body: 'unrelated' },
                    { iid: 103, body: `first\n\n${marker}` },
                ],
            });
            const found = await findIssuesByMarker(cli, marker, { spawnFn: remote.spawnFn });
            assert.deepEqual(found, { ok: true, iids: [103, 105] });
            assert.equal(remote.lists().length, 1);
            const db = await syncedDb(cli);
            const tools = issueTools(db);
            const created = parseResult(await call(tools.handlers, 'issue_create', {
                agent: 'bro', objective: `duplicates ${cli}`, labels: VALID_LABELS,
                _spawnFn: fakeRemote(cli, { createReply: LOST }).spawnFn,
            }));
            const own = issueSyncMarker(created.id, issueRow(db, created.id).created_at);
            const twice = fakeRemote(cli, { seed: [{ iid: 105, body: own }, { iid: 103, body: `x\n\n${own}` }] });
            const retried = parseResult(await call(tools.handlers, 'issue_sync_retry', {
                agent: 'bro', issue_id: String(created.id), _spawnFn: twice.spawnFn,
            }));
            assert.equal(retried.success, true, JSON.stringify(retried));
            assert.equal(retried.adopted, true);
            assert.equal(retried.remote_iid, 103);
            assert.deepEqual(retried.duplicates, [105]);
            assert.equal(issueRow(db, created.id)[iidColumn(cli)], 103);
            assert.equal(twice.creates().length, 0);
            assert.ok(!twice.calls.some((c) => c.args[1] === 'close'), 'no duplicate is closed');
            db.close();
        });
        it(`${cli}: a marker for a different id or created_at does not match`, async () => {
            const remote = fakeRemote(cli, {
                seed: [
                    { iid: 1, body: issueSyncMarker(8, CREATED) },
                    { iid: 2, body: issueSyncMarker(7, '2026-10-26T00:53:47.520Z') },
                    { iid: 3, body: issueSyncMarker(77, CREATED) },
                ],
            });
            assert.deepEqual(await findIssuesByMarker(cli, marker, { spawnFn: remote.spawnFn }), { ok: true, iids: [] });
            assert.equal(remote.lists().length, 2);
        });
        it(`${cli}: an issue older than the newest 50 is found by the --search list`, async () => {
            const seed = [{ iid: 1, body: `old\n\n${marker}` }];
            for (let i = 2; i <= 60; i++)
                seed.push({ iid: i, body: `filler ${i}` });
            const remote = fakeRemote(cli, { seed });
            const found = await findIssuesByMarker(cli, marker, { spawnFn: remote.spawnFn, repoSlug: 'host/owner/repo' });
            assert.deepEqual(found, { ok: true, iids: [1] });
            const [first, second] = remote.lists().map((c) => c.args);
            assert.ok(!first.includes('--search'));
            const s = second.indexOf('--search');
            assert.ok(second[s + 1].includes('tmb-issue:7:2026-10-26T00:53:47.519Z'), JSON.stringify(second));
            assert.ok(second.includes(cli === 'gh' ? '--repo' : '-R'));
            if (cli === 'gh') {
                assert.deepEqual(first.slice(0, 8), ['issue', 'list', '--state', 'all', '--limit', '50', '--json', 'number,body']);
            }
            else {
                assert.deepEqual(first.slice(0, 7), ['issue', 'list', '--all', '--per-page', '50', '--output', 'json']);
                assert.equal(second[second.indexOf('--in') + 1], 'description');
            }
        });
    }
});
//# sourceMappingURL=issue-sync-idempotent.test.js.map