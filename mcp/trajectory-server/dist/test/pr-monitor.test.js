import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { prMonitorTools } from '../tools/pr_monitor.js';
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
function makeSpawnFn(responses) {
    let index = 0;
    return (_cmd, _args, _opts) => {
        const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
        index++;
        return response;
    };
}
const GH_SAMPLE = JSON.stringify({
    state: 'OPEN',
    comments: [
        {
            id: 'c1',
            author: { login: 'alice' },
            body: 'This function should handle null input.',
            createdAt: '2024-01-15T10:00:00Z',
        },
        {
            id: 'c2',
            author: { login: 'dependabot[bot]' },
            body: 'Bump lodash from 4.17.20 to 4.17.21',
            createdAt: '2024-01-15T11:00:00Z',
        },
    ],
    reviews: [
        {
            comments: [
                {
                    id: 'rc1',
                    author: { login: 'bob' },
                    body: 'Consider extracting this into a helper.',
                    createdAt: '2024-01-15T12:00:00Z',
                    path: 'src/utils.ts',
                    line: 42,
                    isResolved: false,
                },
            ],
        },
    ],
});
const GLAB_SAMPLE = JSON.stringify({
    state: 'opened',
    notes: [
        {
            id: 101,
            author: { username: 'carol' },
            body: 'This is wrong — please fix.',
            created_at: '2024-01-20T09:00:00Z',
            resolved: false,
            position: { new_path: 'lib/parser.rb', new_line: 10 },
        },
        {
            id: 102,
            author: { username: 'renovate-bot' },
            body: 'Update dependency xyz.',
            created_at: '2024-01-20T10:00:00Z',
            resolved: false,
        },
    ],
});
describe('pr_monitor_comments_get — GitHub backend', () => {
    it('returns structured comments from gh pr view output', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 5,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const data = parseResult(result);
        assert.equal(data.remote_kind, 'github');
        assert.equal(data.pr_state, 'open');
        assert.equal(data.comments.length, 3);
        const alice = data.comments.find((c) => c.author === 'alice');
        assert.ok(alice, 'Should have alice comment');
        assert.equal(alice.author_kind, 'human');
        assert.equal(alice.is_resolved, false);
        const bot = data.comments.find((c) => c.author === 'dependabot[bot]');
        assert.ok(bot, 'Should have bot comment');
        assert.equal(bot.author_kind, 'bot');
        const reviewComment = data.comments.find((c) => c.author === 'bob');
        assert.ok(reviewComment, 'Should have review comment from bob');
        assert.equal(reviewComment.file_path, 'src/utils.ts');
        assert.equal(reviewComment.line, 42);
        db.close();
    });
    it('frames every returned comment body as untrusted data (#1036)', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 6,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const data = parseResult(result);
        for (const c of data.comments) {
            assert.ok(c.body.startsWith('<untrusted-content source="pr-comment">'), `comment body must be framed as untrusted data: ${c.body}`);
            assert.ok(c.body.endsWith('</untrusted-content>'), 'framed body ends with the close marker');
        }
        // The original text still lives inside the fence.
        const alice = data.comments.find((c) => c.author === 'alice');
        assert.ok(alice.body.includes('This function should handle null input.'), 'original body preserved inside the fence');
        db.close();
    });
    it('filters comments by since timestamp', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 5,
            since: '2024-01-15T11:30:00Z',
        }));
        assert.ok(!result.isError);
        const data = parseResult(result);
        assert.equal(data.comments.length, 1, 'Only one comment should be after 11:30');
        assert.equal(data.comments[0].author, 'bob');
        db.close();
    });
    it('returns error when gh command fails', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 1, stdout: '', stderr: 'auth error' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 5,
        }));
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('Failed to fetch'), `Error should mention fetch failure: ${data.error}`);
        db.close();
    });
    it('writes a pr_review_runs row on success (upsert by (pr_number, repo))', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 7,
            repo: 'owner/repo',
        });
        const row = db.get(`SELECT pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs WHERE pr_number = 7`);
        assert.ok(row, 'pr_review_runs row should exist');
        assert.equal(row.pr_number, 7);
        assert.equal(row.repo, 'owner/repo');
        assert.ok(row.last_fetched_at, 'last_fetched_at should be set');
        assert.equal(row.last_comment_id, 'rc1');
        db.close();
    });
    it('upserts by (pr_number, repo): re-fetching the same PR overwrites the existing row', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 8, repo: 'owner/repo' });
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 8, repo: 'owner/repo' });
        const rows = db.all(`SELECT id FROM pr_review_runs WHERE pr_number = 8 AND repo = ?`, ['owner/repo']);
        assert.equal(rows.length, 1, 'UPSERT must keep exactly one row per (pr_number, repo)');
        db.close();
    });
    it('rejects non-bro callers', async () => {
        const db = tempDB();
        const tools = prMonitorTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'swe',
            pr_number: 5,
        }));
        assert.ok(result.isError, 'Expected error result for non-bro caller');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden');
        db.close();
    });
    // Incremental polling — the FILL wired in MR A (#2886 follow-up). The
    // cursor in pr_review_runs.last_fetched_at must be read on the next call
    // and applied as the since-filter so comments older than the cursor are
    // skipped. Test by handing the second call a sample with one old + one new
    // comment, presetting the cursor to between them.
    it('consumes pr_review_runs.last_fetched_at as the since-filter on the next call', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        // Stage a cursor row indicating we last fetched at 2024-01-15T11:30:00Z —
        // between the two comments in MIXED_SAMPLE below.
        db.run(`INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id)
       VALUES (9, 'owner/repo', '2024-01-15T11:30:00Z', 'old')`);
        const MIXED_SAMPLE = JSON.stringify({
            state: 'OPEN',
            comments: [
                {
                    id: 'old',
                    author: { login: 'alice' },
                    body: 'old comment (should be filtered out)',
                    createdAt: '2024-01-15T11:00:00Z',
                },
                {
                    id: 'new',
                    author: { login: 'bob' },
                    body: 'new comment (after cursor)',
                    createdAt: '2024-01-15T12:00:00Z',
                },
            ],
            reviews: [],
        });
        const tools = prMonitorTools(db, makeSpawnFn([
            { status: 0, stdout: MIXED_SAMPLE, stderr: '' },
        ]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 9,
            repo: 'owner/repo',
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const data = parseResult(result);
        // Only the new comment should survive the cursor filter.
        assert.equal(data.comments.length, 1, `Expected 1 post-cursor comment, got ${data.comments.length}: ${JSON.stringify(data.comments)}`);
        assert.equal(data.comments[0].id, 'new', 'The post-cursor comment must be the survivor');
        // And the cursor must advance to the new comment.
        const row = db.get(`SELECT last_fetched_at, last_comment_id FROM pr_review_runs WHERE pr_number = 9 AND repo = 'owner/repo'`);
        assert.ok(row);
        assert.equal(row.last_comment_id, 'new', 'Cursor must advance to the new comment id');
        assert.notEqual(row.last_fetched_at, '2024-01-15T11:30:00Z', 'last_fetched_at must be overwritten with the new fetch time');
        db.close();
    });
    // Cursor is per (pr_number, repo) — distinct repos with the same pr_number
    // must NOT share the cursor.
    it('isolates the cursor by (pr_number, repo) — different repos do not share state', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 42, repo: 'org/repo-a' });
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 42, repo: 'org/repo-b' });
        const rows = db.all(`SELECT repo FROM pr_review_runs WHERE pr_number = 42 ORDER BY repo`);
        assert.equal(rows.length, 2, 'Each (pr_number, repo) gets its own cursor row');
        assert.equal(rows[0].repo, 'org/repo-a');
        assert.equal(rows[1].repo, 'org/repo-b');
        db.close();
    });
});
describe('pr_monitor_comments_get — GitLab backend', () => {
    let savedEnv;
    before(() => {
        savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
        delete process.env.TMB_DISABLE_REMOTE_SYNC;
    });
    after(() => {
        if (savedEnv !== undefined) {
            process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
        }
        else {
            delete process.env.TMB_DISABLE_REMOTE_SYNC;
        }
    });
    it('returns structured comments from glab mr view output', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"glab"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GLAB_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 3,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const data = parseResult(result);
        assert.equal(data.remote_kind, 'gitlab');
        assert.equal(data.pr_state, 'open');
        assert.equal(data.comments.length, 2);
        const carol = data.comments.find((c) => c.author === 'carol');
        assert.ok(carol, 'Should have carol comment');
        assert.equal(carol.author_kind, 'human');
        assert.equal(carol.file_path, 'lib/parser.rb');
        assert.equal(carol.line, 10);
        const bot = data.comments.find((c) => c.author === 'renovate-bot');
        assert.ok(bot, 'Should have bot comment');
        assert.equal(bot.author_kind, 'bot');
        db.close();
    });
    it('filters GitLab comments by since timestamp', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"glab"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GLAB_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 3,
            since: '2024-01-20T09:30:00Z',
        }));
        assert.ok(!result.isError);
        const data = parseResult(result);
        assert.equal(data.comments.length, 1, 'Only renovate-bot comment after 09:30');
        db.close();
    });
});
describe('pr_monitor_comments_get — issue_sync=off', () => {
    it('works when issue_sync=off (independent of issue-sync config)', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"off"')`);
        const tools = prMonitorTools(db, makeSpawnFn([
            { status: 0, stdout: '', stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 20,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const data = parseResult(result);
        assert.equal(data.remote_kind, 'github');
        assert.equal(data.comments.length, 3);
        const row = db.get(`SELECT pr_number, last_comment_id FROM pr_review_runs WHERE pr_number = 20`);
        assert.ok(row, 'pr_review_runs row should exist');
        assert.equal(row.pr_number, 20);
        db.close();
    });
});
describe('pr_review_runs table state capture', () => {
    it('records last_comment_id from final comment', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 10 });
        const row = db.get(`SELECT last_comment_id FROM pr_review_runs WHERE pr_number = 10`);
        assert.ok(row, 'Row should exist');
        assert.equal(row.last_comment_id, 'rc1', 'last_comment_id should be the last comment id');
        db.close();
    });
});
describe('pr_monitor_comments_get — pr_review_runs.task_id population (#1024)', () => {
    function seedTask(db, branch, repo) {
        db.run(`INSERT INTO repos (name, path, remotes) VALUES (?, '/tmp/app', ?)`, [repo, JSON.stringify([{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }])]);
        db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('t', '', 'open', datetime('now'), datetime('now'))`);
        const issue = db.get('SELECT id FROM issues ORDER BY id DESC LIMIT 1');
        db.run(`INSERT INTO tasks (issue_id, branch_id, description, repo, created_at, updated_at)
       VALUES (?, ?, 'task', ?, datetime('now'), datetime('now'))`, [issue.id, branch, repo]);
        return db.get('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').id;
    }
    const GH_WITH_BRANCH = (branch) => JSON.stringify({
        state: 'OPEN',
        headRefName: branch,
        comments: [
            { id: 'c1', author: { login: 'alice' }, body: 'hi', createdAt: '2024-01-15T10:00:00Z' },
        ],
        reviews: [],
    });
    it('resolves task_id from the PR head branch (+ repo) on the monitor row', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const taskId = seedTask(db, 'fix/1043-branch', 'app');
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_WITH_BRANCH('fix/1043-branch'), stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 31,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const row = db.get('SELECT task_id FROM pr_review_runs WHERE pr_number = 31');
        assert.ok(row, 'monitor row must exist');
        assert.equal(row.task_id, taskId, 'task_id resolved from head branch');
        db.close();
    });
    it('leaves task_id null when the head branch matches no task', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        seedTask(db, 'fix/known-branch', 'app');
        const tools = prMonitorTools(db, makeSpawnFn([{ status: 0, stdout: GH_WITH_BRANCH('fix/unknown-branch'), stderr: '' }]));
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 32,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const row = db.get('SELECT task_id FROM pr_review_runs WHERE pr_number = 32');
        assert.ok(row, 'monitor row must exist');
        assert.equal(row.task_id, null, 'unresolved branch → task_id null (hook exits cleanly)');
        db.close();
    });
    it('does not null a previously-resolved task_id on a later fetch with no branch', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const taskId = seedTask(db, 'fix/persist-branch', 'app');
        const tools = prMonitorTools(db, makeSpawnFn([
            { status: 0, stdout: GH_WITH_BRANCH('fix/persist-branch'), stderr: '' },
            { status: 0, stdout: GH_WITH_BRANCH(''), stderr: '' },
        ]));
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 33 });
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 33 });
        const row = db.get('SELECT task_id FROM pr_review_runs WHERE pr_number = 33');
        assert.equal(row?.task_id, taskId, 'COALESCE keeps the earlier task_id');
        db.close();
    });
});
describe('pr_monitor_runs_list', () => {
    it('returns all cursors in order when called without a filter', async () => {
        const db = tempDB();
        db.run(`INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id) VALUES
         (3, 'org/b', '2024-01-02T00:00:00Z', 'b3'),
         (3, 'org/a', '2024-01-01T00:00:00Z', 'a3'),
         (1, 'org/a', '2024-01-03T00:00:00Z', 'a1')`);
        const tools = prMonitorTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_monitor_runs_list']({ agent: 'bro' }));
        assert.ok(!result.isError, JSON.stringify(parseResult(result)));
        const data = parseResult(result);
        assert.equal(data.count, 3);
        // ORDER BY pr_number, repo
        assert.equal(data.rows[0].pr_number, 1);
        assert.equal(data.rows[1].pr_number, 3);
        assert.equal(data.rows[1].repo, 'org/a');
        assert.equal(data.rows[2].pr_number, 3);
        assert.equal(data.rows[2].repo, 'org/b');
        db.close();
    });
    it('filters by pr_number when supplied', async () => {
        const db = tempDB();
        db.run(`INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id) VALUES
         (5, 'org/a', '2024-01-01T00:00:00Z', 'a5'),
         (5, 'org/b', '2024-01-02T00:00:00Z', 'b5'),
         (6, 'org/a', '2024-01-03T00:00:00Z', 'a6')`);
        const tools = prMonitorTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_monitor_runs_list']({
            agent: 'bro',
            pr_number: 5,
        }));
        assert.ok(!result.isError);
        const data = parseResult(result);
        assert.equal(data.count, 2);
        for (const row of data.rows)
            assert.equal(row.pr_number, 5);
        db.close();
    });
    it('returns empty array when no cursors exist', async () => {
        const db = tempDB();
        const tools = prMonitorTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_monitor_runs_list']({ agent: 'bro' }));
        const data = parseResult(result);
        assert.equal(data.count, 0);
        assert.deepEqual(data.rows, []);
        db.close();
    });
    it('rejects non-bro callers', async () => {
        const db = tempDB();
        const tools = prMonitorTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_monitor_runs_list']({
            agent: 'swe',
        }));
        assert.ok(result.isError);
        assert.equal(parseResult(result).error, 'forbidden');
        db.close();
    });
});
describe('pr_monitor_comments_get — repo threading (#362)', () => {
    function makeCapturingSpawnFn(responses) {
        const calls = [];
        let index = 0;
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
            index++;
            return response;
        };
        return { spawnFn, calls };
    }
    it('threads -R <repo> into gh pr view args when repo is provided', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const { spawnFn, calls } = makeCapturingSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]);
        const tools = prMonitorTools(db, spawnFn);
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 5, repo: 'owner/my-repo' });
        const ghCall = calls.find((c) => c.cmd === 'gh');
        assert.ok(ghCall, 'gh should be called');
        assert.ok(ghCall.args.includes('-R'), 'args should include -R flag');
        assert.ok(ghCall.args.includes('owner/my-repo'), 'args should include the repo slug');
        const rIdx = ghCall.args.indexOf('-R');
        assert.equal(ghCall.args[rIdx + 1], 'owner/my-repo', '-R must immediately precede the repo slug');
        db.close();
    });
    it('does not add -R flag when repo is omitted', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const { spawnFn, calls } = makeCapturingSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]);
        const tools = prMonitorTools(db, spawnFn);
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 5 });
        const ghCall = calls.find((c) => c.cmd === 'gh');
        assert.ok(ghCall, 'gh should be called');
        assert.ok(!ghCall.args.includes('-R'), 'args should NOT include -R flag when repo is omitted');
        db.close();
    });
    it('threads -R <repo> into glab mr view args when repo is provided', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"glab"')`);
        const { spawnFn, calls } = makeCapturingSpawnFn([{ status: 0, stdout: GLAB_SAMPLE, stderr: '' }]);
        const tools = prMonitorTools(db, spawnFn);
        await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 3, repo: 'group/project' });
        const glabCall = calls.find((c) => c.cmd === 'glab');
        assert.ok(glabCall, 'glab should be called');
        assert.ok(glabCall.args.includes('-R'), 'args should include -R flag');
        assert.equal(glabCall.args[glabCall.args.indexOf('-R') + 1], 'group/project', '-R must immediately precede the repo slug');
        db.close();
    });
});
describe('pr_monitor_comments_get — repo resolution (#15)', () => {
    function makeCapturingSpawnFn(responses) {
        const calls = [];
        let index = 0;
        const spawnFn = (cmd, args, _opts) => {
            calls.push({ cmd, args });
            const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
            index++;
            return response;
        };
        return { spawnFn, calls };
    }
    it('returns a named error in multi-repo with no slug (never a cwd-remote sync)', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
        const { spawnFn, calls } = makeCapturingSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]);
        const tools = prMonitorTools(db, spawnFn);
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 5,
        }));
        assert.ok(result.isError, 'multi-repo with no slug must be a named error');
        assert.match(parseResult(result).error, /multiple repos registered and no repo slug/);
        assert.equal(calls.length, 0, 'no gh/glab spawn — never a cwd-remote sync');
        const cursor = db.get('SELECT id FROM pr_review_runs');
        assert.equal(cursor, undefined, 'no cursor row written on the named error');
        db.close();
    });
    it('resolves the sole repo\'s remote slug and threads it into gh -R + the cursor key', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        db.run(`INSERT INTO repos (name, path, remotes) VALUES ('app', '/tmp/app', ?)`, [JSON.stringify([{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }])]);
        const { spawnFn, calls } = makeCapturingSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]);
        const tools = prMonitorTools(db, spawnFn);
        const result = (await tools.handlers['pr_monitor_comments_get']({
            agent: 'bro',
            pr_number: 11,
        }));
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const ghCall = calls.find((c) => c.cmd === 'gh');
        assert.ok(ghCall, 'gh should be called');
        const rIdx = ghCall.args.indexOf('-R');
        assert.ok(rIdx >= 0, 'sole repo slug must be threaded as -R');
        assert.equal(ghCall.args[rIdx + 1], 'github.com/owner/repo', '-R targets the sole repo slug');
        // Cursor key is the resolved slug, not '' — so two repos can't collide.
        const row = db.get('SELECT repo FROM pr_review_runs WHERE pr_number = 11');
        assert.ok(row, 'cursor row written');
        assert.equal(row.repo, 'github.com/owner/repo', 'cursor key is the per-repo slug');
        db.close();
    });
});
//# sourceMappingURL=pr-monitor.test.js.map