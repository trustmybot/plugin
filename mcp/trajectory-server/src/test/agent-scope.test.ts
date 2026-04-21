import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgent,
  redactIssue,
  redactValidationRow,
} from '../middleware/agent-scope.js';
import type { Issue } from '../types.js';
import type { ValidationAttempt } from '../middleware/agent-scope.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    parent_issue_id: null,
    objective: 'A'.repeat(200),
    goals_md: 'SECRET GOALS',
    goals_md_hash: 'abc',
    pre_commit_hash: 'sha123',
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
    task_id: 'task-123',
    attempt_n: 1,
    agent: 'architect',
    verdict: 'pass',
    feedback_md: 'SENSITIVE FEEDBACK',
    reviewer_verdict: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('agent-scope middleware', () => {
  it('normalizeAgent maps known names correctly', () => {
    assert.equal(normalizeAgent('secretary'), 'secretary');
    assert.equal(normalizeAgent('architect'), 'architect');
    assert.equal(normalizeAgent('swe'), 'swe');
    assert.equal(normalizeAgent('pr-reviewer'), 'pr-reviewer');
    assert.equal(normalizeAgent('prompt-engineer'), 'prompt-engineer');
  });

  it('normalizeAgent falls back to unknown for unknown input', () => {
    assert.equal(normalizeAgent('hacker'), 'unknown');
    assert.equal(normalizeAgent(''), 'unknown');
    assert.equal(normalizeAgent(undefined), 'unknown');
    assert.equal(normalizeAgent('SWE'), 'swe');
  });

  it('redactIssue drops goals_md for swe', () => {
    const issue = makeIssue();
    const result = redactIssue(issue, 'swe');
    assert.ok(!('goals_md' in result), 'goals_md should be absent for swe');
  });

  it('redactIssue truncates objective to 120 chars for swe', () => {
    const issue = makeIssue({ objective: 'A'.repeat(200) });
    const result = redactIssue(issue, 'swe');
    assert.equal(result.objective?.length, 123, 'should be 120 + 3 ellipsis chars');
    assert.ok(result.objective?.endsWith('...'));
  });

  it('redactIssue returns full record for architect', () => {
    const issue = makeIssue();
    const result = redactIssue(issue, 'architect', { include_goals: true });
    assert.equal(result.goals_md, 'SECRET GOALS');
    assert.equal(result.objective, issue.objective);
  });

  it('redactValidationRow drops feedback_md for swe on another task', () => {
    const row = makeValidationRow({ task_id: 'task-other' });
    const result = redactValidationRow(row, 'swe', { own_task_id: 'task-mine' });
    assert.ok(!('feedback_md' in result), 'feedback_md should be dropped');
  });

  it('redactValidationRow keeps feedback_md for swe on own task', () => {
    const row = makeValidationRow({ task_id: 'task-mine' });
    const result = redactValidationRow(row, 'swe', { own_task_id: 'task-mine' });
    assert.equal(result.feedback_md, 'SENSITIVE FEEDBACK');
  });
});
