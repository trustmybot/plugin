import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { auditTools } from '../tools/audit.js';
import { validationTools } from '../tools/validation.js';
import { skillTools } from '../tools/skills.js';
import { reportTools } from '../tools/reports.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';

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

async function createIssue(db: ReturnType<typeof tempDB>): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    agent: 'bro',
    objective: 'Test issue',
  });
  return parseResult(result).id as number;
}

async function createTask(
  db: ReturnType<typeof tempDB>,
  issueId: number,
  branchId = 'feat/test-task',
): Promise<number> {
  const tools = taskTools(db);
  const result = await call(tools.handlers, 'task_create_batch', {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_triage_gate: true, waive_triage_gate_reason: 'unit-test synthetic triage; not under test',
    agent: 'bro',
    issue_id: String(issueId),
    tasks: [
      {
        branch_id: branchId,
        description: 'Test task',
        success_criteria: 'Done',
      },
    ],
  });
  const rows = parseResult(result);
  return rows[0].id as number;
}

describe('auditTools', () => {
  // The kind='tool_call' branch was retired in #179 (always-empty in
  // production data; tool-call records live in debug_trajectory). The
  // tests below verify the current event-only contract: small + large
  // content_json payloads, plus that tool_call calls are rejected.

  it('audit_log kind=event stores small content_json intact', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'planning_complete',
      summary: 'Plan done',
      content_json: JSON.stringify({ cmd: 'echo hi' }),
    });

    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.issue_id, issueId);
    assert.equal(row.kind, 'event');
    assert.equal(row.event_type, 'planning_complete');
    assert.equal(row.is_truncated, 0);
    assert.equal(row.content_json, JSON.stringify({ cmd: 'echo hi' }));

    db.close();
  });

  it('audit_log kind=event truncates content_json > 1 MB and sets is_truncated = 1', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const bigContent = JSON.stringify({ blob: 'x'.repeat(2_000_000) });

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'planning_complete',
      summary: 'Plan done',
      content_json: bigContent,
    });

    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.is_truncated, 1);
    assert.ok(row.content_json.length < bigContent.length, 'content_json should be truncated');

    db.close();
  });

  it('audit_log rejects kind=tool_call (retired in #179)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'executor',
      kind: 'tool_call',
      tool_name: 'bash',
    });

    assert.ok(result.isError, 'Expected error for retired kind=tool_call');
    const data = parseResult(result);
    assert.match(data.error, /tool_call/i);

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
    assert.ok(
      data.error.includes('task_id must be a positive integer'),
      `Error should mention task_id validation: ${data.error}`,
    );

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
    assert.ok(
      data.error.includes('not found in tasks table'),
      `Error should cite missing task row: ${data.error}`,
    );

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
      created_by: 'swe',
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
      created_by: 'swe',
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
      created_by: 'swe',
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
      kind: 'event',
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
