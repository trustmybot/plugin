import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAgent,
  redactIssue,
  redactValidationRow,
  requireAgent,
  requireRoles,
} from '../middleware/agent-scope.js';
import { registerTools, toolHandlers } from '../tools/index.js';
import { GraphHolder } from '../graph.js';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import type { Issue } from '../types.js';
import type { ValidationAttempt, AgentRole } from '../middleware/agent-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    objective: 'A'.repeat(200),
    description: 'SECRET DESCRIPTION',
    status: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function makeValidationRow(overrides: Partial<ValidationAttempt> = {}): ValidationAttempt {
  return {
    id: 1,
    task_id: 123,
    attempt_n: 1,
    agent: 'bro',
    verdict: 'pass',
    feedback: 'SENSITIVE FEEDBACK',
    mcp_available: 1,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('agent-scope middleware', () => {
  it('normalizeAgent maps first-class names correctly', () => {
    assert.equal(normalizeAgent('bro'), 'bro');
    assert.equal(normalizeAgent('swe'), 'swe');
    assert.equal(normalizeAgent('pr-reviewer'), 'pr-reviewer');
  });

  it('normalizeAgent maps architect and other well-formed names to consultant', () => {
    assert.equal(normalizeAgent('architect'), 'consultant');
    assert.equal(normalizeAgent('cto'), 'consultant');
    assert.equal(normalizeAgent('legal-reviewer'), 'consultant');
    assert.equal(normalizeAgent('security-reviewer'), 'consultant');
  });

  it('normalizeAgent falls back to unknown for malformed input', () => {
    assert.equal(normalizeAgent('!!!'), 'unknown');
    assert.equal(normalizeAgent(''), 'unknown');
    assert.equal(normalizeAgent(undefined), 'unknown');
    assert.equal(normalizeAgent('SWE'), 'swe');
  });

  it('normalizeAgent strips a leading tmb: namespace, case-insensitively', () => {
    assert.equal(normalizeAgent('tmb:swe'), 'swe');
    assert.equal(normalizeAgent('TMB:Pr-Reviewer'), 'pr-reviewer');
    assert.equal(normalizeAgent('tmb:bro'), 'bro');
    assert.equal(normalizeAgent('tmb:pm'), 'consultant');
    assert.equal(normalizeAgent('tmb:'), 'unknown');
    assert.equal(normalizeAgent('tmb:tmb:swe'), 'unknown');
  });

  it('normalizeAgent treats a non-string agent as unknown', () => {
    assert.equal(normalizeAgent(42), 'unknown');
    assert.equal(normalizeAgent(null), 'unknown');
  });

  it('redactIssue drops description for swe', () => {
    const issue = makeIssue();
    const result = redactIssue(issue, 'swe');
    assert.ok(!('description' in result), 'description should be absent for swe');
  });

  it('redactIssue truncates objective to 120 chars for swe', () => {
    const issue = makeIssue({ objective: 'A'.repeat(200) });
    const result = redactIssue(issue, 'swe');
    assert.equal(result.objective?.length, 123, 'should be 120 + 3 ellipsis chars');
    assert.ok(result.objective?.endsWith('...'));
  });

  it('redactIssue returns full record for consultant (formerly architect)', () => {
    const issue = makeIssue();
    const result = redactIssue(issue, 'consultant', { include_description: true });
    assert.equal(result.description, 'SECRET DESCRIPTION');
    assert.equal(result.objective, issue.objective);
  });

  it('redactValidationRow drops feedback for swe on another task', () => {
    const row = makeValidationRow({ task_id: 999 });
    const result = redactValidationRow(row, 'swe', { own_task_id: 42 });
    assert.ok(!('feedback' in result), 'feedback should be dropped');
  });

  it('redactValidationRow keeps feedback for swe on own task', () => {
    const row = makeValidationRow({ task_id: 42 });
    const result = redactValidationRow(row, 'swe', { own_task_id: 42 });
    assert.equal(result.feedback, 'SENSITIVE FEEDBACK');
  });

  it('normalizeAgent bro returns bro', () => {
    assert.equal(normalizeAgent('bro'), 'bro');
  });

  it('normalizeAgent Bro (mixed-case) returns bro', () => {
    assert.equal(normalizeAgent('Bro'), 'bro');
  });

  it('normalizeAgent undefined returns unknown', () => {
    assert.equal(normalizeAgent(undefined), 'unknown');
  });

  it('requireRoles returns forbidden when caller role is not allowed', async () => {
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    const wrapped = requireRoles('task_create_batch', ['bro'], passthrough);
    const result = await wrapped({ agent: 'swe' });

    assert.ok(result.isError, 'Expected isError=true');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'swe');
    assert.deepEqual(payload.allowed_roles, ['bro']);
  });

  it('requireRoles with a known disallowed role omits the missing-agent diagnostics', async () => {
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    const wrapped = requireRoles('task_create_batch', ['bro'], passthrough);
    const result = await wrapped({ agent: 'swe' });

    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.deepEqual(payload, {
      error: 'forbidden',
      tool: 'task_create_batch',
      caller_role: 'swe',
      allowed_roles: ['bro'],
    });
    assert.equal('reason' in payload, false);
    assert.equal('agent_received' in payload, false);
    assert.equal('valid_agents' in payload, false);
    assert.equal('message' in payload, false);
  });

  it('requireRoles reports a missing agent as a missing argument, not a role restriction', async () => {
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    const wrapped = requireRoles('x', ['bro'], passthrough);
    const result = await wrapped({});

    assert.ok(result.isError, 'Expected isError=true');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.deepEqual(Object.keys(payload).slice(0, 4), [
      'error',
      'tool',
      'caller_role',
      'allowed_roles',
    ]);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.tool, 'x');
    assert.equal(payload.caller_role, 'unknown');
    assert.deepEqual(payload.allowed_roles, ['bro']);
    assert.equal(payload.reason, 'agent_missing_or_invalid');
    assert.equal(payload.agent_received, null);
    for (const name of ['bro', 'swe', 'pr-reviewer']) {
      assert.ok(payload.valid_agents.includes(name), `valid_agents missing ${name}`);
    }
    assert.ok(
      payload.valid_agents.some((v: string) => v.includes('consultant')),
      'valid_agents missing a consultant-slug entry',
    );
    assert.equal(typeof payload.message, 'string');
    assert.match(payload.message, /agent/);
    assert.match(payload.message, /missing/);
    assert.match(payload.message, /not a role restriction/);
    assert.match(payload.message, /received: null/);
  });

  it('requireRoles reports an invalid agent value and echoes it', async () => {
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    const wrapped = requireRoles('x', ['bro'], passthrough);
    const result = await wrapped({ agent: '!!!' });

    assert.ok(result.isError, 'Expected isError=true');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'unknown');
    assert.deepEqual(payload.allowed_roles, ['bro']);
    assert.equal(payload.reason, 'agent_missing_or_invalid');
    assert.equal(payload.agent_received, '!!!');
    assert.ok(payload.valid_agents.includes('bro'));
    assert.ok(payload.message.includes('"!!!"'), 'message should echo the received value');
    assert.match(payload.message, /not a role restriction/);
    assert.match(payload.message, /x accepts: bro/);
  });

  it('requireRoles delegates to handler when caller role is allowed', async () => {
    let called = false;
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => {
      called = true;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };

    const wrapped = requireRoles('task_create_batch', ['bro'], passthrough);
    const result = await wrapped({ agent: 'bro' });

    assert.ok(!result.isError, 'Expected no error');
    assert.ok(called, 'Expected underlying handler to be invoked');
  });

});

