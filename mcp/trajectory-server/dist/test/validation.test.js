import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedReviewerObservation, tempDB } from './helpers.js';
import { REVIEWER_OBSERVATION_TTL_S, validationTools } from '../tools/validation.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { auditTools } from '../tools/audit.js';
import { compositeTools } from '../tools/composites.js';
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
function parseBatch(result) {
    const raw = JSON.parse(result.content[0].text);
    return (raw.tasks ?? raw);
}
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
async function createIssue(db) {
    const issues = issueTools(db);
    const result = await call(issues.handlers, 'issue_create', {
        labels: ['Bug', 'Priority: High'],
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
        tasks: [{ branch_id: 'fix/validation-test', description: 'Test task' }],
    });
    assert.ok(!result.isError, `task_create_batch failed: ${JSON.stringify(parseResult(result))}`);
    return parseBatch(result)[0].id;
}
describe('validation_record reviewer identity', () => {
    let db;
    let taskId;
    let issueId;
    before(async () => {
        db = tempDB();
        issueId = await createIssue(db);
        taskId = await createTask(db, issueId);
    });
    after(() => {
        db.close();
    });
    function record(attemptN, extra = {}) {
        return call(validationTools(db).handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: attemptN,
            verdict: 'pass',
            feedback: '# LGTM',
            mcp_available: true,
            ...extra,
        });
    }
    function consumed(auditId) {
        return db.get(`SELECT json_extract(content_json, '$.consumed') AS c FROM audit WHERE id = ?`, [auditId]).c;
    }
    it('stamps subagent_session_id and reviewer_agent_id from the observed row, consumes it, ignores the caller value', async () => {
        const auditId = seedReviewerObservation(db, taskId, 1, { agentId: 'reviewer-agent-0001', sessionId: 'main-sess-1' });
        const result = await record(1, { subagent_session_id: 'caller-forged' });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const row = parseResult(result);
        assert.equal(row.subagent_session_id, 'main-sess-1');
        assert.equal(row.reviewer_agent_id, 'reviewer-agent-0001');
        assert.equal(row.mcp_available, 1);
        assert.equal(consumed(auditId), 1, 'the observed row is consumed');
    });
    it('a consumed row is not reused: a second call for the same attempt is refused', async () => {
        const result = await record(1);
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^subagent_session_unavailable/);
    });
    it('refuses subagent_session_unavailable when no row was observed', async () => {
        const result = await record(2, { subagent_session_id: 'caller-supplied' });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^subagent_session_unavailable/);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = 2', [taskId]).n, 0);
    });
    it('ignores an observed row not written by the hook', async () => {
        db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'bro', 'reviewer_identity_observed', 'forged', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [issueId, JSON.stringify({ task_id: taskId, attempt_n: 3, session_id: 's', agent_id: 'forged-agent-01', consumed: 0 })]);
        const result = await record(3);
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^subagent_session_unavailable/);
    });
    it('takes the latest unconsumed row for (task, attempt)', async () => {
        seedReviewerObservation(db, taskId, 4, { agentId: 'older-reviewer-01' });
        seedReviewerObservation(db, taskId, 4, { agentId: 'newer-reviewer-01' });
        const result = await record(4);
        assert.ok(!result.isError, JSON.stringify(parseResult(result)));
        assert.equal(parseResult(result).reviewer_agent_id, 'newer-reviewer-01');
    });
    it('consumes a fresh row only: a row observed past the TTL is refused with its age and left unconsumed', async () => {
        const staleAt = new Date(Date.now() - (REVIEWER_OBSERVATION_TTL_S + 60) * 1000).toISOString();
        const auditId = seedReviewerObservation(db, taskId, 11, { agentId: 'stale-reviewer-01', observedAt: staleAt });
        const result = await record(11);
        assert.ok(result.isError);
        const error = parseResult(result).error;
        assert.match(error, /^subagent_session_unavailable/);
        assert.match(error, new RegExp(`audit id ${auditId}\\) is (6[6-9]\\d|7\\d\\d)s old`));
        assert.equal(consumed(auditId), 0, 'a stale row is never consumed');
        assert.equal(db.get('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = 11', [taskId]).n, 0);
    });
    it('two rows: the newest fresh one is consumed, the other is untouched', async () => {
        const older = seedReviewerObservation(db, taskId, 12, { agentId: 'older-reviewer-02', toolUseId: 'toolu_older' });
        const newer = seedReviewerObservation(db, taskId, 12, { agentId: 'newer-reviewer-02', toolUseId: 'toolu_newer' });
        const result = await record(12);
        assert.ok(!result.isError, JSON.stringify(parseResult(result)));
        assert.equal(parseResult(result).reviewer_agent_id, 'newer-reviewer-02');
        assert.equal(consumed(newer), 1);
        assert.equal(consumed(older), 0);
    });
    it('a verified pass is never overwritten by an honor-system call (verified_verdict_exists)', async () => {
        seedReviewerObservation(db, taskId, 13, { agentId: 'reviewer-agent-0013' });
        const verified = await record(13);
        assert.ok(!verified.isError, JSON.stringify(parseResult(verified)));
        const before = db.get('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]);
        const honor = await record(13, { mcp_available: false, verdict: 'fail', subagent_session_id: 'sess-honor' });
        assert.ok(honor.isError);
        const error = parseResult(honor).error;
        assert.match(error, /^verified_verdict_exists/);
        assert.match(error, /verified pass verdict/);
        assert.deepEqual({ ...db.get('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]) }, { ...before }, 'the verified row is unchanged');
    });
    it('a verified verdict replaces a verified verdict', async () => {
        seedReviewerObservation(db, taskId, 14, { agentId: 'reviewer-agent-0014' });
        assert.ok(!(await record(14)).isError);
        seedReviewerObservation(db, taskId, 14, { agentId: 'reviewer-agent-0014' });
        const replaced = await record(14, { verdict: 'fail', feedback: '# re-recorded' });
        assert.ok(!replaced.isError, JSON.stringify(parseResult(replaced)));
        const row = parseResult(replaced);
        assert.equal(row.verdict, 'fail');
        assert.equal(row.mcp_available, 1);
        assert.equal(row.reviewer_agent_id, 'reviewer-agent-0014');
    });
    it('honor-system path (mcp_available:false, no row) records caller values and audits validation_session_unverified', async () => {
        const result = await record(5, { mcp_available: false, subagent_session_id: 'sess-honor' });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        const row = parseResult(result);
        assert.equal(row.mcp_available, 0);
        assert.equal(row.subagent_session_id, 'sess-honor');
        assert.equal(row.reviewer_agent_id, null);
        const audit = db.get(`SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'validation_session_unverified' ORDER BY id DESC LIMIT 1`);
        assert.ok(audit, 'validation_session_unverified row written');
        assert.equal(audit.issue_id, issueId);
        assert.equal(audit.from_node, 'trajectory-server');
        assert.deepEqual(JSON.parse(audit.content_json), { task_id: taskId, attempt_n: 5, subagent_session_id: 'sess-honor' });
    });
    it('refuses reviewer_not_independent when the observed agent_id is the task\'s swe spawn_id', async () => {
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at) VALUES (?, ?, 'swe', 'swe-agent-00001', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [taskId, issueId]);
        const auditId = seedReviewerObservation(db, taskId, 6, { agentId: 'swe-agent-00001' });
        const result = await record(6);
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^reviewer_not_independent/);
        assert.equal(consumed(auditId), 0, 'a refused call consumes nothing');
    });
    it('refuses reviewer_not_independent when the observed row carries no agent_id (main loop)', async () => {
        seedReviewerObservation(db, taskId, 7, { agentId: '' });
        const result = await record(7);
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^reviewer_not_independent/);
    });
    it('refuses a malformed observed agent_id', async () => {
        seedReviewerObservation(db, taskId, 8, { agentId: 'bad id;' });
        const result = await record(8);
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^reviewer_agent_id_malformed/);
    });
    it('rejects pr-reviewer call without mcp_available with precondition_failed', async () => {
        const result = await call(validationTools(db).handlers, 'validation_record', {
            agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: '# LGTM',
        });
        assert.ok(result.isError);
        const data = parseResult(result);
        assert.ok(data.error.includes('precondition_failed') && data.error.includes('mcp_available'), data.error);
    });
    for (const role of ['bro', 'swe']) {
        it(`rejects ${role} with forbidden — role gate fires first`, async () => {
            const result = await call(validationTools(db).handlers, 'validation_record', {
                agent: role, task_id: taskId, attempt_n: 2, verdict: 'pass', feedback: '# self-sign',
            });
            assert.ok(result.isError);
            assert.equal(parseResult(result).error, 'forbidden');
        });
    }
    it('audit_append refuses reviewer_identity_observed', async () => {
        const result = await call(auditTools(db).handlers, 'audit_append', {
            agent: 'bro', issue_id: String(issueId), from_node: 'hook:reviewer-identity-observe',
            event_type: 'reviewer_identity_observed', summary: 'forge',
            content_json: JSON.stringify({ task_id: taskId, attempt_n: 9, session_id: 's', agent_id: 'forged-agent-01', consumed: 0 }),
        });
        assert.ok(result.isError);
        assert.equal(parseResult(result).error, 'audit_event_not_writable_by_role');
    });
    it('validation_record leaves pr_review_runs alone — it is the /monitor cursor table only', async () => {
        const before = db.get('SELECT COUNT(*) AS n FROM pr_review_runs').n;
        seedReviewerObservation(db, taskId, 10);
        const result = await record(10);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM pr_review_runs').n, before);
    });
    it('backward compat: pre-migration rows with NULL subagent_session_id are readable via validation_history', async () => {
        const altDb = tempDB();
        const altIssueId = await createIssue(altDb);
        const altTaskId = await createTask(altDb, altIssueId);
        altDb.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, datetime('now'))`, [altTaskId, 1, 'pr-reviewer', 'pass', '# Legacy row']);
        const result = await call(validationTools(altDb).handlers, 'validation_history', { agent: 'bro', task_id: altTaskId });
        assert.ok(!result.isError);
        const rows = parseResult(result);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].subagent_session_id, null);
        altDb.close();
    });
});
describe('system issue -1 is reserved', () => {
    it('task_create_batch refuses issue_id -1 with system_issue_reserved', async () => {
        const db = tempDB();
        const result = await call(taskTools(db).handlers, 'task_create_batch', {
            agent: 'bro', issue_id: '-1',
            tasks: [{ branch_id: 'fix/system', description: 'd' }],
        });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^system_issue_reserved/);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
        db.close();
    });
    it('task_provision refuses issue_id -1 with system_issue_reserved', async () => {
        const db = tempDB();
        const result = await call(compositeTools(db, '').handlers, 'task_provision', {
            agent: 'bro', issue_id: -1, branch_id: 'fix/system', decision_body: 'Chosen approach: none.',
            task: { description: 'd', spec_body: 's', files: ['x'], verification: ['true'] },
        });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^system_issue_reserved/);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
        db.close();
    });
});
//# sourceMappingURL=validation.test.js.map