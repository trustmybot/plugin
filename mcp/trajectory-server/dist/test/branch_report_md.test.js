import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { branchReportMdTools } from '../tools/branch_report_md.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { auditTools } from '../tools/audit.js';
import { validationTools } from '../tools/validation.js';
import { nowISO } from '../db.js';
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
async function createIssue(db) {
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
        agent: 'bro',
        objective: 'Branch report test issue',
    });
    return parseResult(result).id;
}
async function createTask(db, issueId, branchId) {
    const tools = taskTools(db);
    const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true,
        waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true,
        waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
            {
                branch_id: branchId,
                description: 'Test task description',
                success_criteria: 'Done',
            },
        ],
    });
    const rows = parseResult(result);
    return rows[0].id;
}
/**
 * Insert a task row directly via SQL, bypassing tool-layer side effects
 * (scope-gate audit entries etc.). Used when the test needs a clean audit table.
 */
function insertTaskDirect(db, issueId, branchId) {
    const now = nowISO();
    const result = db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, tools_required, skills_required, success_criteria, status, attempts, spec_body, created_at, updated_at)
     VALUES (?, ?, '', 'Direct insert for unit test', '[]', '[]', 'Done', 'pending', 0, '', ?, ?)`, [issueId, branchId, now, now]);
    return Number(result.lastInsertRowid);
}
describe('branchReportMdTools', () => {
    it('happy path — renders all four sections for valid (issue_id, branch_id)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const branchId = 'feat/my-feature';
        const taskId = await createTask(db, issueId, branchId);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: branchId,
            from_node: 'swe',
            kind: 'event',
            event_type: 'task_started',
            summary: 'SWE began work on feature',
        });
        const validation = validationTools(db);
        await call(validation.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 1,
            verdict: 'pass',
            feedback: 'MCP available: yes\nLooks good',
            subagent_session_id: 'test-session-abc',
        });
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: branchId,
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.ok(typeof data.markdown === 'string', 'Expected markdown string');
        const md = data.markdown;
        assert.ok(md.includes(`# Branch Report — ${branchId} (issue #${issueId})`), 'Missing header');
        assert.ok(md.includes('**Issue objective:**'), 'Missing issue objective');
        assert.ok(md.includes('## Tasks on this branch'), 'Missing Tasks section');
        assert.ok(md.includes('## Audit events'), 'Missing Audit events section');
        assert.ok(md.includes('## Validation attempts'), 'Missing Validation attempts section');
        assert.ok(md.includes('## file_registry entries touched on this branch'), 'Missing file_registry section');
        assert.ok(md.includes('SWE began work on feature'), 'Audit entry missing from report');
        assert.ok(md.includes('pass'), 'Validation verdict missing from report');
        db.close();
    });
    it('missing issue_id — returns error', async () => {
        const db = tempDB();
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: '99999',
            branch_id: 'feat/nonexistent',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('99999'), `Error should mention issue_id: ${data.error}`);
        db.close();
    });
    it('invalid issue_id format — returns error', async () => {
        const db = tempDB();
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: 'not-a-number',
            branch_id: 'feat/test',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('issue_id must be a positive integer'), `Error should mention integer requirement: ${data.error}`);
        db.close();
    });
    it('missing branch_id — returns error when no tasks match', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: 'feat/does-not-exist',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('No tasks found'), `Error should mention no tasks: ${data.error}`);
        assert.ok(data.error.includes('feat/does-not-exist'), `Error should include the branch_id: ${data.error}`);
        db.close();
    });
    it('no-matching-task — pair with valid issue but wrong branch returns error', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        await createTask(db, issueId, 'feat/actual-branch');
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: 'feat/wrong-branch',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('No tasks found'), `Expected no-tasks error: ${data.error}`);
        db.close();
    });
    it('empty audit events and validation — sections render with empty placeholders', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const branchId = 'feat/empty-branch';
        // Use direct SQL insert to avoid scope_gate_waived audit side-effect from createTask.
        insertTaskDirect(db, issueId, branchId);
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: branchId,
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        const md = data.markdown;
        assert.ok(md.includes('_No audit events._'), 'Expected empty audit events placeholder');
        assert.ok(md.includes('_No validation attempts._'), 'Expected empty validation placeholder');
        assert.ok(md.includes('_No file_registry entries found for this branch._'), 'Expected empty file_registry placeholder');
        db.close();
    });
    it('requireRoles — rejects malformed agent name (unknown role)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: '!!!malformed',
            issue_id: String(issueId),
            branch_id: 'feat/test',
        });
        assert.ok(result.isError, 'Expected error result for malformed agent');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden', `Expected forbidden error: ${JSON.stringify(data)}`);
        db.close();
    });
    it('all allowed agents are accepted (bro, consultant agents, swe, pr-reviewer)', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const branchId = 'feat/agent-test';
        await createTask(db, issueId, branchId);
        const tools = branchReportMdTools(db);
        for (const agent of ['bro', 'architect', 'cto', 'legal-reviewer', 'swe', 'pr-reviewer']) {
            const result = await call(tools.handlers, 'branch_report_md', {
                agent,
                issue_id: String(issueId),
                branch_id: branchId,
            });
            assert.ok(!result.isError, `Agent "${agent}" should be accepted`);
        }
        db.close();
    });
    it('scopes audit events to branch — sibling branch events not included', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const targetBranch = 'feat/target';
        const siblingBranch = 'feat/sibling';
        await createTask(db, issueId, targetBranch);
        await createTask(db, issueId, siblingBranch);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: targetBranch,
            from_node: 'swe',
            kind: 'event',
            event_type: 'task_started',
            summary: 'Started target branch work',
        });
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: siblingBranch,
            from_node: 'swe',
            kind: 'event',
            event_type: 'task_started',
            summary: 'Started sibling branch work',
        });
        const tools = branchReportMdTools(db);
        const result = await call(tools.handlers, 'branch_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
            branch_id: targetBranch,
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        const md = data.markdown;
        assert.ok(md.includes('Started target branch work'), 'Target branch audit entry should be present');
        assert.ok(!md.includes('Started sibling branch work'), 'Sibling branch audit entry should NOT be present');
        db.close();
    });
});
//# sourceMappingURL=branch_report_md.test.js.map