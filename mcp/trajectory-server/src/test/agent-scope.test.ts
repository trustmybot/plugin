import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgent,
  redactIssue,
  redactValidationRow,
  requireRoles,
} from '../middleware/agent-scope.js';
import type { Issue } from '../types.js';
import type { ValidationAttempt, AgentRole } from '../middleware/agent-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    parent_issue_id: null,
    objective: 'A'.repeat(200),
    description: 'SECRET DESCRIPTION',
    pre_commit_hash: 'sha123',
    post_commit_hash: null,
    status: 'open',
    current_task_id: null,
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

    const wrapped = requireRoles('identity_set', ['bro'], passthrough);
    const result = await wrapped({ agent: 'swe' });

    assert.ok(result.isError, 'Expected isError=true');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'swe');
    assert.deepEqual(payload.allowed_roles, ['bro']);
  });

  it('requireRoles delegates to handler when caller role is allowed', async () => {
    let called = false;
    const passthrough = async (_args: Record<string, unknown>): Promise<CallToolResult> => {
      called = true;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };

    const wrapped = requireRoles('identity_set', ['bro'], passthrough);
    const result = await wrapped({ agent: 'bro' });

    assert.ok(!result.isError, 'Expected no error');
    assert.ok(called, 'Expected underlying handler to be invoked');
  });

});
