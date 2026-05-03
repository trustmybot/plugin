import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { auditTools } from '../tools/audit.js';

function makeGitSubdir(name: string): { name: string; cleanup: () => void } {
  const dir = join(process.cwd(), name);
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return { name, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}



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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/a-task', description: 'A task', success_criteria: 'ok' }],
    });
    const tasks = parseResult(batchResult);

    const result = await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      agent: 'bro',
      task_id: String(allTasks[0].id),
      status: 'completed',
    });
    await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: String(allTasks[1].id),
      status: 'failed',
    });

    const result = await call(tools.handlers, 'task_first_actionable', {
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: branchId, description: `Task for ${status}`, success_criteria: 'ok' }],
      });
      const tasks = parseResult(batchResult);

      const result = await call(tools.handlers, 'task_update_status', {
        agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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

  it('task_create_batch accepts parent_branch_id="dev"', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-dev', parent_branch_id: 'dev', description: 'branches off dev', success_criteria: 'ok' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].parent_branch_id, 'dev');

    db.close();
  });

  it('task_create_batch accepts parent_branch_id="main"', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-main', parent_branch_id: 'main', description: 'branches off main', success_criteria: 'ok' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].parent_branch_id, 'main');

    db.close();
  });

  it('task_create_batch accepts parent_branch_id="master"', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-master', parent_branch_id: 'master', description: 'branches off master', success_criteria: 'ok' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].parent_branch_id, 'master');

    db.close();
  });

  it('task_create_batch accepts parent_branch_id="feat/foo" (git-convention still works)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/child-task', parent_branch_id: 'feat/foo', description: 'child of feat/foo', success_criteria: 'ok' }],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].parent_branch_id, 'feat/foo');

    db.close();
  });

  it('task_create_batch rejects parent_branch_id="random-junk"', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/foo', parent_branch_id: 'random-junk', description: 'bad parent', success_criteria: 'n/a' }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid branch_id/);

    db.close();
  });

  it('task_create_batch rejects branch_id="dev" (own branch must stay strict-format)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'dev', description: 'bad branch_id', success_criteria: 'n/a' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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

  it('task_update_status rejects SWE writes of non-terminal status (needs_validation, pending, closed, escalated)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/swe-guard-test', description: 'SWE guard test', success_criteria: 'ok' },
      ],
    });
    const tasks = parseResult(batchResult);
    const taskId = String(tasks[0].id);

    const forbiddenStatuses = ['needs_validation', 'pending', 'closed', 'escalated'];
    for (const status of forbiddenStatuses) {
      const result = await call(tools.handlers, 'task_update_status', {
        agent: 'swe',
        task_id: taskId,
        status,
      });
      const data = parseResult(result);
      assert.ok(result.isError, `Expected isError=true for SWE + status='${status}'`);
      assert.match(data.error, /task_update_status rejected/, `Expected rejection message for status='${status}'`);
      assert.match(data.error, /#114/, `Expected #114 reference for status='${status}'`);
    }

    db.close();
  });

  it('task_update_status allows SWE writes of running, completed, and failed', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/swe-running-test', description: 'SWE running test', success_criteria: 'ok' },
        { branch_id: 'feat/swe-completed-test', description: 'SWE completed test', success_criteria: 'ok' },
        { branch_id: 'feat/swe-failed-test', description: 'SWE failed test', success_criteria: 'ok' },
      ],
    });
    const tasks = parseResult(batchResult);

    const runningResult = await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(tasks[0].id),
      status: 'running',
    });
    assert.ok(!runningResult.isError, `Expected no error for SWE + status='running': ${JSON.stringify(parseResult(runningResult))}`);
    assert.equal(parseResult(runningResult).status, 'running');

    const completedResult = await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(tasks[1].id),
      status: 'completed',
    });
    assert.ok(!completedResult.isError, `Expected no error for SWE + status='completed': ${JSON.stringify(parseResult(completedResult))}`);
    assert.equal(parseResult(completedResult).status, 'completed');

    const failedResult = await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(tasks[2].id),
      status: 'failed',
    });
    assert.ok(!failedResult.isError, `Expected no error for SWE + status='failed': ${JSON.stringify(parseResult(failedResult))}`);
    assert.equal(parseResult(failedResult).status, 'failed');

    db.close();
  });

  it('task_update_status allows bro to set any status including closed and needs_validation', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/bro-closed-test', description: 'Bro closed test', success_criteria: 'ok' },
        { branch_id: 'feat/bro-needs-validation-test', description: 'Bro needs_validation test', success_criteria: 'ok' },
      ],
    });
    const tasks = parseResult(batchResult);

    const closedResult = await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: String(tasks[0].id),
      status: 'closed',
    });
    assert.ok(!closedResult.isError, `Expected no error for bro + status='closed': ${JSON.stringify(parseResult(closedResult))}`);
    assert.equal(parseResult(closedResult).status, 'closed');

    const nvResult = await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: String(tasks[1].id),
      status: 'needs_validation',
    });
    assert.ok(!nvResult.isError, `Expected no error for bro + status='needs_validation': ${JSON.stringify(parseResult(nvResult))}`);
    assert.equal(parseResult(nvResult).status, 'needs_validation');

    db.close();
  });

  it('task_create_batch accepts spec_body exactly at 8000 chars (boundary)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const body = 'x'.repeat(8000);
    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
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

  it('task_create_batch stores repo and task_get returns it verbatim', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/repo-test',
          description: 'Task with repo set',
          success_criteria: 'repo stored',
          repo: 'inner',
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, 'inner');

    const getResult = await call(tools.handlers, 'task_get', {
      agent: 'bro',
      task_id: String(inserted[0].id),
    });
    const task = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(task.repo, 'inner');

    db.close();
  });

  it('task_create_batch stores nested repo path', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/nested-repo',
          description: 'Task with nested repo path',
          success_criteria: 'stored correctly',
          repo: 'repos/backend',
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, 'repos/backend');

    db.close();
  });

  it('task_create_batch defaults repo to null when omitted', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-repo',
          description: 'Task without repo',
          success_criteria: 'repo is null',
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, null);

    db.close();
  });

  it('task_create_batch treats empty string repo as null', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/empty-repo',
          description: 'Task with empty repo string',
          success_criteria: 'repo is null',
          repo: '',
        },
      ],
    });
    const inserted = parseResult(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, null);

    db.close();
  });

  it('task_create_batch rejects repo containing ".."', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/bad-repo',
          description: 'Task with bad repo path',
          success_criteria: 'rejected',
          repo: '../escape',
        },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid repo/);
    assert.match(data.error, /\.\./);

    db.close();
  });

  it('task_create_batch rejects repo starting with "/"', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/abs-repo',
          description: 'Task with absolute repo path',
          success_criteria: 'rejected',
          repo: '/absolute/path',
        },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /Invalid repo/);

    db.close();
  });

  it('task_create_batch accepts task when branch exists in explicit repo (#102)', async () => {
    const { name, cleanup } = makeGitSubdir('test-git-fixture-branch-exists');
    try {
      const repoDir = join(process.cwd(), name);
      spawnSync('git', ['branch', 'feat/my-feature'], { cwd: repoDir, stdio: 'pipe' });
      const db = tempDB();
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
          {
            branch_id: 'feat/my-feature',
            description: 'Feature task',
            success_criteria: 'branch exists',
            repo: name,
          },
        ],
      });
      const inserted = parseResult(result);
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
      assert.equal(inserted[0].branch_id, 'feat/my-feature');
      assert.equal(inserted[0].repo, name);

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch rejects task when branch does not exist in explicit repo (#102)', async () => {
    const { name, cleanup } = makeGitSubdir('test-git-fixture-branch-missing');
    try {
      const db = tempDB();
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
          {
            branch_id: 'feat/nonexistent-branch',
            description: 'Feature task',
            success_criteria: 'should be rejected',
            repo: name,
          },
        ],
      });
      const data = parseResult(result);
      assert.ok(result.isError, 'Expected isError=true');
      assert.match(data.error, /task_create_batch rejected/);
      assert.match(data.error, /feat\/nonexistent-branch/);
      assert.match(data.error, /#102/);

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch uses subdir repo for branch check, not parent repo (#102)', async () => {
    const { name: repoA, cleanup: cleanupA } = makeGitSubdir('test-git-fixture-repo-a');
    const { name: repoB, cleanup: cleanupB } = makeGitSubdir('test-git-fixture-repo-b');
    try {
      const repoADir = join(process.cwd(), repoA);
      spawnSync('git', ['branch', 'feat/exists-in-a-only'], { cwd: repoADir, stdio: 'pipe' });

      const db = tempDB();
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const acceptedResult = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo A', success_criteria: 'accepted', repo: repoA }],
      });
      assert.ok(!acceptedResult.isError, `Expected accepted for repoA: ${JSON.stringify(parseResult(acceptedResult))}`);

      const rejectedResult = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo B (branch absent)', success_criteria: 'rejected', repo: repoB }],
      });
      assert.ok(rejectedResult.isError, 'Expected rejection when branch absent in repoB');
      assert.match(parseResult(rejectedResult).error, /task_create_batch rejected/);

      db.close();
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  it('task_create_batch skips branch-existence check when repo is unset (backward compat) (#102)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-repo-set',
          description: 'Task without explicit repo',
          success_criteria: 'no branch check performed',
        },
      ],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error when repo is unset: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].branch_id, 'feat/no-repo-set');

    db.close();
  });

  it('task_create_batch rejects without branch_id_proposed audit event (#155)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'some_other_event',
      summary: 'not a branch_id_proposed event',
    });

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'fix/test-gate', description: 'd', success_criteria: 'c' }],
    });

    assert.ok(result.isError, 'Expected isError=true');
    const data = parseResult(result);
    assert.equal(data.error, 'branch_state_violation');

    db.close();
  });

  it('task_create_batch defaults repo to tmb_default_repo config when task.repo omitted', async () => {
    const db = tempDB();
    db.run(
      `INSERT OR REPLACE INTO plugin_config (key, value_json, updated_at) VALUES ('tmb_default_repo', '"plugin"', datetime('now'))`,
    );
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/default-repo-test', description: 'No repo arg', success_criteria: 'uses default' },
      ],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, 'plugin', 'repo should default to tmb_default_repo config value');

    db.close();
  });

  it('task_create_batch defaults repo to null when task.repo omitted and tmb_default_repo not set', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/null-repo-back-compat', description: 'No repo, no config', success_criteria: 'repo is null' },
      ],
    });
    const inserted = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, null, 'repo should be null when no config and no task.repo');

    db.close();
  });

  it('task_create_batch passes with branch_id_proposed audit event (#155)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'branch_id_proposed',
      summary: 'Branch fix/test-gate created from origin/dev. Main checkout switched.',
    });

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'fix/test-gate', description: 'd', success_criteria: 'c' }],
    });

    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });
});
