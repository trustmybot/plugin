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
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [
        { branch_id: '1.1', description: 'Task one', success_criteria: 'works' },
        { branch_id: '1.2', description: 'Task two', success_criteria: 'passes' },
        { branch_id: '1.3', description: 'Task three', success_criteria: 'done' },
      ],
    });

    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.ok(Array.isArray(inserted));
    assert.equal(inserted.length, 3);
    assert.equal(inserted[0].branch_id, '1.1');
    assert.equal(inserted[1].branch_id, '1.2');
    assert.equal(inserted[2].branch_id, '1.3');
    assert.ok(inserted.every((t: { status: string }) => t.status === 'pending'));

    db.close();
  });

  it('task_update_status rejects unknown status', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [{ branch_id: '1.1', description: 'A task', success_criteria: 'ok' }],
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
      agent: 'swe',
      issue_id: String(issueId),
      tasks: [
        { branch_id: '1.1', description: 'First', success_criteria: 'ok' },
        { branch_id: '1.2', description: 'Second', success_criteria: 'ok' },
        { branch_id: '1.3', description: 'Third', success_criteria: 'ok' },
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
    assert.equal(task.branch_id, '1.2');

    db.close();
  });

  it('task_update_status accepts all valid statuses', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validStatuses = ['pending', 'running', 'needs_validation', 'completed', 'failed', 'escalated'];

    for (const status of validStatuses) {
      const batchResult = await call(tools.handlers, 'task_create_batch', {
        agent: 'swe',
        issue_id: String(issueId),
        tasks: [{ branch_id: `status-${status}`, description: `Task for ${status}`, success_criteria: 'ok' }],
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
});
