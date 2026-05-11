import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { validationTools } from '../tools/validation.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
async function createIssue(db) {
    const issues = issueTools(db);
    const result = await call(issues.handlers, 'issue_create', {
        agent: 'bro',
        objective: 'Validation test carrier issue',
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `issue_create failed: ${JSON.stringify(data)}`);
    return data.id;
}
async function createTask(db, issueId) {
    const tasks = taskTools(db);
    const result = await call(tasks.handlers, 'task_create_batch', {
        waive_scope_gate: true,
        waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true,
        waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        waive_intent_gate: true,
        waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true,
        waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'fix/validation-test', description: 'Test task', success_criteria: 'passes' }],
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `task_create_batch failed: ${JSON.stringify(data)}`);
    return data[0].id;
}
describe('validation_record subagent_session_id gate', () => {
    let db;
    let taskId;
    before(async () => {
        db = tempDB();
        const issueId = await createIssue(db);
        taskId = await createTask(db, issueId);
    });
    after(() => {
        db.close();
    });
    it('rejects pr-reviewer call without subagent_session_id with precondition_failed', async () => {
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 1,
            verdict: 'pass',
            feedback: '# LGTM',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('precondition_failed'), `Error must cite precondition_failed: ${data.error}`);
        assert.ok(data.error.includes('subagent_session_id'), `Error must mention subagent_session_id: ${data.error}`);
    });
    it('accepts pr-reviewer call with subagent_session_id and persists it', async () => {
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 1,
            verdict: 'pass',
            feedback: 'MCP available: yes\n# LGTM',
            subagent_session_id: 'abc123',
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const row = parseResult(result);
        assert.equal(row.agent, 'pr-reviewer');
        assert.equal(row.verdict, 'pass');
        assert.equal(row.subagent_session_id, 'abc123', 'subagent_session_id must be stored on the row');
        assert.equal(row.task_id, taskId);
        assert.equal(row.attempt_n, 1);
    });
    it('rejects bro call with forbidden (not precondition_failed) — role gate fires first', async () => {
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'bro',
            task_id: taskId,
            attempt_n: 2,
            verdict: 'pass',
            feedback: '# Bro self-sign attempt',
        });
        assert.ok(result.isError, 'Expected error for bro caller');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden', `Expected forbidden, got: ${data.error}`);
        assert.ok(!String(data.error).includes('precondition_failed'), 'bro must not hit the subagent_session_id gate; it should be blocked by requireRoles');
    });
    it('rejects swe call with forbidden (not precondition_failed) — role gate fires first', async () => {
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'swe',
            task_id: taskId,
            attempt_n: 2,
            verdict: 'pass',
            feedback: '# SWE self-sign attempt',
        });
        assert.ok(result.isError, 'Expected error for swe caller');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden', `Expected forbidden, got: ${data.error}`);
        assert.ok(!String(data.error).includes('precondition_failed'), 'swe must not hit the subagent_session_id gate; it should be blocked by requireRoles');
    });
    it('backward compat: pre-migration rows with NULL subagent_session_id are readable via validation_history', async () => {
        const altDb = tempDB();
        const issueId = await createIssue(altDb);
        const altTaskId = await createTask(altDb, issueId);
        altDb.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))`, [altTaskId, 1, 'pr-reviewer', 'pass', 'MCP available: yes\n# Legacy row']);
        const tools = validationTools(altDb);
        const result = await call(tools.handlers, 'validation_history', {
            agent: 'bro',
            task_id: altTaskId,
        });
        assert.ok(!result.isError, `validation_history failed: ${JSON.stringify(parseResult(result))}`);
        const rows = parseResult(result);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].subagent_session_id, null, 'Legacy rows must have null subagent_session_id');
        altDb.close();
    });
});
//# sourceMappingURL=validation.test.js.map