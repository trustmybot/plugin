import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
import { validationTools } from '../tools/validation.js';
import { reportTools } from '../tools/reports.js';
import { branchReportMdTools } from '../tools/branch_report_md.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

function parseBatch(result: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(result.content[0].text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
}

async function createIssue(db: ReturnType<typeof tempDB>): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    labels: ['Bug', 'Priority: High'],
    agent: 'bro',
    objective: 'Compaction test issue',
  });
  return parseResult(result).id as number;
}

async function createTask(
  db: ReturnType<typeof tempDB>,
  issueId: number,
  branchId = 'feat/compaction-test',
): Promise<number> {
  const tools = taskTools(db);
  const result = await call(tools.handlers, 'task_create_batch', {
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
    tasks: [{ branch_id: branchId, description: 'Compaction test task' }],
  });
  return parseBatch(result)[0]!.id as number;
}

describe('issue_get_with_discussions compact default (#210)', () => {
  it('compact default: returns counts + last N discussions (no include_full)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    for (let i = 0; i < 15; i++) {
      await call(disc.handlers, 'discussion_append', {
        agent: 'bro',
        issue_id: String(issueId),
        author: 'bro',
        kind: 'note',
        body: `Discussion entry ${i + 1}`,
      });
    }

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
      issue_id: String(issueId),
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.ok(data.issue, 'issue must be present');
    assert.ok(Array.isArray(data.discussions), 'discussions must be array');
    assert.equal(data.discussions.length, 10, 'compact default returns last 10');
    assert.equal(data.total_discussion_count, 15, 'total_discussion_count reflects all rows');
    assert.equal(data.returned_count, 10, 'returned_count matches discussions.length');
    assert.ok(Array.isArray(data.tasks), 'tasks must be present');

    // Verify we get the LAST 10 (most recent)
    const bodies: string[] = data.discussions.map((d: { body: string }) => d.body);
    assert.ok(bodies.includes('Discussion entry 15'), 'Last entry must be in compact result');
    assert.ok(!bodies.includes('Discussion entry 1'), 'First entry must NOT be in compact result');

    db.close();
  });

  it('compact default with last_n param', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    for (let i = 0; i < 8; i++) {
      await call(disc.handlers, 'discussion_append', {
        agent: 'bro',
        issue_id: String(issueId),
        author: 'bro',
        kind: 'note',
        body: `Entry ${i + 1}`,
      });
    }

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
      issue_id: String(issueId),
      last_n: 3,
    });

    const data = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(data.discussions.length, 3, 'last_n=3 returns 3 discussions');
    assert.equal(data.total_discussion_count, 8);

    db.close();
  });

  it('include_full=true returns all discussions (no count metadata required)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    for (let i = 0; i < 12; i++) {
      await call(disc.handlers, 'discussion_append', {
        agent: 'bro',
        issue_id: String(issueId),
        author: 'bro',
        kind: 'note',
        body: `Full entry ${i + 1}`,
      });
    }

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
      issue_id: String(issueId),
      include_full: true,
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.ok(Array.isArray(data.discussions), 'discussions must be array');
    assert.equal(data.discussions.length, 12, 'include_full returns all 12 discussions');
    assert.ok(Array.isArray(data.tasks), 'tasks must be present');
    assert.ok(data.issue, 'issue must be present');

    db.close();
  });

  it('compact default works correctly when fewer than last_n discussions exist', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    for (let i = 0; i < 4; i++) {
      await call(disc.handlers, 'discussion_append', {
        agent: 'bro',
        issue_id: String(issueId),
        author: 'bro',
        kind: 'note',
        body: `Short entry ${i + 1}`,
      });
    }

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
      issue_id: String(issueId),
    });

    const data = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(data.discussions.length, 4, 'all 4 returned when < last_n');
    assert.equal(data.total_discussion_count, 4);
    assert.equal(data.returned_count, 4);

    db.close();
  });

  it('swe redaction respected in compact mode', async () => {
    const db = tempDB();
    const issues = issueTools(db);
    const createResult = await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro',
      objective: 'Redaction compact test',
      description: 'SECRET: must be redacted from swe',
    });
    const issue = parseResult(createResult);
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'swe',
      issue_id: String(issue.id),
    });

    const data = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(!('description' in data.issue), 'swe must not see description in compact mode');

    db.close();
  });
});

