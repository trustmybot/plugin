import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { agentTools } from '../tools/agents.js';
import { auditTools } from '../tools/audit.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  return (await handlers[name]!(args)) as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

describe('agentTools', () => {
  it('fresh DB has 6 seeded agents after init', () => {
    const db = tempDB();
    const count = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM agents');
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
    const names = data.agents.map((a: { name: string }) => a.name).sort();
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

    const count = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM agents');
    assert.ok(count !== undefined);
    assert.equal(count.cnt, 7, 'Expected 7 agents after registering one project-local');
    db.close();
  });

  it('agent_register promotes template-seeded row to project-local and updates scope+file_path', async () => {
    const db = tempDB();
    const tools = agentTools(db);

    const result = await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'cto',
      kind: 'consultant',
      scope: 'project-local',
      file_path: '.claude/agents/cto.md',
    });
    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.scope, 'project-local', 'Promoted row must have scope=project-local');
    assert.equal(row.file_path, '.claude/agents/cto.md', 'Promoted row must have updated file_path');

    const count = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM agents');
    assert.ok(count !== undefined);
    assert.equal(count.cnt, 6, 'Row count must not grow on promotion');
    db.close();
  });

  it('agent_register promotion emits exactly one tmb_agent_created audit; repeat call emits none', async () => {
    const db = tempDB();
    const tools = agentTools(db);

    await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'cto',
      kind: 'consultant',
      scope: 'project-local',
      file_path: '.claude/agents/cto.md',
    });

    const afterFirst = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'",
    );
    assert.ok(afterFirst !== undefined);
    assert.equal(afterFirst.cnt, 1, 'Promotion must emit exactly one tmb_agent_created audit');

    await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'cto',
      kind: 'consultant',
      scope: 'project-local',
      file_path: '.claude/agents/cto.md',
    });

    const afterSecond = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'",
    );
    assert.ok(afterSecond !== undefined);
    assert.equal(afterSecond.cnt, 1, 'Repeat call on already-project-local must not emit duplicate audit');
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

    const auditRow = db.get<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM audit WHERE event_type = 'tmb_agent_created' LIMIT 1",
    );
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

    const auditCount = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM audit WHERE event_type = 'tmb_agent_created'",
    );
    assert.ok(auditCount !== undefined);
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
      scope: 'project-local',
      file_path: '.claude/agents/bro.md',
    });
    assert.ok(result.isError, 'Expected an error when registering bro');
    assert.match(parseResult(result).error, /reserved orchestrator name/);
    db.close();
  });

  it("rejects 'swe' at project-local scope — backbone scope mismatch", async () => {
    const db = tempDB();
    const tools = agentTools(db);

    const result = await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'swe',
      kind: 'backbone',
      scope: 'project-local',
      file_path: '.claude/agents/swe.md',
    });
    assert.ok(result.isError, "Expected an error for swe at project-local scope");
    assert.match(parseResult(result).error, /backbone agent whose scope must be 'global'/);
    db.close();
  });

  it("rejects 'pr-reviewer' at template scope — backbone scope mismatch", async () => {
    const db = tempDB();
    const tools = agentTools(db);

    const result = await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'pr-reviewer',
      kind: 'backbone',
      scope: 'template',
      file_path: '.claude/agents/pr-reviewer.md',
    });
    assert.ok(result.isError, "Expected an error for pr-reviewer at template scope");
    assert.match(parseResult(result).error, /backbone agent whose scope must be 'global'/);
    db.close();
  });

  it("allows 'swe' at global scope — backbone registration at correct scope", async () => {
    const db = tempDB();
    const tools = agentTools(db);

    const result = await call(tools.handlers, 'agent_register', {
      agent: 'bro',
      name: 'swe',
      kind: 'backbone',
      scope: 'global',
      file_path: '.claude/agents/swe.md',
    });
    assert.ok(!result.isError, `Expected no error for swe at global scope: ${JSON.stringify(parseResult(result))}`);
    db.close();
  });
});

describe('audit_log requireRoles guard', () => {
  async function createIssueId(db: ReturnType<typeof tempDB>): Promise<number> {
    const issues = issueTools(db);
    const result = await (issues.handlers['issue_create']!({ agent: 'bro', objective: 'audit test', labels: ['Bug', 'Priority: High'] })) as RawResult;
    return JSON.parse(result.content[0].text).id as number;
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

describe('agent_resolve', () => {
  it('Branch A — collision: returns mode=collision when workspace file already exists', async () => {
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
      assert.ok(typeof data.existing_path === 'string' && data.existing_path.startsWith('/'), 'existing_path must be absolute');
      assert.ok(data.existing_path.endsWith('legal-reviewer.md'), 'existing_path must end with the agent filename');
      db.close();
    } finally {
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
    assert.ok(typeof data.source_path === 'string' && data.source_path.startsWith('/'), 'source_path must be absolute');
    assert.ok(typeof data.target_path === 'string' && data.target_path.startsWith('/'), 'target_path must be absolute');
    assert.ok(data.source_path.endsWith('templates/agents/architect.md'), 'source_path must point to plugin template');
    assert.ok(data.target_path.endsWith('.claude/agents/architect.md'), 'target_path must point into workspace');
    db.close();
  });

  it('Branch C — from-scratch: returns mode=from-scratch for an unknown name', async () => {
    const db = tempDB();
    const tools = agentTools(db, '/tmp/workspace/.claude/tmb/trajectory.db');
    const result = await call(tools.handlers, 'agent_resolve', { agent: 'bro', name: 'novel-consultant' });
    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.equal(data.mode, 'from-scratch');
    assert.ok(typeof data.scaffold_path === 'string' && data.scaffold_path.startsWith('/'), 'scaffold_path must be absolute');
    assert.ok(typeof data.target_path === 'string' && data.target_path.startsWith('/'), 'target_path must be absolute');
    assert.ok(data.scaffold_path.endsWith('templates/agents/template.md'), 'scaffold_path must point to base template');
    assert.ok(data.target_path.endsWith('.claude/agents/novel-consultant.md'), 'target_path must point into workspace');
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
    assert.match(parseResult(result).error, /backbone agent/);
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
