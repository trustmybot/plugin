import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { auditTools } from '../tools/audit.js';
function makeGitSubdir(name) {
    const dir = join(process.cwd(), name);
    mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
    return { name, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function call(handlers, name, args) {
    return (await handlers[name](args));
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
async function createIssue(db) {
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
        agent: 'bro',
        objective: 'Test issue',
    });
    const data = parseResult(result);
    return data.id;
}
describe('taskTools', () => {
    it('task_create_batch inserts N rows atomically', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/task-one', description: 'Task one' },
                { branch_id: 'feat/task-two', description: 'Task two' },
                { branch_id: 'feat/task-three', description: 'Task three' },
            ],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.ok(Array.isArray(inserted));
        assert.equal(inserted.length, 3);
        assert.equal(inserted[0].branch_id, 'feat/task-one');
        assert.equal(inserted[1].branch_id, 'feat/task-two');
        assert.equal(inserted[2].branch_id, 'feat/task-three');
        assert.ok(inserted.every((t) => t.status === 'pending'));
        db.close();
    });
    it('task_update_status rejects unknown status', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/a-task', description: 'A task' }],
        });
        const tasks = parseResult(batchResult);
        const result = await call(tools.handlers, 'task_update_status', {
            agent: 'bro',
            task_id: String(tasks[0].id),
            status: 'banana',
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid status/);
        assert.match(data.error, /banana/);
        db.close();
    });
    it('task_first_actionable returns lowest branch_id among pending/failed', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/first', description: 'First' },
                { branch_id: 'feat/second', description: 'Second' },
                { branch_id: 'feat/third', description: 'Third' },
            ],
        });
        const allTasks = db.all('SELECT id, branch_id FROM tasks WHERE issue_id = ? ORDER BY branch_id', [issueId]);
        // SWE completes the first (completion is swe's transition, not bro's).
        await call(tools.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: String(allTasks[0].id),
            status: 'completed',
        });
        await call(tools.handlers, 'task_update_status', {
            agent: 'bro',
            task_id: String(allTasks[1].id),
            status: 'failed',
        });
        const result = await call(tools.handlers, 'task_first_actionable', {
            agent: 'bro',
            issue_id: String(issueId),
        });
        const task = parseResult(result);
        assert.ok(!result.isError);
        assert.ok(task !== null);
        assert.equal(task.branch_id, 'feat/second');
        db.close();
    });
    it('task_update_status accepts every legal bro transition through the lifecycle (#278)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/lifecycle', description: 'lifecycle walk' }],
        });
        const taskId = String(parseResult(batchResult)[0].id);
        const step = async (status) => {
            const result = await call(tools.handlers, 'task_update_status', {
                agent: 'bro', task_id: taskId, status,
            });
            const updated = parseResult(result);
            assert.ok(!result.isError, `Expected legal transition to "${status}": ${JSON.stringify(updated)}`);
            assert.equal(updated.status, status);
            return updated;
        };
        await step('running'); // pending → running
        await step('needs_validation'); // running → needs_validation
        const completed = await step('completed'); // needs_validation → completed
        assert.ok(completed.completed_at, 'completed sets completed_at');
        const closed = await step('closed'); // completed → closed
        assert.ok(closed.completed_at, 'closed preserves the completion stamp');
        await step('escalated'); // closed → escalated (push-gate pushback)
        db.close();
    });
    it('task_update_status rejects illegal bro transitions and clears completed_at on reopen (#278)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const waivers = {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        };
        const mk = async (branch) => {
            const r = await call(tools.handlers, 'task_create_batch', {
                ...waivers, agent: 'bro', issue_id: String(issueId),
                tasks: [{ branch_id: branch, description: 'x' }],
            });
            return String(parseResult(r)[0].id);
        };
        // pending → closed is rejected: bro can't skip verification.
        const t1 = await mk('feat/illegal-close');
        const r1 = await call(tools.handlers, 'task_update_status', { agent: 'bro', task_id: t1, status: 'closed' });
        assert.ok(r1.isError, 'bro must not jump pending → closed');
        // pending → completed is rejected: bro can't fabricate completion.
        const t2 = await mk('feat/illegal-complete');
        const r2 = await call(tools.handlers, 'task_update_status', { agent: 'bro', task_id: t2, status: 'completed' });
        assert.ok(r2.isError, 'bro must not jump pending → completed');
        // Reopening out of 'completed' clears the stale completion stamp.
        const t3 = await mk('feat/reopen-clears-stamp');
        await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: t3, status: 'running' });
        const comp = parseResult(await call(tools.handlers, 'task_update_status', {
            agent: 'swe', task_id: t3, status: 'completed', commit_sha: 'abc1234',
        }));
        assert.ok(comp.completed_at, 'completed sets completed_at');
        const reopened = parseResult(await call(tools.handlers, 'task_update_status', {
            agent: 'bro', task_id: t3, status: 'needs_validation',
        }));
        assert.equal(reopened.completed_at, null, 'reopening out of completed clears completed_at');
        db.close();
    });
    it('task_create_batch accepts valid git-convention branch_id: feat/user-login', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/user-login', description: 'login feature' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].branch_id, 'feat/user-login');
        db.close();
    });
    it('task_create_batch accepts valid git-convention branch_id: refactor/extract-helper', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'refactor/extract-helper', description: 'extract helper' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].branch_id, 'refactor/extract-helper');
        db.close();
    });
    it('task_create_batch rejects branch_id with uppercase type: Foo/Bar', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'Foo/Bar', description: 'bad' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch rejects branch_id with uppercase slug: feat/UPPERCASE', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/UPPERCASE', description: 'bad' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch rejects branch_id with leading hyphen: feat/-leading-hyphen', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/-leading-hyphen', description: 'bad' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch rejects empty branch_id', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: '', description: 'bad' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /branch_id/);
        db.close();
    });
    it('task_create_batch rejects branch_id with double slash: feat/double//slash', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/double//slash', description: 'bad' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch rejects invalid parent_branch_id', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/foo',
                    parent_branch_id: 'bad value',
                    description: 'bad parent',
                },
            ],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch accepts parent_branch_id="dev"', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/from-dev', parent_branch_id: 'dev', description: 'branches off dev' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].parent_branch_id, 'dev');
        db.close();
    });
    it('task_create_batch accepts parent_branch_id="main"', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/from-main', parent_branch_id: 'main', description: 'branches off main' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].parent_branch_id, 'main');
        db.close();
    });
    it('task_create_batch accepts parent_branch_id="master"', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/from-master', parent_branch_id: 'master', description: 'branches off master' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].parent_branch_id, 'master');
        db.close();
    });
    it('task_create_batch accepts parent_branch_id="feat/foo" (git-convention still works)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/child-task', parent_branch_id: 'feat/foo', description: 'child of feat/foo' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].parent_branch_id, 'feat/foo');
        db.close();
    });
    it('task_create_batch rejects parent_branch_id="random-junk"', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/foo', parent_branch_id: 'random-junk', description: 'bad parent' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch rejects branch_id="dev" (own branch must stay strict-format)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'dev', description: 'bad branch_id' }],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid branch_id/);
        db.close();
    });
    it('task_create_batch stores spec_body and task_get returns it verbatim', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const specBody = '# Description\nThis is a test spec body.';
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/spec-body-test',
                    description: 'Test spec body storage',
                    spec_body: specBody,
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        const getResult = await call(tools.handlers, 'task_get', {
            agent: 'bro',
            task_id: String(inserted[0].id),
        });
        const task = parseResult(getResult);
        assert.ok(!getResult.isError);
        assert.equal(task.spec_body, specBody);
        db.close();
    });
    it('task_create_batch without spec_body defaults to empty string', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/no-spec-body',
                    description: 'No spec body',
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].spec_body, '');
        db.close();
    });
    it('task_create_batch rejects spec_body longer than 8000 chars (over-engineering guard)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const oversizeBody = 'x'.repeat(8001);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/oversize-spec',
                    description: 'Oversize spec body',
                    spec_body: oversizeBody,
                },
            ],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /8000/);
        assert.match(data.error, /8001/);
        db.close();
    });
    it('task_update_status rejects SWE writes of non-terminal status (needs_validation, pending, closed, escalated)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/swe-guard-test', description: 'SWE guard test' },
            ],
        });
        const tasks = parseResult(batchResult);
        const taskId = String(tasks[0].id);
        const forbiddenStatuses = ['needs_validation', 'pending', 'closed', 'escalated'];
        for (const status of forbiddenStatuses) {
            const result = await call(tools.handlers, 'task_update_status', {
                agent: 'swe',
                task_id: taskId,
                status,
            });
            const data = parseResult(result);
            assert.ok(result.isError, `Expected isError=true for SWE + status='${status}'`);
            assert.match(data.error, /task_update_status rejected/, `Expected rejection message for status='${status}'`);
            assert.match(data.error, /#114/, `Expected #114 reference for status='${status}'`);
        }
        db.close();
    });
    it('task_update_status allows SWE writes of running, completed, and failed', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/swe-running-test', description: 'SWE running test' },
                { branch_id: 'feat/swe-completed-test', description: 'SWE completed test' },
                { branch_id: 'feat/swe-failed-test', description: 'SWE failed test' },
            ],
        });
        const tasks = parseResult(batchResult);
        const runningResult = await call(tools.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: String(tasks[0].id),
            status: 'running',
        });
        assert.ok(!runningResult.isError, `Expected no error for SWE + status='running': ${JSON.stringify(parseResult(runningResult))}`);
        assert.equal(parseResult(runningResult).status, 'running');
        const completedResult = await call(tools.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: String(tasks[1].id),
            status: 'completed',
        });
        assert.ok(!completedResult.isError, `Expected no error for SWE + status='completed': ${JSON.stringify(parseResult(completedResult))}`);
        assert.equal(parseResult(completedResult).status, 'completed');
        const failedResult = await call(tools.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: String(tasks[2].id),
            status: 'failed',
        });
        assert.ok(!failedResult.isError, `Expected no error for SWE + status='failed': ${JSON.stringify(parseResult(failedResult))}`);
        assert.equal(parseResult(failedResult).status, 'failed');
        db.close();
    });
    it('task_update_status lets bro close verified work and reopen for re-validation (#278)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/bro-closed-test', description: 'Bro closed test' },
                { branch_id: 'feat/bro-needs-validation-test', description: 'Bro needs_validation test' },
            ],
        });
        const tasks = parseResult(batchResult);
        // SWE completes task 0, then bro closes it (completed → closed).
        await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: String(tasks[0].id), status: 'completed', commit_sha: 'abc1234' });
        const closedResult = await call(tools.handlers, 'task_update_status', {
            agent: 'bro',
            task_id: String(tasks[0].id),
            status: 'closed',
        });
        assert.ok(!closedResult.isError, `Expected no error for completed → closed: ${JSON.stringify(parseResult(closedResult))}`);
        assert.equal(parseResult(closedResult).status, 'closed');
        // Task 1: completed → needs_validation (bro reopens for re-validation).
        await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: String(tasks[1].id), status: 'completed', commit_sha: 'def5678' });
        const nvResult = await call(tools.handlers, 'task_update_status', {
            agent: 'bro',
            task_id: String(tasks[1].id),
            status: 'needs_validation',
        });
        assert.ok(!nvResult.isError, `Expected no error for completed → needs_validation: ${JSON.stringify(parseResult(nvResult))}`);
        assert.equal(parseResult(nvResult).status, 'needs_validation');
        db.close();
    });
    it('task_create_batch accepts spec_body exactly at 8000 chars (boundary)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const body = 'x'.repeat(8000);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/boundary-spec',
                    description: 'Boundary spec',
                    spec_body: body,
                },
            ],
        });
        assert.ok(!result.isError, `Expected success at 8000 chars; got: ${JSON.stringify(result)}`);
        db.close();
    });
    it('task_create_batch stores repo and task_get returns it verbatim', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/repo-test',
                    description: 'Task with repo set',
                    repo: 'inner',
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, 'inner');
        const getResult = await call(tools.handlers, 'task_get', {
            agent: 'bro',
            task_id: String(inserted[0].id),
        });
        const task = parseResult(getResult);
        assert.ok(!getResult.isError);
        assert.equal(task.repo, 'inner');
        db.close();
    });
    it('task_create_batch stores nested repo path', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/nested-repo',
                    description: 'Task with nested repo path',
                    repo: 'repos/backend',
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, 'repos/backend');
        db.close();
    });
    it('task_create_batch defaults repo to null when omitted', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/no-repo',
                    description: 'Task without repo',
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, null);
        db.close();
    });
    it('task_create_batch treats empty string repo as null', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/empty-repo',
                    description: 'Task with empty repo string',
                    repo: '',
                },
            ],
        });
        const inserted = parseResult(batchResult);
        assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, null);
        db.close();
    });
    it('task_create_batch rejects repo containing ".."', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/bad-repo',
                    description: 'Task with bad repo path',
                    repo: '../escape',
                },
            ],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid repo/);
        assert.match(data.error, /\.\./);
        db.close();
    });
    it('task_create_batch rejects repo starting with "/"', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/abs-repo',
                    description: 'Task with absolute repo path',
                    repo: '/absolute/path',
                },
            ],
        });
        const data = parseResult(result);
        assert.ok(result.isError, 'Expected isError=true');
        assert.match(data.error, /Invalid repo/);
        db.close();
    });
    it('task_create_batch accepts task when branch exists in explicit repo (#102)', async () => {
        const { name, cleanup } = makeGitSubdir('test-git-fixture-branch-exists');
        try {
            const repoDir = join(process.cwd(), name);
            spawnSync('git', ['branch', 'feat/my-feature'], { cwd: repoDir, stdio: 'pipe' });
            const db = tempDB();
            const issueId = await createIssue(db);
            const tools = taskTools(db);
            const result = await call(tools.handlers, 'task_create_batch', {
                waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
                waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                agent: 'bro',
                issue_id: String(issueId),
                tasks: [
                    {
                        branch_id: 'feat/my-feature',
                        description: 'Feature task',
                        repo: name,
                    },
                ],
            });
            const inserted = parseResult(result);
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
            assert.equal(inserted[0].branch_id, 'feat/my-feature');
            assert.equal(inserted[0].repo, name);
            db.close();
        }
        finally {
            cleanup();
        }
    });
    it('task_create_batch rejects task when branch does not exist in explicit repo (#102)', async () => {
        const { name, cleanup } = makeGitSubdir('test-git-fixture-branch-missing');
        try {
            const db = tempDB();
            const issueId = await createIssue(db);
            const tools = taskTools(db);
            const result = await call(tools.handlers, 'task_create_batch', {
                waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
                waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                agent: 'bro',
                issue_id: String(issueId),
                tasks: [
                    {
                        branch_id: 'feat/nonexistent-branch',
                        description: 'Feature task',
                        repo: name,
                    },
                ],
            });
            const data = parseResult(result);
            assert.ok(result.isError, 'Expected isError=true');
            assert.match(data.error, /task_create_batch rejected/);
            assert.match(data.error, /feat\/nonexistent-branch/);
            assert.match(data.error, /#102/);
            db.close();
        }
        finally {
            cleanup();
        }
    });
    it('task_create_batch uses subdir repo for branch check, not parent repo (#102)', async () => {
        const { name: repoA, cleanup: cleanupA } = makeGitSubdir('test-git-fixture-repo-a');
        const { name: repoB, cleanup: cleanupB } = makeGitSubdir('test-git-fixture-repo-b');
        try {
            const repoADir = join(process.cwd(), repoA);
            spawnSync('git', ['branch', 'feat/exists-in-a-only'], { cwd: repoADir, stdio: 'pipe' });
            const db = tempDB();
            const issueId = await createIssue(db);
            const tools = taskTools(db);
            const acceptedResult = await call(tools.handlers, 'task_create_batch', {
                waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
                waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                agent: 'bro',
                issue_id: String(issueId),
                tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo A', repo: repoA }],
            });
            assert.ok(!acceptedResult.isError, `Expected accepted for repoA: ${JSON.stringify(parseResult(acceptedResult))}`);
            const rejectedResult = await call(tools.handlers, 'task_create_batch', {
                waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
                waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                agent: 'bro',
                issue_id: String(issueId),
                tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo B (branch absent)', repo: repoB }],
            });
            assert.ok(rejectedResult.isError, 'Expected rejection when branch absent in repoB');
            assert.match(parseResult(rejectedResult).error, /task_create_batch rejected/);
            db.close();
        }
        finally {
            cleanupA();
            cleanupB();
        }
    });
    it('task_create_batch skips branch-existence check when repo is unset (backward compat) (#102)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                {
                    branch_id: 'feat/no-repo-set',
                    description: 'Task without explicit repo',
                },
            ],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error when repo is unset: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].branch_id, 'feat/no-repo-set');
        db.close();
    });
    it('task_create_batch rejects without branch_id_proposed audit event (#155)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            kind: 'event',
            event_type: 'some_other_event',
            summary: 'not a branch_id_proposed event',
        });
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'fix/test-gate', description: 'd' }],
        });
        assert.ok(result.isError, 'Expected isError=true');
        const data = parseResult(result);
        assert.equal(data.error, 'branch_state_violation');
        db.close();
    });
    it('task_create_batch defaults repo to tmb_default_repo config when task.repo omitted', async () => {
        const db = tempDB();
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"plugin"')`);
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/default-repo-test', description: 'No repo arg' },
            ],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, 'plugin', 'repo should default to tmb_default_repo config value');
        db.close();
    });
    it('task_create_batch defaults repo to null when task.repo omitted and tmb_default_repo not set', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [
                { branch_id: 'feat/null-repo-back-compat', description: 'No repo, no config' },
            ],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        assert.equal(inserted[0].repo, null, 'repo should be null when no config and no task.repo');
        db.close();
    });
    it('task_create_batch passes with branch_id_proposed audit event (#155)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            kind: 'event',
            event_type: 'branch_id_proposed',
            summary: 'Branch fix/test-gate created from origin/dev. Main checkout switched.',
        });
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'fix/test-gate', description: 'd' }],
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        db.close();
    });
    // Slim contract — only branch_id + description are required now. The full
    // task body lives in spec_body. Dropped: tools_required, skills_required,
    // success_criteria. Verifies a minimal payload lands a row without any of
    // the dropped columns.
    it('task_create_batch accepts the minimal slim payload (branch_id + description only)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/slim', description: 'minimal' }],
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const tasks = parseResult(result);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].branch_id, 'feat/slim');
        assert.equal(tasks[0].description, 'minimal');
        // Verify the dropped columns no longer exist on the row.
        const colInfo = db.all(`PRAGMA table_info(tasks)`);
        const present = new Set(colInfo.map((c) => c.name));
        assert.ok(!present.has('tools_required'), 'tasks.tools_required must be dropped');
        assert.ok(!present.has('skills_required'), 'tasks.skills_required must be dropped');
        assert.ok(!present.has('success_criteria'), 'tasks.success_criteria must be dropped');
        db.close();
    });
    it('scope_gate_waived audit row is inserted in the same transaction as task INSERTs', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const aTools = auditTools(db);
        const result = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true,
            waive_scope_gate_reason: 'txn regression test: verifying waiver audit is in same txn',
            waive_branch_gate: true,
            waive_branch_gate_reason: 'not under test',
            waive_intent_gate: true,
            waive_intent_gate_reason: 'not under test',
            waive_decision_gate: true,
            waive_decision_gate_reason: 'not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'feat/txn-test', description: 'txn test task' }],
        });
        const inserted = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
        const auditResult = await call(aTools.handlers, 'audit_log_list', {
            agent: 'bro',
            issue_id: String(issueId),
        });
        const auditData = parseResult(auditResult);
        assert.ok(!auditResult.isError);
        const waiverRow = auditData.find((r) => r.event_type === 'scope_gate_waived');
        assert.ok(waiverRow, 'scope_gate_waived audit row must exist after task_create_batch with waiver');
        assert.equal(waiverRow.issue_id, issueId);
        db.close();
    });
    it('task_update_status stores commit_sha lowercase', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = taskTools(db);
        const batchResult = await call(tools.handlers, 'task_create_batch', {
            waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
            waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
            waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
            agent: 'bro',
            issue_id: String(issueId),
            tasks: [{ branch_id: 'fix/sha-case', description: 'sha case test' }],
        });
        const tasks = parseResult(batchResult);
        const taskId = tasks[0].id;
        await call(tools.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: String(taskId),
            status: 'completed',
            commit_sha: 'ABCDEF1234567',
        });
        const updated = db.get(`SELECT commit_sha FROM tasks WHERE id = ?`, [taskId]);
        assert.equal(updated?.commit_sha, 'abcdef1234567', 'commit_sha must be stored lowercase');
        db.close();
    });
});
//# sourceMappingURL=tasks.test.js.map