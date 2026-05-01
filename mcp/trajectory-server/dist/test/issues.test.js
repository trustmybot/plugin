import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
describe('issueTools', () => {
    it('create then get returns the created issue', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Build feature X',
            description: '# Requirements\n- Do X',
        });
        const created = parseResult(createResult);
        assert.ok(!createResult.isError, `Expected no error, got: ${created.error}`);
        assert.equal(created.objective, 'Build feature X');
        assert.equal(created.status, 'open');
        const getResult = await call(tools.handlers, 'issue_get', {
            agent: 'bro',
            issue_id: String(created.id),
            include_description: true,
        });
        const fetched = parseResult(getResult);
        assert.ok(!getResult.isError);
        assert.equal(fetched.id, created.id);
        assert.equal(fetched.description, '# Requirements\n- Do X');
        db.close();
    });
    it('issue_get with include_description=false omits description', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test redaction',
            description: 'secret description',
        });
        const created = parseResult(createResult);
        const getResult = await call(tools.handlers, 'issue_get', {
            agent: 'bro',
            issue_id: String(created.id),
            include_description: false,
        });
        const fetched = parseResult(getResult);
        assert.ok(!('description' in fetched), 'description should be omitted when include_description=false');
        db.close();
    });
    it('issue_resume returns the issue and first pending task', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const { taskTools } = await import('../tools/tasks.js');
        const tTools = taskTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Resume test',
        });
        const issue = parseResult(createResult);
        await call(tTools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            agent: 'bro',
            issue_id: String(issue.id),
            tasks: [
                { branch_id: 'feat/first-task', description: 'First task', success_criteria: 'done' },
                { branch_id: 'feat/second-task', description: 'Second task', success_criteria: 'done' },
            ],
        });
        const resumeResult = await call(tools.handlers, 'issue_resume', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const resumed = parseResult(resumeResult);
        assert.ok(!resumeResult.isError);
        assert.equal(resumed.issue.id, issue.id);
        assert.ok(resumed.next_task !== null);
        assert.equal(resumed.next_task.branch_id, 'feat/first-task');
        db.close();
    });
    it('issue_close sets status to closed', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Close test',
        });
        const issue = parseResult(createResult);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
            post_git_sha: 'abc123',
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError);
        assert.equal(closed.status, 'closed');
        assert.ok(closed.closed_at !== null);
        db.close();
    });
    it('issue_get_phase returns tasks phase when tasks are in progress', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const { taskTools } = await import('../tools/tasks.js');
        const tTools = taskTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Phase test',
        });
        const issue = parseResult(createResult);
        await call(tTools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            agent: 'bro',
            issue_id: String(issue.id),
            tasks: [
                { branch_id: 'feat/task-1', description: 'Task 1', success_criteria: 'done' },
                { branch_id: 'feat/task-2', description: 'Task 2', success_criteria: 'done' },
            ],
        });
        const phaseResult = await call(tools.handlers, 'issue_get_phase', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const phaseData = parseResult(phaseResult);
        assert.ok(!phaseResult.isError);
        assert.equal(phaseData.phase, 'tasks');
        assert.equal(phaseData.counts.tasks_total, 2);
        db.close();
    });
    it('issue_close sets post_commit_hash and preserves pre_commit_hash', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'SHA preservation test',
        });
        const issue = parseResult(createResult);
        const originalPreHash = issue.pre_commit_hash;
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
            post_git_sha: 'deadbeef',
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError);
        assert.equal(closed.post_commit_hash, 'deadbeef', 'post_commit_hash should be set');
        assert.equal(closed.pre_commit_hash, originalPreHash, 'pre_commit_hash must not be overwritten');
        db.close();
    });
    it('issue_close without post_git_sha leaves post_commit_hash as null', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Optional SHA test',
        });
        const issue = parseResult(createResult);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError);
        assert.equal(closed.status, 'closed');
        assert.equal(closed.post_commit_hash, null, 'post_commit_hash should remain null');
        db.close();
    });
    it('unknown issue_id returns a JSON-RPC error', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_get', {
            agent: 'bro',
            issue_id: '99999',
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Should be an error result');
        assert.match(data.error, /Not found/);
        db.close();
    });
});
describe('issueTools — remote sync', () => {
    it('issue_create with issue_sync=off skips sync, no remote fields set', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'off',
        });
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test off sync',
        });
        const created = parseResult(result);
        assert.ok(!result.isError, `Expected no error, got: ${created.error}`);
        assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync is off');
        assert.equal(created.remote_kind ?? null, null, 'remote_kind should be null when sync is off');
        db.close();
    });
    it('issue_create with issue_sync=gh, remote fails → local insert succeeds', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'gh',
        });
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test gh sync failure fallback',
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
        assert.equal(created.objective, 'Test gh sync failure fallback');
        assert.equal(created.status, 'open');
        db.close();
    });
    it('issue_create with issue_sync=glab, remote fails → local insert succeeds', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'glab',
        });
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test glab sync failure fallback',
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
        assert.equal(created.objective, 'Test glab sync failure fallback');
        db.close();
    });
    it('issue_create with issue_sync=auto and nothing available → null sync, local insert succeeds', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'auto',
        });
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test auto with no remote',
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when no backend available');
        assert.equal(created.objective, 'Test auto with no remote');
        db.close();
    });
    it('issue_close with no remote_iid skips remote close', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Close without remote',
        });
        const issue = parseResult(createResult);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError, 'issue_close should succeed when no remote_iid');
        assert.equal(closed.status, 'closed');
        db.close();
    });
    it('issue_close mirrors to remote when remote_iid is set', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Close with remote',
        });
        const issue = parseResult(createResult);
        db.run(`UPDATE issues SET remote_iid = 99, remote_kind = 'github', remote_synced_at = datetime('now') WHERE id = ?`, [issue.id]);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError, 'issue_close should be non-fatal even if remote close fails');
        assert.equal(closed.status, 'closed');
        db.close();
    });
    it('issue_sync_retry is forbidden to swe', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const result = await call(tools.handlers, 'issue_sync_retry', {
            agent: 'swe',
            issue_id: '1',
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'swe should be forbidden from issue_sync_retry');
        assert.equal(data.error, 'forbidden');
        db.close();
    });
    it('issue_sync_retry returns skipped when issue_sync=off', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'off',
        });
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Retry test off',
        });
        const issue = parseResult(createResult);
        const retryResult = await call(tools.handlers, 'issue_sync_retry', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const data = parseResult(retryResult);
        assert.ok(!retryResult.isError);
        assert.equal(data.skipped, true);
        db.close();
    });
});
//# sourceMappingURL=issues.test.js.map