describe('fields projection — discussion_list (#210)', () => {
  it('fields projection returns only requested columns', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: String(issueId),
      author: 'bro',
      kind: 'note',
      body: 'Projection test entry',
    });

    const result = await call(disc.handlers, 'discussion_list', {
      agent: 'bro',
      issue_id: String(issueId),
      fields: ['id', 'kind', 'author'],
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows), 'bare array when no limit');
    assert.ok(rows.length >= 1);
    const row = rows[0];
    assert.ok('id' in row, 'id must be present');
    assert.ok('kind' in row, 'kind must be present');
    assert.ok('author' in row, 'author must be present');
    assert.ok(!('body' in row), 'body must NOT be present when not in fields');
    assert.ok(!('created_at' in row), 'created_at must NOT be present when not in fields');

    db.close();
  });

  it('unknown field returns named error', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'discussion_list', {
      agent: 'bro',
      issue_id: String(issueId),
      fields: ['id', 'nonexistent_field'],
    });

    assert.ok(result.isError, 'Should be error for unknown field');
    const data = parseResult(result);
    assert.ok(data.error.includes('Unknown fields'), `Error must cite unknown fields: ${data.error}`);
    assert.ok(data.error.includes('nonexistent_field'), `Error must name the bad field: ${data.error}`);

    db.close();
  });
});

describe('fields projection — audit_list (#210)', () => {
  it('fields projection returns only requested columns', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_append', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      event_type: 'planning_complete',
      summary: 'Plan done',
    });

    const result = await call(audit.handlers, 'audit_list', {
      agent: 'bro',
      issue_id: String(issueId),
      fields: ['id', 'event_type', 'summary'],
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows), 'bare array preserved with fields projection');
    assert.ok(rows.length >= 1);
    const row = rows[0];
    assert.ok('id' in row, 'id must be present');
    assert.ok('event_type' in row, 'event_type must be present');
    assert.ok('summary' in row, 'summary must be present');
    assert.ok(!('content_json' in row), 'content_json must NOT be present');
    assert.ok(!('from_node' in row), 'from_node must NOT be present');

    db.close();
  });

  it('audit_list bare-array shape preserved when no fields projection', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_append', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      event_type: 'bro_verification_pass',
      summary: 'Verified',
    });

    const result = await call(audit.handlers, 'audit_list', {
      agent: 'bro',
      issue_id: String(issueId),
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows), 'default shape must be bare array (L4 compat)');
    assert.ok(rows.some((r: { event_type: string }) => r.event_type === 'bro_verification_pass'));

    db.close();
  });

  it('unknown field returns named error', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const audit = auditTools(db);

    const result = await call(audit.handlers, 'audit_list', {
      agent: 'bro',
      issue_id: String(issueId),
      fields: ['id', 'bad_field'],
    });

    assert.ok(result.isError, 'Should be error for unknown field');
    const data = parseResult(result);
    assert.ok(data.error.includes('Unknown fields'), `Error must cite unknown fields: ${data.error}`);
    assert.ok(data.error.includes('bad_field'), `Error must name the bad field: ${data.error}`);

    db.close();
  });
});

describe('fields projection — validation_history (#210)', () => {
  it('fields projection returns only requested columns', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const taskId = await createTask(db, issueId);
    const validation = validationTools(db);

    await call(validation.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: 'Looks good',
      mcp_available: true,
      subagent_session_id: 'test-session-proj',
    });

    const result = await call(validation.handlers, 'validation_history', {
      agent: 'bro',
      task_id: taskId,
      fields: ['attempt_n', 'verdict'],
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows), 'bare array preserved with fields projection');
    assert.ok(rows.length === 1);
    const row = rows[0];
    assert.ok('attempt_n' in row, 'attempt_n must be present');
    assert.ok('verdict' in row, 'verdict must be present');
    assert.ok(!('feedback' in row), 'feedback must NOT be present when not in fields');
    assert.ok(!('agent' in row), 'agent must NOT be present when not in fields');

    db.close();
  });

  it('validation_history bare-array shape preserved by default (L4 compat)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const taskId = await createTask(db, issueId);
    const validation = validationTools(db);

    await call(validation.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: 'Looks good',
      mcp_available: true,
      subagent_session_id: 'test-session-compat',
    });

    const result = await call(validation.handlers, 'validation_history', {
      agent: 'bro',
      task_id: taskId,
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows), 'default shape must be bare array (L4 compat)');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, 'pass');

    db.close();
  });

  it('unknown field returns named error', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const taskId = await createTask(db, issueId);
    const validation = validationTools(db);

    const result = await call(validation.handlers, 'validation_history', {
      agent: 'bro',
      task_id: taskId,
      fields: ['attempt_n', 'unknown_col'],
    });

    assert.ok(result.isError, 'Should be error for unknown field');
    const data = parseResult(result);
    assert.ok(data.error.includes('Unknown fields'), `Error must cite unknown fields: ${data.error}`);
    assert.ok(data.error.includes('unknown_col'), `Error must name the bad field: ${data.error}`);

    db.close();
  });
});

