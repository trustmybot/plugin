import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { makeSpawnFn } from './sync-issue.test.js';
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
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issue.id),
            tasks: [
                { branch_id: 'feat/first-task', description: 'First task' },
                { branch_id: 'feat/second-task', description: 'Second task' },
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
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issue.id),
            tasks: [
                { branch_id: 'feat/task-1', description: 'Task 1' },
                { branch_id: 'feat/task-2', description: 'Task 2' },
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
describe('issueTools — gh_iid + gl_iid tri-source', () => {
    it('issue_create with issue_sync=gh populates gh_iid from remote', async () => {
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
            objective: 'tri-source gh create',
            _spawnFn: makeSpawnFn([{
                    status: 0,
                    stdout: 'https://github.com/owner/repo/issues/77\n',
                    stderr: '',
                }, {
                    status: 0,
                    stdout: '{"number":77,"url":"https://github.com/owner/repo/issues/77"}',
                    stderr: '',
                }]),
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
        assert.equal(issue.remote_iid, 77);
        assert.equal(issue.remote_kind, 'github');
        const row = db.get('SELECT gh_iid, gl_iid FROM issues WHERE id = ?', [issue.id]);
        assert.equal(row?.gh_iid, 77, 'gh_iid must be set after gh sync');
        assert.equal(row?.gl_iid, null, 'gl_iid must remain null for gh-only sync');
        db.close();
    });
    it('issue_create with issue_sync=glab populates gl_iid from remote', async () => {
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
            objective: 'tri-source glab create',
            _spawnFn: makeSpawnFn([{
                    status: 0,
                    stdout: 'https://gitlab.com/owner/repo/-/issues/55\n',
                    stderr: '',
                }, {
                    status: 0,
                    stdout: 'issue 55 details',
                    stderr: '',
                }]),
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
        assert.equal(issue.remote_iid, 55);
        assert.equal(issue.remote_kind, 'gitlab');
        const row = db.get('SELECT gh_iid, gl_iid FROM issues WHERE id = ?', [issue.id]);
        assert.equal(row?.gh_iid, null, 'gh_iid must remain null for glab-only sync');
        assert.equal(row?.gl_iid, 55, 'gl_iid must be set after glab sync');
        db.close();
    });
    it('issue_close mirrors to gh when gh_iid is set', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'tri-source close gh',
        });
        const issue = parseResult(createResult);
        db.run(`UPDATE issues SET gh_iid = 101, remote_iid = 101, remote_kind = 'github' WHERE id = ?`, [issue.id]);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError, 'issue_close should succeed with gh_iid set');
        assert.equal(closed.status, 'closed');
        db.close();
    });
    it('issue_close mirrors to gl when gl_iid is set', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'tri-source close gl',
        });
        const issue = parseResult(createResult);
        db.run(`UPDATE issues SET gl_iid = 202, remote_iid = 202, remote_kind = 'gitlab' WHERE id = ?`, [issue.id]);
        const closeResult = await call(tools.handlers, 'issue_close', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const closed = parseResult(closeResult);
        assert.ok(!closeResult.isError, 'issue_close should succeed with gl_iid set');
        assert.equal(closed.status, 'closed');
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
            _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated gh auth error' }]),
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
        assert.equal(created.objective, 'Test gh sync failure fallback');
        assert.equal(created.status, 'open');
        assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync fails');
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
            _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated glab auth error' }]),
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
        assert.equal(created.objective, 'Test glab sync failure fallback');
        assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync fails');
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
        // _spawnFn guards against real remote calls if a backend is detected in this environment
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Test auto with no remote',
            _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated no-remote failure' }]),
        });
        const created = parseResult(result);
        assert.ok(!result.isError, 'Local insert must succeed even when no backend available');
        assert.equal(created.objective, 'Test auto with no remote');
        assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when no backend resolves');
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
        db.run(`UPDATE issues SET remote_iid = 99, remote_kind = 'github' WHERE id = ?`, [issue.id]);
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
    it('issue_create with successful sync bumps updated_at (regression: Bug 2)', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'gh',
        });
        const tools = issueTools(db);
        const before = new Date().toISOString();
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'updated_at regression',
            _spawnFn: makeSpawnFn([{
                    status: 0,
                    stdout: 'https://github.com/owner/repo/issues/42\n',
                    stderr: '',
                }, {
                    status: 0,
                    stdout: '{"number":42,"url":"https://github.com/owner/repo/issues/42"}',
                    stderr: '',
                }]),
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
        assert.equal(issue.remote_iid, 42, 'remote_iid should be set after successful sync');
        const row = db.get(`SELECT updated_at, remote_iid FROM issues WHERE id = ?`, [issue.id]);
        assert.ok(row, 'issue row must exist');
        assert.equal(row.remote_iid, 42, 'remote_iid must be persisted');
        assert.ok(row.updated_at >= before, `updated_at must be set on successful remote_iid UPDATE, got: ${row.updated_at}`);
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
    it('issue_get_phase returns ready_to_close when all tasks completed and issue open', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Phase regression test issue',
        });
        const issue = parseResult(createResult);
        assert.ok(!createResult.isError);
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-a', 'main', '', 'task a', 'completed', 0, '', '', datetime('now'), datetime('now'))`, [issue.id]);
        const phaseResult = await call(tools.handlers, 'issue_get_phase', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const phaseData = parseResult(phaseResult);
        assert.ok(!phaseResult.isError, `Expected no error: ${JSON.stringify(phaseData)}`);
        assert.equal(phaseData.phase, 'ready_to_close', `Expected ready_to_close, got ${phaseData.phase}`);
        assert.equal(phaseData.counts.tasks_total, 1);
        assert.equal(phaseData.counts.tasks_completed, 1);
        db.close();
    });
    it('issue_get_phase returns tasks when some tasks still pending', async () => {
        const db = tempDB();
        const tools = issueTools(db);
        const createResult = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'Phase tasks regression test',
        });
        const issue = parseResult(createResult);
        assert.ok(!createResult.isError);
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-b', 'main', '', 'task b', 'completed', 0, '', '', datetime('now'), datetime('now'))`, [issue.id]);
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-c', 'main', '', 'task c', 'pending', 0, '', '', datetime('now'), datetime('now'))`, [issue.id]);
        const phaseResult = await call(tools.handlers, 'issue_get_phase', {
            agent: 'bro',
            issue_id: String(issue.id),
        });
        const phaseData = parseResult(phaseResult);
        assert.ok(!phaseResult.isError);
        assert.equal(phaseData.phase, 'tasks', `Expected tasks, got ${phaseData.phase}`);
        db.close();
    });
});
describe('issueTools — issue-sync hardening (#314)', () => {
    it('blank remote URL in remotes config → sync skipped with diagnostic', async () => {
        const db = tempDB();
        const cfgTools = configTools(db);
        await call(cfgTools.handlers, 'config_set', {
            agent: 'bro',
            key: 'issue_sync',
            value: 'gh',
        });
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('remotes', ?)`, [JSON.stringify([{ name: 'origin', provider: 'github', url: '' }])]);
        const tools = issueTools(db);
        const noCallSpawn = makeSpawnFn([]);
        const result = await call(tools.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'blank URL sync skip test',
            _spawnFn: noCallSpawn,
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
        assert.equal(issue.remote_iid ?? null, null, 'remote_iid must be null when URL is blank');
        assert.ok(issue._sync, 'sync diagnostic must be present');
        assert.equal(issue._sync.sync_skipped, true, 'sync_skipped must be true');
        assert.equal(issue._sync.reason, 'blank_remote_url');
        db.close();
    });
    it('read-back returns PR url → no gh_iid persisted, diagnostic surfaced (#314)', async () => {
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
            objective: 'verify_failed PR test',
            _spawnFn: makeSpawnFn([
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
            ]),
        });
        const issue = parseResult(result);
        assert.ok(!result.isError, 'local insert must succeed even when verify fails');
        assert.equal(issue.remote_iid ?? null, null, 'remote_iid must NOT be persisted when verify_failed');
        const row = db.get('SELECT gh_iid FROM issues WHERE id = ?', [issue.id]);
        assert.equal(row?.gh_iid ?? null, null, 'gh_iid must NOT be persisted when read-back shows PR');
        assert.ok(issue._sync, 'sync diagnostic must be present');
        assert.equal(issue._sync.sync_failed, true);
        assert.equal(issue._sync.reason, 'verify_failed');
        db.close();
    });
});
//# sourceMappingURL=issues.test.js.map