describe('requireAgent', () => {
  const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
  });
  const payloadOf = (r: CallToolResult) =>
    JSON.parse((r.content[0] as { type: string; text: string }).text);

  it('rejects a missing agent with the agent_missing_or_invalid diagnostics', async () => {
    const result = await requireAgent('issue_list', passthrough)({});
    assert.ok(result.isError);
    const payload = payloadOf(result);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'unknown');
    assert.equal(payload.reason, 'agent_missing_or_invalid');
    assert.equal(payload.agent_received, null);
    assert.deepEqual(payload.allowed_roles, ['bro', 'swe', 'pr-reviewer', 'consultant']);
  });

  it('rejects an invalid agent and names the gated tool roles', async () => {
    const gated = requireRoles('issue_close', ['bro'], passthrough);
    const payload = payloadOf(await requireAgent('issue_close', gated)({ agent: '!!!' }));
    assert.equal(payload.reason, 'agent_missing_or_invalid');
    assert.equal(payload.agent_received, '!!!');
    assert.deepEqual(payload.allowed_roles, ['bro']);
  });

  it('passes any recognised caller through to the handler', async () => {
    for (const agent of ['bro', 'swe', 'pr-reviewer', 'pm', 'tmb:swe']) {
      const result = await requireAgent('issue_list', passthrough)({ agent });
      assert.ok(!result.isError, `${agent} should pass`);
    }
  });
});