describe('fields projection — issue_list (#210)', () => {
  it('fields projection returns only requested columns', async () => {
    const db = tempDB();
    await createIssue(db);
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
      fields: ['id', 'status'],
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    const row = rows[0];
    assert.ok('id' in row, 'id must be present');
    assert.ok('status' in row, 'status must be present');
    assert.ok(!('objective' in row), 'objective must NOT be present when not in fields');
    assert.ok(!('updated_at' in row), 'updated_at must NOT be present when not in fields');

    db.close();
  });

  it('unknown field returns named error', async () => {
    const db = tempDB();
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
      fields: ['id', 'description'],
    });

    assert.ok(result.isError, 'Should be error for unknown field');
    const data = parseResult(result);
    assert.ok(data.error.includes('Unknown fields'), `Error must cite unknown fields: ${data.error}`);
    assert.ok(data.error.includes('description'), `Error must name the bad field: ${data.error}`);

    db.close();
  });
});

describe('issue_report_md summary mode (#210)', () => {
  it('summary mode default: returns counts + last 5 audit events', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    await createTask(db, issueId);

    const audit = auditTools(db);
    for (let i = 1; i <= 8; i++) {
      await call(audit.handlers, 'audit_append', {
        agent: 'bro',
        issue_id: String(issueId),
        from_node: 'bro',
        event_type: 'test_event',
        summary: `Audit event ${i}`,
      });
    }

    const tools = reportTools(db);
    const result = await call(tools.handlers, 'issue_report_md', {
      agent: 'bro',
      issue_id: String(issueId),
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.equal(data.mode, 'summary', 'mode field must be "summary"');
    assert.ok(typeof data.markdown === 'string');

    const md = data.markdown as string;
    assert.ok(md.includes('## Objective + Status'), 'Summary must have Objective section');
    assert.ok(md.includes('## Last 5 Audit Events'), 'Summary must have Last 5 Audit Events section');
    assert.ok(!md.includes('## Tasks'), 'Summary must NOT have full Tasks table');
    assert.ok(!md.includes('## Validation History'), 'Summary must NOT have Validation History');

    // Token-bound sanity: summary should be well under 3000 chars
    assert.ok(md.length < 3000, `Summary markdown too long: ${md.length} chars`);

    // Should include last 5 events but not early ones
    assert.ok(md.includes('Audit event 8'), 'Last event must be in summary');
    assert.ok(md.includes('Audit event 4'), 'Event 4 must be in summary (5th from end)');
    assert.ok(!md.includes('Audit event 3'), 'Event 3 must NOT be in summary (6th from end)');
    assert.ok(!md.includes('Audit event 1'), 'Event 1 must NOT be in summary');

    db.close();
  });

  it('detail mode: returns full Tasks + Validation + Audit sections', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    await createTask(db, issueId);

    const audit = auditTools(db);
    await call(audit.handlers, 'audit_append', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      event_type: 'task_started',
      summary: 'Detail mode audit entry',
    });

    const tools = reportTools(db);
    const result = await call(tools.handlers, 'issue_report_md', {
      agent: 'bro',
      issue_id: String(issueId),
      mode: 'detail',
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.equal(data.mode, 'detail', 'mode field must be "detail"');

    const md = data.markdown as string;
    assert.ok(md.includes('## Tasks'), 'Detail must have Tasks section');
    assert.ok(md.includes('## Validation History'), 'Detail must have Validation History section');
    assert.ok(md.includes('## Audit Event Timeline'), 'Detail must have Audit Event Timeline section');
    assert.ok(md.includes('Detail mode audit entry'), 'Audit entry must appear in detail report');

    db.close();
  });
});

describe('branch_report_md summary mode (#210)', () => {
  it('summary mode default: returns task status + counts + last 5 audit events', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const branchId = 'feat/summary-test';
    await createTask(db, issueId, branchId);

    const audit = auditTools(db);
    for (let i = 1; i <= 7; i++) {
      await call(audit.handlers, 'audit_append', {
        agent: 'bro',
        issue_id: String(issueId),
        branch_id: branchId,
        from_node: 'bro',
        event_type: 'test_event',
        summary: `Branch event ${i}`,
      });
    }

    const tools = branchReportMdTools(db);
    const result = await call(tools.handlers, 'branch_report_md', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: branchId,
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.equal(data.mode, 'summary', 'mode field must be "summary"');

    const md = data.markdown as string;
    assert.ok(md.includes('## Tasks on this branch'), 'Summary must have Tasks section');
    assert.ok(md.includes('## Last 5 Audit Events'), 'Summary must have Last 5 Audit Events section');
    assert.ok(!md.includes('## Validation attempts'), 'Summary must NOT have Validation section');

    // Token-bound sanity
    assert.ok(md.length < 3000, `Branch summary markdown too long: ${md.length} chars`);

    // last 5 of 7 events
    assert.ok(md.includes('Branch event 7'), 'Last event must be in summary');
    assert.ok(md.includes('Branch event 3'), '5th from end must be in summary');
    assert.ok(!md.includes('Branch event 2'), '6th from end must NOT be in summary');

    db.close();
  });
});
