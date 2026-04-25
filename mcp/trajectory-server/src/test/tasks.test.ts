import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
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

async function createIssue(db: ReturnType<typeof tempDB>): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    agent: 'swe',
    objective: 'Test issue',
  });
  const data = parseResult(result);
  return data.id as number;
}

describe('taskTools', () => {
  it('task_create_batch inserts N rows atomically', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/task-one', description: 'Task one', success_criteria: 'works' },
        { branch_id: 'feat/task-two', description: 'Task two', success_criteria: 'passes' },
        { branch_id: 'feat/task-three', description: 'Task three', success_criteria: 'done' },
      ],
    });

    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.ok(Array.isArray(inserted));
    assert.equal(inserted.length, 3);
    assert.equal(inserted[0].branch_id, 'feat/task-one');
    assert.equal(inserted[1].branch_id, 'feat/task-two');
    assert.equal(inserted[2].branch_id, 'feat/task-three');
    assert.ok(inserted.every((t: { status: string }) => t.status === 'pending'));

    db.close();
  });

  it('task_update_status rejects unknown status', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/a-task', description: 'A task', success_criteria: 'ok' }],
    });
    const tasks = parseResult(batchResult);

    const result = await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(tasks[0].id),
      status: 'banana',
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid status/);
    assert.match(data.error, /banana/);

    db.close();
  });

  it('task_first_actionable returns lowest branch_id among pending/failed', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/first', description: 'First', success_criteria: 'ok' },
        { branch_id: 'feat/second', description: 'Second', success_criteria: 'ok' },
        { branch_id: 'feat/third', description: 'Third', success_criteria: 'ok' },
      ],
    });

    const allTasks = db.all<{ id: number; branch_id: string }>(
      'SELECT id, branch_id FROM tasks WHERE issue_id = ? ORDER BY branch_id',
      [issueId],
    );

    await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(allTasks[0].id),
      status: 'completed',
    });
    await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(allTasks[1].id),
      status: 'failed',
    });

    const result = await call(tools.handlers, 'task_first_actionable', {
      agent: 'swe',
      issue_id: String(issueId),
    });
    const task = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(task !== null);
    assert.equal(task.branch_id, 'feat/second');

    db.close();
  });

  it('task_update_status accepts all valid statuses', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validStatuses = ['pending', 'running', 'needs_validation', 'completed', 'failed', 'escalated'];
    const branchNames = [
      'feat/status-pending',
      'feat/status-running',
      'feat/status-needs-validation',
      'feat/status-completed',
      'feat/status-failed',
      'feat/status-escalated',
    ];

    for (let i = 0; i < validStatuses.length; i++) {
      const status = validStatuses[i]!;
      const branchId = branchNames[i]!;
      const batchResult = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        agent: 'swe',
        issue_id: String(issueId),
        tasks: [{ branch_id: branchId, description: `Task for ${status}`, success_criteria: 'ok' }],
      });
      const tasks = parseResult(batchResult);

      const result = await call(tools.handlers, 'task_update_status', {
        agent: 'swe',
        task_id: String(tasks[0].id),
        status,
      });
      const updated = parseResult(result);
      assert.ok(!result.isError, `Expected no error for status "${status}": ${JSON.stringify(updated)}`);
      assert.equal(updated.status, status);
    }

    db.close();
  });

  it('task_create_batch accepts valid git-convention branch_id: feat/user-login', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/user-login', description: 'login feature', success_criteria: 'works' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].branch_id, 'feat/user-login');

    db.close();
  });

  it('task_create_batch accepts valid git-convention branch_id: refactor/extract-helper', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'refactor/extract-helper', description: 'extract helper', success_criteria: 'clean' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].branch_id, 'refactor/extract-helper');

    db.close();
  });

  it('task_create_batch rejects branch_id with uppercase type: Foo/Bar', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'Foo/Bar', description: 'bad', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch rejects branch_id with uppercase slug: feat/UPPERCASE', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/UPPERCASE', description: 'bad', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch rejects branch_id with leading hyphen: feat/-leading-hyphen', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/-leading-hyphen', description: 'bad', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch rejects empty branch_id', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: '', description: 'bad', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /branch_id/);

    db.close();
  });

  it('task_create_batch rejects branch_id with double slash: feat/double//slash', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/double//slash', description: 'bad', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch rejects invalid parent_branch_id', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/foo',
          parent_branch_id: 'bad value',
          description: 'bad parent',
          success_criteria: 'n/a',
        },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch stores spec_body and task_get returns it verbatim', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const specBody = '# Description\nThis is a test spec body.';
    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'architect',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/spec-body-test',
          description: 'Test spec body storage',
          success_criteria: 'spec_body is stored',
          spec_body: specBody,
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);

    const getResult = await call(tools.handlers, 'task_get', {
      agent: 'swe',
      task_id: String(inserted[0].id),
    });
    const task = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(task.spec_body, specBody);

    db.close();
  });

  it('task_create_batch without spec_body defaults to empty string', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'architect',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-spec-body',
          description: 'No spec body',
          success_criteria: 'defaults to empty',
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].spec_body, '');

    db.close();
  });

  it('task_create_batch rejects spec_body longer than 8000 chars (over-engineering guard)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const oversizeBody = 'x'.repeat(8001);
    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'architect',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/oversize-spec',
          description: 'Oversize spec body',
          success_criteria: 'should be rejected',
          spec_body: oversizeBody,
        },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /8000/);
    assert.match(data.error, /8001/);

    db.close();
  });

  it('task_create_batch accepts spec_body exactly at 8000 chars (boundary)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const body = 'x'.repeat(8000);
    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'architect',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/boundary-spec',
          description: 'Boundary spec',
          success_criteria: 'at limit',
          spec_body: body,
        },
      ],
    });
    assert.ok(!result.isError, `Expected success at 8000 chars; got: ${JSON.stringify(result)}`);

    db.close();
  });
});
