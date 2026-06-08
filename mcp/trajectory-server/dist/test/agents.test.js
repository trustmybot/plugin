import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { agentTools } from '../tools/agents.js';
import { auditTools } from '../tools/audit.js';
import { issueTools } from '../tools/issues.js';
async function call(handlers, name, args) {
    return (await handlers[name](args));
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
describe('agentTools', () => {
    it('fresh DB has 6 seeded agents after init', () => {
        const db = tempDB();
        const count = db.get('SELECT COUNT(*) AS cnt FROM agents');
        assert.ok(count !== undefined);
        assert.equal(count.cnt, 6, 'Expected 6 seeded agents');
        db.close();
    });
    it('agent_list returns all 6 seeded agents', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_list', { agent: 'bro' });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.agents.length, 6, 'Expected 6 agents');
        db.close();
    });
    it('agent_list(scope=template) filters to 4 template agents', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_list', { agent: 'bro', scope: 'template' });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.agents.length, 4, 'Expected 4 template-scope agents');
        const names = data.agents.map((a) => a.name).sort();
        assert.deepEqual(names, ['architect', 'ceo', 'cto', 'pm']);
        db.close();
    });
    it('agent_register inserts a project-local row', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            scope: 'project-local',
            file_path: '.claude/agents/legal-reviewer.md',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.name, 'legal-reviewer');
        assert.equal(row.kind, 'consultant');
        assert.equal(row.scope, 'project-local');
        assert.equal(row.file_path, '.claude/agents/legal-reviewer.md');
        const count = db.get('SELECT COUNT(*) AS cnt FROM agents');
        assert.ok(count !== undefined);
        assert.equal(count.cnt, 7, 'Expected 7 agents after registering one project-local');
        db.close();
    });
    it('agent_register is idempotent — INSERT OR IGNORE returns existing row unchanged', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const first = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'architect',
            kind: 'consultant',
            scope: 'project-local',
            file_path: '.claude/agents/architect.md',
        });
        const firstRow = parseResult(first);
        assert.ok(!first.isError, `Expected no error: ${JSON.stringify(firstRow)}`);
        assert.equal(firstRow.scope, 'template', 'Existing row should not be overwritten');
        const count = db.get('SELECT COUNT(*) AS cnt FROM agents');
        assert.ok(count !== undefined);
        assert.equal(count.cnt, 6, 'Row count must not grow when INSERT OR IGNORE hits existing name');
        db.close();
    });
    it('agent_register emits tmb_agent_created audit row for new project-local consultant', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            scope: 'project-local',
            file_path: '.claude/agents/legal-reviewer.md',
        });
        const auditRow = db.get("SELECT event_type, summary FROM audit WHERE event_type = 'tmb_agent_created' LIMIT 1");
        assert.ok(auditRow !== undefined, 'tmb_agent_created audit row must be written by agent_register');
        assert.equal(auditRow.event_type, 'tmb_agent_created');
        db.close();
    });
    it('agent_register does NOT emit audit row for idempotent re-registration', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            scope: 'project-local',
            file_path: '.claude/agents/legal-reviewer.md',
        });
        await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            scope: 'project-local',
            file_path: '.claude/agents/legal-reviewer.md',
        });
        const auditCount = db.get("SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'");
        assert.ok(auditCount !== undefined);
        assert.equal(auditCount.cnt, 1, 'Only one tmb_agent_created row on idempotent re-register');
        db.close();
    });
});
describe('audit_log requireRoles guard', () => {
    async function createIssueId(db) {
        const issues = issueTools(db);
        const result = await (issues.handlers['issue_create']({ agent: 'bro', objective: 'audit test' }));
        return JSON.parse(result.content[0].text).id;
    }
    it('audit_log accepts bro', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'test_event',
            summary: 'test summary',
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        db.close();
    });
    it('audit_log accepts swe', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'swe',
            issue_id: String(issueId),
            from_node: 'swe',
            event_type: 'test_event',
            summary: 'test summary',
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        db.close();
    });
    it('audit_log accepts consultant', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: 'architect',
            issue_id: String(issueId),
            from_node: 'architect',
            event_type: 'test_event',
            summary: 'test summary',
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        db.close();
    });
    it('audit_log rejects unknown agent', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_log', {
            agent: '!!!invalid!!!',
            issue_id: String(issueId),
            from_node: '!!!invalid!!!',
            event_type: 'test_event',
            summary: 'test summary',
        });
        assert.ok(result.isError, 'Expected isError=true for unknown agent');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden');
        db.close();
    });
});
//# sourceMappingURL=agents.test.js.map