describe('registered tools: consultants on read tools, missing agent everywhere', () => {
  let dir: string;
  let db: TrajectoryDB;
  let issueId: number;
  let taskId: number;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-role-gates-'));
    mkdirSync(join(dir, '.claude', 'tmb'), { recursive: true });
    db = tempDB({ path: join(dir, '.claude', 'tmb', 'trajectory.db') });
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [join(dir, 'app')]);
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at)
       VALUES ('role gates', 'd', 'open', datetime('now'), datetime('now'))`,
    );
    issueId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
       VALUES (?, 'fix/role-gates', 't', 'd', 'running', '## Description', 'app', datetime('now'), datetime('now'))`,
      [issueId],
    );
    taskId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    registerTools({} as never, db, db.dbPath, GraphHolder.fixed(null));
  });

  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const callTool = (name: string, args: Record<string, unknown>) => toolHandlers[name]!(args);
  const payloadOf = (r: CallToolResult) =>
    JSON.parse((r.content[0] as { type: string; text: string }).text);

  it('a consultant succeeds on every read-only tool', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['world_model_get', { repo: 'app' }],
      ['world_model_search', { repo: 'app', query: 'parser' }],
      ['repos_list', {}],
      ['task_brief', { task_id: taskId }],
      ['issue_snapshot_md', { issue_id: String(issueId) }],
    ];
    for (const [name, args] of calls) {
      const result = await callTool(name, { agent: 'pm', ...args });
      assert.ok(!result.isError, `${name} should admit pm; got ${JSON.stringify(result.content)}`);
    }
  });

  it('a tmb:-prefixed consultant passes the same gates', async () => {
    const result = await callTool('repos_list', { agent: 'tmb:pm' });
    assert.ok(!result.isError, JSON.stringify(result.content));
  });

  it('a consultant is still forbidden on a write tool', async () => {
    const result = await callTool('task_update_status', { agent: 'pm', task_id: String(taskId), status: 'completed' });
    assert.ok(result.isError);
    const payload = payloadOf(result);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'consultant');
    assert.deepEqual(payload.allowed_roles, ['bro', 'swe']);
  });

  it('an ungated tool rejects a call with no agent', async () => {
    const result = await callTool('issue_list', {});
    assert.ok(result.isError);
    const payload = payloadOf(result);
    assert.equal(payload.reason, 'agent_missing_or_invalid');
    assert.equal(payload.tool, 'issue_list');
  });

  it('every registered tool rejects a call with no agent', async () => {
    const accepted: string[] = [];
    for (const [name, handler] of Object.entries(toolHandlers)) {
      const result = await handler({});
      if (!result.isError || payloadOf(result).reason !== 'agent_missing_or_invalid') accepted.push(name);
    }
    assert.deepEqual(accepted, []);
  });
});
