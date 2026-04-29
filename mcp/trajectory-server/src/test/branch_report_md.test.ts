import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { branchReportMdTools } from '../tools/branch_report_md.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { ledgerTools } from '../tools/ledger.js';
import { validationTools } from '../tools/validation.js';
import { nowISO } from '../db.js';

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

async function createIssue(db: ReturnType<typeof tempDB>): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    agent: 'bro',
    objective: 'Branch report test issue',
  });
  return parseResult(result).id as number;
}

async function createTask(
  db: ReturnType<typeof tempDB>,
  issueId: number,
  branchId: string,
): Promise<number> {
  const tools = taskTools(db);
  const result = await call(tools.handlers, 'task_create_batch', {
    waive_scope_gate: true,
    waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
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
  return rows[0].id as number;
}

/**
 * Insert a task row directly via SQL, bypassing tool-layer side effects
 * (scope-gate ledger entries etc.). Used when the test needs a clean ledger.
 */
function insertTaskDirect(
  db: ReturnType<typeof tempDB>,
  issueId: number,
  branchId: string,
): number {
  const now = nowISO();
  const result = db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, tools_required, skills_required, success_criteria, status, attempts, spec_body, created_at, updated_at)
     VALUES (?, ?, '', 'Direct insert for unit test', '[]', '[]', 'Done', 'pending', 0, '', ?, ?)`,
    [issueId, branchId, now, now],
  );
  return Number(result.lastInsertRowid);
}

describe('branchReportMdTools', () => {
  it('happy path — renders all four sections for valid (issue_id, branch_id)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const branchId = 'feat/my-feature';
    const taskId = await createTask(db, issueId, branchId);

    const ledger = ledgerTools(db);
    await call(ledger.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: branchId,
      from_node: 'swe',
      event_type: 'task_started',
      summary: 'SWE began work on feature',
    });

    const validation = validationTools(db);
    await call(validation.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: 'Looks good',
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

    const md = data.markdown as string;
    assert.ok(md.includes(`# Branch Report — ${branchId} (issue #${issueId})`), 'Missing header');
    assert.ok(md.includes('**Issue objective:**'), 'Missing issue objective');
    assert.ok(md.includes('## Tasks on this branch'), 'Missing Tasks section');
    assert.ok(md.includes('## Ledger events'), 'Missing Ledger events section');
    assert.ok(md.includes('## Validation attempts'), 'Missing Validation attempts section');
    assert.ok(md.includes('## file_registry entries touched on this branch'), 'Missing file_registry section');

    assert.ok(md.includes('SWE began work on feature'), 'Ledger entry missing from report');
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
    assert.ok(
      data.error.includes('issue_id must be a positive integer'),
      `Error should mention integer requirement: ${data.error}`,
    );

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
    assert.ok(
      data.error.includes('No tasks found'),
      `Error should mention no tasks: ${data.error}`,
    );
    assert.ok(
      data.error.includes('feat/does-not-exist'),
      `Error should include the branch_id: ${data.error}`,
    );

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

  it('empty ledger and validation — sections render with empty placeholders', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const branchId = 'feat/empty-branch';
    // Use direct SQL insert to avoid scope_gate_waived ledger side-effect from createTask.
    insertTaskDirect(db, issueId, branchId);

    const tools = branchReportMdTools(db);
    const result = await call(tools.handlers, 'branch_report_md', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: branchId,
    });

    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    const md = data.markdown as string;

    assert.ok(md.includes('_No ledger events._'), 'Expected empty ledger placeholder');
    assert.ok(md.includes('_No validation attempts._'), 'Expected empty validation placeholder');
    assert.ok(
      md.includes('_No file_registry entries found for this branch._'),
      'Expected empty file_registry placeholder',
    );

    db.close();
  });

  it('requireRoles — rejects unknown agent', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = branchReportMdTools(db);

    const result = await call(tools.handlers, 'branch_report_md', {
      agent: 'hacker',
      issue_id: String(issueId),
      branch_id: 'feat/test',
    });

    assert.ok(result.isError, 'Expected error result for unknown agent');
    const data = parseResult(result);
    assert.equal(data.error, 'forbidden', `Expected forbidden error: ${JSON.stringify(data)}`);

    db.close();
  });

  it('all four known agents are accepted', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const branchId = 'feat/agent-test';
    await createTask(db, issueId, branchId);

    const tools = branchReportMdTools(db);

    for (const agent of ['bro', 'architect', 'swe', 'pr-reviewer']) {
      const result = await call(tools.handlers, 'branch_report_md', {
        agent,
        issue_id: String(issueId),
        branch_id: branchId,
      });
      assert.ok(!result.isError, `Agent "${agent}" should be accepted`);
    }

    db.close();
  });

  it('scopes ledger events to branch — sibling branch events not included', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const targetBranch = 'feat/target';
    const siblingBranch = 'feat/sibling';
    await createTask(db, issueId, targetBranch);
    await createTask(db, issueId, siblingBranch);

    const ledger = ledgerTools(db);
    await call(ledger.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: targetBranch,
      from_node: 'swe',
      event_type: 'task_started',
      summary: 'Started target branch work',
    });
    await call(ledger.handlers, 'ledger_log', {
      agent: 'bro',
      issue_id: String(issueId),
      branch_id: siblingBranch,
      from_node: 'swe',
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
    const md = data.markdown as string;
    assert.ok(md.includes('Started target branch work'), 'Target branch ledger entry should be present');
    assert.ok(!md.includes('Started sibling branch work'), 'Sibling branch ledger entry should NOT be present');

    db.close();
  });
});
