import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';

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

describe('issueTools', () => {
  it('create then get returns the created issue', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'architect',
      objective: 'Build feature X',
      goals_md: '# Goals\n- Do X',
    });
    const created = parseResult(createResult);
    assert.ok(!createResult.isError, `Expected no error, got: ${created.error}`);
    assert.equal(created.objective, 'Build feature X');
    assert.equal(created.status, 'open');

    const getResult = await call(tools.handlers, 'issue_get', {
      agent: 'architect',
      issue_id: String(created.id),
      include_goals: true,
    });
    const fetched = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.goals_md, '# Goals\n- Do X');

    db.close();
  });

  it('issue_get with include_goals=false omits goals_md', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'swe',
      objective: 'Test redaction',
      goals_md: 'secret goals',
    });
    const created = parseResult(createResult);

    const getResult = await call(tools.handlers, 'issue_get', {
      agent: 'swe',
      issue_id: String(created.id),
      include_goals: false,
    });
    const fetched = parseResult(getResult);
    assert.ok(!('goals_md' in fetched), 'goals_md should be omitted when include_goals=false');

    db.close();
  });

  it('issue_resume returns the issue and first pending task', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const { taskTools } = await import('../tools/tasks.js');
    const tTools = taskTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'swe',
      objective: 'Resume test',
    });
    const issue = parseResult(createResult);

    await call(tTools.handlers, 'task_create_batch', {
      agent: 'swe',
      issue_id: String(issue.id),
      tasks: [
        { branch_id: '1.1', description: 'First task', success_criteria: 'done' },
        { branch_id: '1.2', description: 'Second task', success_criteria: 'done' },
      ],
    });

    const resumeResult = await call(tools.handlers, 'issue_resume', {
      agent: 'swe',
      issue_id: String(issue.id),
    });
    const resumed = parseResult(resumeResult);
    assert.ok(!resumeResult.isError);
    assert.equal(resumed.issue.id, issue.id);
    assert.ok(resumed.next_task !== null);
    assert.equal(resumed.next_task.branch_id, '1.1');

    db.close();
  });

  it('issue_close sets status to closed', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'swe',
      objective: 'Close test',
    });
    const issue = parseResult(createResult);

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'swe',
      issue_id: String(issue.id),
      post_git_sha: 'abc123',
    });
    const closed = parseResult(closeResult);
    assert.ok(!closeResult.isError);
    assert.equal(closed.status, 'closed');
    assert.ok(closed.closed_at !== null);

    db.close();
  });

  it('issue_get_phase returns tasks phase when tasks are in progress', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const { taskTools } = await import('../tools/tasks.js');
    const tTools = taskTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'swe',
      objective: 'Phase test',
    });
    const issue = parseResult(createResult);

    await call(tTools.handlers, 'task_create_batch', {
      agent: 'swe',
      issue_id: String(issue.id),
      tasks: [
        { branch_id: '1.1', description: 'Task 1', success_criteria: 'done' },
        { branch_id: '1.2', description: 'Task 2', success_criteria: 'done' },
      ],
    });

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'swe',
      issue_id: String(issue.id),
    });
    const phaseData = parseResult(phaseResult);
    assert.ok(!phaseResult.isError);
    assert.equal(phaseData.phase, 'tasks');
    assert.equal(phaseData.counts.tasks_total, 2);

    db.close();
  });

  it('unknown issue_id returns a JSON-RPC error', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_get', {
      agent: 'swe',
      issue_id: '99999',
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Should be an error result');
    assert.match(data.error, /Not found/);

    db.close();
  });
});
