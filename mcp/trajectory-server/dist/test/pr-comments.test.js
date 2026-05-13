import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { prCommentsTools } from '../tools/pr_comments.js';
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
describe('pr_comments_get — GitHub backend', () => {
    it('returns structured comments from gh pr view output', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_comments_get']({
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
    it('filters comments by since timestamp', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 1, stdout: '', stderr: 'auth error' }]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 8, repo: 'owner/repo' });
        await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 8, repo: 'owner/repo' });
        const rows = db.all(`SELECT id FROM pr_review_runs WHERE pr_number = 8 AND repo = ?`, ['owner/repo']);
        assert.equal(rows.length, 1, 'UPSERT must keep exactly one row per (pr_number, repo)');
        db.close();
    });
    it('rejects non-bro callers', async () => {
        const db = tempDB();
        const tools = prCommentsTools(db, makeSpawnFn([]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([
            { status: 0, stdout: MIXED_SAMPLE, stderr: '' },
        ]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 42, repo: 'org/repo-a' });
        await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 42, repo: 'org/repo-b' });
        const rows = db.all(`SELECT repo FROM pr_review_runs WHERE pr_number = 42 ORDER BY repo`);
        assert.equal(rows.length, 2, 'Each (pr_number, repo) gets its own cursor row');
        assert.equal(rows[0].repo, 'org/repo-a');
        assert.equal(rows[1].repo, 'org/repo-b');
        db.close();
    });
});
describe('pr_comments_get — GitLab backend', () => {
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
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GLAB_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GLAB_SAMPLE, stderr: '' }]));
        const result = (await tools.handlers['pr_comments_get']({
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
describe('pr_comments_get — issue_sync=off', () => {
    it('works when issue_sync=off (independent of issue-sync config)', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"off"')`);
        const tools = prCommentsTools(db, makeSpawnFn([
            { status: 0, stdout: '', stderr: '' },
            { status: 0, stdout: GH_SAMPLE, stderr: '' },
        ]));
        const result = (await tools.handlers['pr_comments_get']({
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
        const tools = prCommentsTools(db, makeSpawnFn([{ status: 0, stdout: GH_SAMPLE, stderr: '' }]));
        await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 10 });
        const row = db.get(`SELECT last_comment_id FROM pr_review_runs WHERE pr_number = 10`);
        assert.ok(row, 'Row should exist');
        assert.equal(row.last_comment_id, 'rc1', 'last_comment_id should be the last comment id');
        db.close();
    });
});
//# sourceMappingURL=pr-comments.test.js.map