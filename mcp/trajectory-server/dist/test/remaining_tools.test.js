import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { auditTools } from '../tools/audit.js';
import { validationTools } from '../tools/validation.js';
import { skillTools } from '../tools/skills.js';
import { reportTools } from '../tools/reports.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
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
    return parseResult(result).id;
}
async function createTask(db, issueId, branchId = 'feat/test-task') {
    const tools = taskTools(db);
    const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
            {
                branch_id: branchId,
                description: 'Test task',
            },
        ],
    });
    const rows = parseResult(result);
    return rows[0].id;
}
describe('auditTools', () => {
    it('audit_log stores small content_json intact', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'Plan done',
            content_json: JSON.stringify({ cmd: 'echo hi' }),
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.issue_id, issueId);
        assert.equal(row.event_type, 'planning_complete');
        assert.equal(row.content_json, JSON.stringify({ cmd: 'echo hi' }));
        db.close();
    });
    it('audit_log truncates content_json > 1 MB', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const bigContent = JSON.stringify({ blob: 'x'.repeat(2_000_000) });
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'Plan done',
            content_json: bigContent,
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.ok(row.content_json.length < bigContent.length, 'content_json should be truncated');
        db.close();
    });
    // Slim contract — audit is event-only. `kind` and `is_truncated` are gone
    // from the schema; the audit_log handler must not surface them on output
    // rows. Verify both via PRAGMA + the returned row shape.
    it('audit table has no kind or is_truncated columns after the slim cleanup', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'slim event',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.kind, undefined, 'returned audit row must not expose a `kind` field');
        assert.equal(row.is_truncated, undefined, 'returned audit row must not expose `is_truncated`');
        const colInfo = db.all(`PRAGMA table_info(audit)`);
        const present = new Set(colInfo.map((c) => c.name));
        assert.ok(!present.has('kind'), 'audit.kind must be dropped from the schema');
        assert.ok(!present.has('is_truncated'), 'audit.is_truncated must be dropped from the schema');
        db.close();
    });
});
describe('validationTools', () => {
    it('validation_record rejects invalid verdict', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 1,
            attempt_n: 1,
            verdict: 'maybe',
            feedback: '# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('Invalid verdict'), `Error should mention invalid verdict: ${data.error}`);
        db.close();
    });
    it('validation_record rejects non-integer task_id', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 'task_abc',
            attempt_n: 1,
            verdict: 'fail',
            feedback: '# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('task_id must be a positive integer'), `Error should mention task_id validation: ${data.error}`);
        db.close();
    });
    it('validation_record rejects task_id that does not exist', async () => {
        const db = tempDB();
        const tools = validationTools(db);
        const result = await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: 9999,
            attempt_n: 1,
            verdict: 'pass',
            feedback: 'MCP available: yes\n# Notes',
            subagent_session_id: 'test-session-abc',
        });
        assert.ok(result.isError);
        const data = parseResult(result);
        assert.ok(data.error.includes('not found in tasks table'), `Error should cite missing task row: ${data.error}`);
        db.close();
    });
    it('validation_history returns attempts in ascending order', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        const taskId = await createTask(db, issueId);
        const tools = validationTools(db);
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 3,
            verdict: 'fail',
            feedback: 'MCP available: yes\n# Third attempt',
            subagent_session_id: 'session-3',
        });
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 1,
            verdict: 'fail',
            feedback: 'MCP available: yes\n# First attempt',
            subagent_session_id: 'session-1',
        });
        await call(tools.handlers, 'validation_record', {
            agent: 'pr-reviewer',
            task_id: taskId,
            attempt_n: 2,
            verdict: 'pass',
            feedback: 'MCP available: yes\n# Second attempt',
            subagent_session_id: 'session-2',
        });
        const result = await call(tools.handlers, 'validation_history', {
            agent: 'bro',
            task_id: taskId,
        });
        const rows = parseResult(result);
        assert.ok(!result.isError);
        assert.equal(rows.length, 3);
        assert.equal(rows[0].attempt_n, 1);
        assert.equal(rows[1].attempt_n, 2);
        assert.equal(rows[2].attempt_n, 3);
        db.close();
    });
});
describe('skillTools', () => {
    it('skill_register then skill_record_outcome updates effectiveness', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_record_outcome', {
            agent: 'bro',
            name: 'my-skill',
            success: true,
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.uses, 1);
        assert.equal(row.successes, 1);
        assert.equal(row.effectiveness, 1.0);
        db.close();
    });
    it('skill_promote rejects invalid transition', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-skill',
            from_status: 'draft',
            to_status: 'active',
        });
        assert.ok(result.isError, 'Expected error result');
        const data = parseResult(result);
        assert.ok(data.error.includes('Invalid transition'), `Error should mention invalid transition: ${data.error}`);
        db.close();
    });
    it('skill_promote accepts draft→pending_review', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-skill',
            description: 'A test skill',
            file_path: 'skills/my-skill.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-skill',
            from_status: 'draft',
            to_status: 'pending_review',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.status, 'pending_review');
        db.close();
    });
    it('skill_promote rejects when skill is not in from_status (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-promote-guard-skill',
            description: 'Promote guard test',
            file_path: 'skills/promote-guard.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-promote-guard-skill',
            from_status: 'pending_review',
            to_status: 'active',
        });
        assert.ok(result.isError, 'Expected error when from_status does not match actual status');
        const data = parseResult(result);
        assert.match(data.error, /from_status must match/, `Error must mention from_status mismatch: ${data.error}`);
        db.close();
    });
    it('skill_promote rejects tier transition when trust_tier does not match from (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-tier-guard-skill',
            description: 'Tier guard test',
            file_path: 'skills/tier-guard.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-tier-guard-skill',
            from_status: 'curated',
            to_status: 'agent',
        });
        assert.ok(result.isError, 'Expected error when from_status does not match actual trust_tier');
        const data = parseResult(result);
        assert.match(data.error, /Invalid transition/, `Error must be invalid transition (curated→agent not in table): ${data.error}`);
        db.close();
    });
    it('skill_promote accepts agent→curated tier transition when trust_tier matches (#364)', async () => {
        const db = tempDB();
        const tools = skillTools(db);
        await call(tools.handlers, 'skill_register', {
            agent: 'bro',
            name: 'my-tier-upgrade-skill',
            description: 'Tier upgrade test',
            file_path: 'skills/tier-upgrade.md',
            trust_tier: 'agent',
        });
        const result = await call(tools.handlers, 'skill_promote', {
            agent: 'bro',
            name: 'my-tier-upgrade-skill',
            from_status: 'agent',
            to_status: 'curated',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.trust_tier, 'curated');
        db.close();
    });
});
describe('reportTools', () => {
    it('issue_report_md renders sections when an issue has tasks and audit events', async () => {
        const db = tempDB();
        const issueId = await createIssue(db);
        await createTask(db, issueId);
        const audit = auditTools(db);
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'swe',
            event_type: 'task_started',
            summary: 'SWE began work',
        });
        const tools = reportTools(db);
        const result = await call(tools.handlers, 'issue_report_md', {
            agent: 'bro',
            issue_id: String(issueId),
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.ok(typeof data.markdown === 'string', 'Expected markdown string');
        assert.ok(data.markdown.includes('## Objective + Status'), 'Missing Objective section');
        assert.ok(data.markdown.includes('## Tasks'), 'Missing Tasks section');
        assert.ok(data.markdown.includes('## Validation History'), 'Missing Validation History section');
        assert.ok(data.markdown.includes('## Audit Event Timeline'), 'Missing Audit Event Timeline section');
        assert.ok(data.markdown.includes('## Skill Usage Summary'), 'Missing Skill Usage section');
        assert.ok(data.markdown.includes('SWE began work'), 'Audit event missing from report');
        db.close();
    });
});
//# sourceMappingURL=remaining_tools.test.js.map