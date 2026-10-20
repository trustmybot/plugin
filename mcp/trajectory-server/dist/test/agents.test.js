import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const PLUGIN_ROOT = (() => {
    const env = process.env['CLAUDE_PLUGIN_ROOT'];
    if (env && existsSync(join(env, '.claude-plugin', 'plugin.json')))
        return env;
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, '.claude-plugin', 'plugin.json')))
        dir = dirname(dir);
    return dir;
})();
describe('agentTools', () => {
    it('fresh DB has 6 seeded agents, every file_path under the plugin: root', () => {
        const db = tempDB();
        const rows = db.all('SELECT name, file_path FROM agents ORDER BY id');
        assert.equal(rows.length, 6, 'Expected 6 seeded agents');
        assert.deepEqual(rows.map((r) => r.file_path), [
            'plugin:agents/swe.md',
            'plugin:agents/pr-reviewer.md',
            'plugin:templates/agents/architect.md',
            'plugin:templates/agents/cto.md',
            'plugin:templates/agents/ceo.md',
            'plugin:templates/agents/pm.md',
        ]);
        db.close();
    });
    it('the file_path CHECK rejects an unmarked path', () => {
        const db = tempDB();
        assert.throws(() => db.run(`INSERT INTO agents (name, kind, file_path) VALUES ('x-ray', 'consultant', '.claude/agents/x-ray.md')`), /CHECK/);
        db.close();
    });
    it('agent_list returns all 6 seeded agents with resolved_path and no scope key', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_list', { agent: 'bro' });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.agents.length, 6, 'Expected 6 agents');
        for (const a of data.agents) {
            assert.ok(!('scope' in a), 'agent rows carry no scope key');
            assert.equal(a.resolved_path, join(PLUGIN_ROOT, a.file_path.slice('plugin:'.length)));
        }
        assert.ok(existsSync(data.agents.find((a) => a.name === 'swe').resolved_path), 'swe resolves to a real file');
        db.close();
    });
    it('agent_list(root=…) filters by the file_path root', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        await call(tools.handlers, 'agent_register', {
            agent: 'bro', name: 'legal-reviewer', kind: 'consultant', file_path: 'project:.claude/agents/legal-reviewer.md',
        });
        const plugin = parseResult(await call(tools.handlers, 'agent_list', { agent: 'bro', root: 'plugin' }));
        assert.deepEqual(plugin.agents.map((a) => a.name), ['architect', 'ceo', 'cto', 'pm', 'pr-reviewer', 'swe']);
        const project = parseResult(await call(tools.handlers, 'agent_list', { agent: 'bro', root: 'project' }));
        assert.equal(project.agents.length, 1);
        assert.equal(project.agents[0].name, 'legal-reviewer');
        assert.equal(project.agents[0].resolved_path, '/tmp/workspace/.claude/agents/legal-reviewer.md');
        const bad = await call(tools.handlers, 'agent_list', { agent: 'bro', root: 'global' });
        assert.ok(bad.isError);
        assert.match(parseResult(bad).error, /Invalid root/);
        db.close();
    });
    it('agent_register inserts a project: row and returns its resolved_path', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            file_path: 'project:.claude/agents/legal-reviewer.md',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.name, 'legal-reviewer');
        assert.equal(row.kind, 'consultant');
        assert.ok(!('scope' in row));
        assert.equal(row.file_path, 'project:.claude/agents/legal-reviewer.md');
        assert.equal(row.resolved_path, '/tmp/workspace/.claude/agents/legal-reviewer.md');
        const count = db.get('SELECT COUNT(*) AS cnt FROM agents');
        assert.equal(count.cnt, 7, 'Expected 7 agents after registering one');
        db.close();
    });
    it('agent_register rejects a file_path without a root marker, naming both accepted forms', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            file_path: '.claude/agents/legal-reviewer.md',
        });
        assert.ok(result.isError);
        const error = parseResult(result).error;
        assert.match(error, /^invalid_file_path:/);
        assert.match(error, /'plugin:<path under the plugin root>'/);
        assert.match(error, /'project:<path under the workspace root>'/);
        db.close();
    });
    it('agent_register promotes a plugin: consultant row to its project: file_path', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'cto',
            kind: 'consultant',
            file_path: 'project:.claude/agents/cto.md',
        });
        const row = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
        assert.equal(row.file_path, 'project:.claude/agents/cto.md', 'Promoted row must carry the project: file_path');
        const count = db.get('SELECT COUNT(*) AS cnt FROM agents');
        assert.equal(count.cnt, 6, 'Row count must not grow on promotion');
        db.close();
    });
    it('agent_register promotion emits exactly one tmb_agent_created audit; repeat call emits none', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const args = { agent: 'bro', name: 'cto', kind: 'consultant', file_path: 'project:.claude/agents/cto.md' };
        await call(tools.handlers, 'agent_register', args);
        const afterFirst = db.get("SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'");
        assert.equal(afterFirst.cnt, 1, 'Promotion must emit exactly one tmb_agent_created audit');
        await call(tools.handlers, 'agent_register', args);
        const afterSecond = db.get("SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'");
        assert.equal(afterSecond.cnt, 1, 'Repeat call on an already-project: row must not emit a duplicate audit');
        db.close();
    });
    it('agent_register emits tmb_agent_created audit row for a new project: consultant', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'legal-reviewer',
            kind: 'consultant',
            file_path: 'project:.claude/agents/legal-reviewer.md',
        });
        const auditRow = db.get("SELECT event_type, summary FROM audit WHERE event_type = 'tmb_agent_created' LIMIT 1");
        assert.ok(auditRow !== undefined, 'tmb_agent_created audit row must be written by agent_register');
        assert.equal(auditRow.event_type, 'tmb_agent_created');
        db.close();
    });
    it('agent_register does NOT emit audit row for idempotent re-registration', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const args = { agent: 'bro', name: 'legal-reviewer', kind: 'consultant', file_path: 'project:.claude/agents/legal-reviewer.md' };
        await call(tools.handlers, 'agent_register', args);
        await call(tools.handlers, 'agent_register', args);
        const auditCount = db.get("SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'");
        assert.equal(auditCount.cnt, 1, 'Only one tmb_agent_created row on idempotent re-register');
        db.close();
    });
});
describe('agent_register reserved name gate', () => {
    it("rejects 'bro' — permanently reserved orchestrator name", async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'bro',
            kind: 'consultant',
            file_path: 'project:.claude/agents/bro.md',
        });
        assert.ok(result.isError, 'Expected an error when registering bro');
        assert.match(parseResult(result).error, /reserved orchestrator name/);
        db.close();
    });
    for (const name of ['swe', 'pr-reviewer']) {
        it(`rejects a project: '${name}' — backbone agents must be plugin:`, async () => {
            const db = tempDB();
            const tools = agentTools(db);
            const result = await call(tools.handlers, 'agent_register', {
                agent: 'bro',
                name,
                kind: 'backbone',
                file_path: `project:.claude/agents/${name}.md`,
            });
            assert.ok(result.isError, `Expected an error for a project: ${name}`);
            const error = parseResult(result).error;
            assert.match(error, /backbone agent whose file_path must be plugin:/);
            assert.match(error, /would shadow the backbone and disable it/);
            assert.equal(db.get('SELECT file_path FROM agents WHERE name = ?', [name]).file_path, `plugin:agents/${name}.md`, 'the backbone row is untouched');
            db.close();
        });
    }
    it("allows a plugin: 'swe' — backbone registration at its own root", async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_register', {
            agent: 'bro',
            name: 'swe',
            kind: 'backbone',
            file_path: 'plugin:agents/swe.md',
        });
        assert.ok(!result.isError, `Expected no error for a plugin: swe: ${JSON.stringify(parseResult(result))}`);
        assert.equal(parseResult(result).resolved_path, join(PLUGIN_ROOT, 'agents', 'swe.md'));
        db.close();
    });
});
describe('audit_append requireRoles guard', () => {
    async function createIssueId(db) {
        const issues = issueTools(db);
        const result = await (issues.handlers['issue_create']({ agent: 'bro', objective: 'audit test', labels: ['Bug', 'Priority: High'] }));
        return JSON.parse(result.content[0].text).id;
    }
    it('audit_append accepts bro', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_append', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'planning_complete',
            summary: 'test summary',
        });
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
        db.close();
    });
    it('audit_append refuses swe and a consultant on a bro-only event', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        for (const agent of ['swe', 'architect']) {
            const result = await call(tools.handlers, 'audit_append', {
                agent,
                issue_id: String(issueId),
                event_type: 'planning_complete',
                summary: 'test summary',
            });
            assert.ok(result.isError, `Expected ${agent} to be refused`);
            assert.equal(parseResult(result).error, 'audit_event_not_writable_by_role');
        }
        db.close();
    });
    it('audit_append rejects unknown agent', async () => {
        const db = tempDB();
        const issueId = await createIssueId(db);
        const tools = auditTools(db);
        const result = await call(tools.handlers, 'audit_append', {
            agent: '!!!invalid!!!',
            issue_id: String(issueId),
            from_node: '!!!invalid!!!',
            event_type: 'planning_complete',
            summary: 'test summary',
        });
        assert.ok(result.isError, 'Expected isError=true for unknown agent');
        const data = parseResult(result);
        assert.equal(data.error, 'forbidden');
        db.close();
    });
});
describe('agent_resolve', () => {
    it('Branch A — collision: returns mode=collision when the project: file already exists', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'tmb-resolve-a-'));
        try {
            const agentsDir = join(tmp, '.claude', 'agents');
            mkdirSync(agentsDir, { recursive: true });
            writeFileSync(join(agentsDir, 'legal-reviewer.md'), '# legal-reviewer\n');
            const dbPath = join(tmp, '.claude', 'tmb', 'trajectory.db');
            const db = tempDB();
            const tools = agentTools(db, dbPath);
            const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'legal-reviewer' });
            const data = parseResult(result);
            assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
            assert.equal(data.mode, 'collision');
            assert.equal(data.file_path, 'project:.claude/agents/legal-reviewer.md');
            assert.equal(data.resolved_path, join(agentsDir, 'legal-reviewer.md'));
            db.close();
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    it('Branch B — template-copy: returns mode=template-copy for a known template name', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'architect' });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.mode, 'template-copy');
        assert.equal(data.source_path, join(PLUGIN_ROOT, 'templates', 'agents', 'architect.md'));
        assert.equal(data.file_path, 'project:.claude/agents/architect.md');
        assert.equal(data.resolved_path, '/tmp/workspace/.claude/agents/architect.md');
        db.close();
    });
    it('Branch C — from-scratch: returns mode=from-scratch for an unknown name', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'novel-consultant' });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.mode, 'from-scratch');
        assert.equal(data.scaffold_path, join(PLUGIN_ROOT, 'templates', 'agents', 'template.md'));
        assert.equal(data.file_path, 'project:.claude/agents/novel-consultant.md');
        assert.equal(data.resolved_path, '/tmp/workspace/.claude/agents/novel-consultant.md');
        db.close();
    });
    it('resolves a plugin: file_path against the plugin root', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'agent_resolve', {
            agent: 'bro', name: 'architect', file_path: 'plugin:templates/agents/architect.md',
        });
        const data = parseResult(result);
        assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
        assert.equal(data.mode, 'collision', 'the plugin template already exists at that path');
        assert.equal(data.file_path, 'plugin:templates/agents/architect.md');
        assert.equal(data.resolved_path, join(PLUGIN_ROOT, 'templates', 'agents', 'architect.md'));
        db.close();
    });
    it('rejects an unmarked file_path', async () => {
        const db = tempDB();
        const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'agent_resolve', {
            agent: 'bro', name: 'legal-reviewer', file_path: '.claude/agents/legal-reviewer.md',
        });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /^invalid_file_path:/);
        db.close();
    });
    it('rejects reserved name "bro"', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'bro' });
        assert.ok(result.isError, 'Expected isError=true for reserved name');
        assert.match(parseResult(result).error, /reserved orchestrator name/);
        db.close();
    });
    it('rejects backbone name "swe"', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'swe' });
        assert.ok(result.isError, 'Expected isError=true for backbone name');
        assert.match(parseResult(result).error, /backbone agent whose file_path must be plugin:/);
        db.close();
    });
    it('rejects invalid kebab-case name', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'Invalid_Name' });
        assert.ok(result.isError, 'Expected isError=true for invalid name');
        assert.match(parseResult(result).error, /kebab-case/);
        db.close();
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const tools = agentTools(db);
        const result = await call(tools.handlers, 'agent_resolve', { agent: 'swe', name: 'legal-reviewer' });
        assert.ok(result.isError, 'Expected isError=true for non-bro caller');
        assert.equal(parseResult(result).error, 'forbidden');
        db.close();
    });
});
//# sourceMappingURL=agents.test.js.map