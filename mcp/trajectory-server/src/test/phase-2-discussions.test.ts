import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { TrajectoryDB } from '../db.js';
import { discussionTools } from '../tools/discussions.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { reportTools } from '../tools/reports.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

describe('Phase 2 discussions + snapshot integration', () => {
  let db: TrajectoryDB;
  let snapshotDir: string;
  let originalCwd: string;
  let tmpWorkDir: string;

  before(() => {
    db = new TrajectoryDB(':memory:');

    tmpWorkDir = join(tmpdir(), `tmb-test-${Date.now()}`);
    snapshotDir = join(tmpWorkDir, 'docs', 'trustmybot', 'snapshots');
    mkdirSync(tmpWorkDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpWorkDir);
  });

  after(() => {
    process.chdir(originalCwd);
    db.close();
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('step 1: creates an issue', async () => {
    const issues = issueTools(db);
    const result = await call(issues.handlers, 'issue_create', {
      agent: 'architect',
      objective: 'Phase 2 integration test issue',
      goals_md: '# Goals\n- Prove the tools work',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(created)}`);
    assert.equal(created.objective, 'Phase 2 integration test issue');
    assert.equal(created.status, 'open');

    (globalThis as Record<string, unknown>)['testIssueId'] = String(created.id);
  });

  it('step 2: issue_list returns the row', async () => {
    const issues = issueTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'gatekeeper',
    });
    const rows = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(rows)}`);
    assert.ok(Array.isArray(rows), 'Should return an array');
    assert.ok(rows.length >= 1, 'Should have at least 1 row');

    const row = rows.find((r: { id: number }) => String(r.id) === issueId);
    assert.ok(row, 'Created issue should appear in issue_list');
    assert.ok('id' in row, 'Row must have id');
    assert.ok('objective' in row, 'Row must have objective');
    assert.ok('status' in row, 'Row must have status');
    assert.ok('created_at' in row, 'Row must have created_at');
    assert.ok('updated_at' in row, 'Row must have updated_at');
    assert.ok(!('goals_md' in row), 'Row must NOT have goals_md');
    assert.ok(!('discussions' in row), 'Row must NOT have discussions');
  });

  it('step 2b: issue_list with status filter works', async () => {
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'gatekeeper',
      status: 'open',
    });
    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows));

    const resultClosed = await call(issues.handlers, 'issue_list', {
      agent: 'gatekeeper',
      status: 'closed',
    });
    const closedRows = parseResult(resultClosed);
    assert.ok(!resultClosed.isError);
    assert.equal(closedRows.length, 0, 'No closed issues yet');
  });

  it('step 2c: issue_list rejects invalid status', async () => {
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'gatekeeper',
      status: 'invalid_status',
    });
    assert.ok(result.isError, 'Should be error for invalid status');
    const data = parseResult(result);
    assert.ok(data.error.includes('Allowed values'), 'Error should list allowed values');
  });

  it('step 3a: discussion_append inserts two entries', async () => {
    const disc = discussionTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const r1 = await call(disc.handlers, 'discussion_append', {
      agent: 'architect',
      issue_id: issueId,
      author: 'architect',
      kind: 'intent',
      body_md: 'We want to build the discussion tools for Phase 2.',
    });
    assert.ok(!r1.isError, `Expected no error: ${JSON.stringify(parseResult(r1))}`);
    const d1 = parseResult(r1);
    assert.equal(d1.kind, 'intent');
    assert.equal(d1.author, 'architect');

    const r2 = await call(disc.handlers, 'discussion_append', {
      agent: 'gatekeeper',
      issue_id: issueId,
      author: 'gatekeeper',
      kind: 'decision',
      body_md: 'Approved. SWE will implement.',
    });
    assert.ok(!r2.isError);
    const d2 = parseResult(r2);
    assert.equal(d2.kind, 'decision');

    (globalThis as Record<string, unknown>)['disc1Id'] = d1.id;
  });

  it('step 3b: discussion_append rejects invalid kind', async () => {
    const disc = discussionTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'architect',
      issue_id: issueId,
      author: 'architect',
      kind: 'invalid_kind',
      body_md: 'This should fail',
    });
    assert.ok(result.isError, 'Should be error for invalid kind');
    const data = parseResult(result);
    assert.ok(data.error.includes('Allowed values'), 'Error should list allowed values');
    assert.ok(data.error.includes('intent'), 'Error should mention allowed kinds');
  });

  it('step 3c: discussion_list returns entries ordered ASC', async () => {
    const disc = discussionTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(disc.handlers, 'discussion_list', {
      agent: 'gatekeeper',
      issue_id: issueId,
    });
    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'intent');
    assert.equal(rows[1].kind, 'decision');
  });

  it('step 3d: discussion_list for unknown issue returns empty with warning', async () => {
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'discussion_list', {
      agent: 'gatekeeper',
      issue_id: '999999',
    });
    assert.ok(!result.isError, 'Should NOT throw for unknown issue');
    const data = parseResult(result);
    assert.ok(data.warning, 'Should have warning field');
    assert.ok(data.warning.includes('issue not found'));
    assert.ok(Array.isArray(data.discussions));
    assert.equal(data.discussions.length, 0);
  });

  it('step 4: create a task and set its spec_path', async () => {
    const tasks = taskTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const batchResult = await call(tasks.handlers, 'task_create_batch', {
      agent: 'architect',
      issue_id: issueId,
      tasks: [
        {
          branch_id: 'feat/phase-2-discussions',
          title: 'Phase 2 discussions task',
          description: 'Implement discussion tools',
          success_criteria: 'All tools work',
        },
      ],
    });
    const created = parseResult(batchResult);
    assert.ok(!batchResult.isError);
    assert.equal(created.length, 1);

    const task = created[0];
    (globalThis as Record<string, unknown>)['testTaskId'] = String(task.id);

    const specResult = await call(tasks.handlers, 'task_set_spec_path', {
      agent: 'swe',
      issue_id: issueId,
      branch_id: 'feat/phase-2-discussions',
      spec_path: 'docs/trustmybot/tasks/feat-phase-2-discussions.md',
    });
    const updated = parseResult(specResult);
    assert.ok(!specResult.isError, `Expected no error: ${JSON.stringify(updated)}`);
    assert.equal(updated.task_spec_path, 'docs/trustmybot/tasks/feat-phase-2-discussions.md');
  });

  it('step 4b: task_set_spec_path rejects path with wrong stem', async () => {
    const tasks = taskTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(tasks.handlers, 'task_set_spec_path', {
      agent: 'swe',
      issue_id: issueId,
      branch_id: 'feat/phase-2-discussions',
      spec_path: 'docs/trustmybot/tasks/some-other-task.md',
    });
    assert.ok(result.isError, 'Should reject path whose stem does not contain sanitized branch_id');
    const data = parseResult(result);
    assert.ok(data.error.includes('feat-phase-2-discussions'), 'Error should show expected stem');
  });

  it('step 5: task_update_status with commit_sha persists both atomically', async () => {
    const tasks = taskTools(db);
    const taskId = (globalThis as Record<string, unknown>)['testTaskId'] as string;
    const sha = 'deadbeefcafe1234567890abcdef0123456789ab';

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: taskId,
      status: 'completed',
      commit_sha: sha,
    });
    const updated = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(updated)}`);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.commit_sha, sha, 'commit_sha must round-trip byte-for-byte');
    assert.ok(updated.completed_at !== null, 'completed_at must be set');

    const getResult = await call(tasks.handlers, 'task_get', {
      agent: 'swe',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.commit_sha, sha, 'commit_sha must persist and be readable via task_get');
  });

  it('step 6a: task_update_status rejects non-hex commit_sha without mutating', async () => {
    const tasks = taskTools(db);
    const taskId = (globalThis as Record<string, unknown>)['testTaskId'] as string;

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: taskId,
      status: 'pending',
      commit_sha: 'not-hex!',
    });
    assert.ok(result.isError, 'Should reject non-hex commit_sha');

    const getResult = await call(tasks.handlers, 'task_get', {
      agent: 'swe',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.status, 'completed', 'Status must NOT have changed to pending');
  });

  it('step 6b: task_update_status rejects too-short commit_sha (less than 7 chars)', async () => {
    const tasks = taskTools(db);
    const taskId = (globalThis as Record<string, unknown>)['testTaskId'] as string;

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: taskId,
      status: 'running',
      commit_sha: 'abc',
    });
    assert.ok(result.isError, 'Should reject SHA shorter than 7 chars');

    const getResult = await call(tasks.handlers, 'task_get', {
      agent: 'swe',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.status, 'completed', 'Status must NOT have changed');
  });

  it('step 6c: task_update_status without commit_sha is backward-compatible', async () => {
    const tasks = taskTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const batchResult = await call(tasks.handlers, 'task_create_batch', {
      agent: 'architect',
      issue_id: issueId,
      tasks: [
        {
          branch_id: 'feat/back-compat-test',
          description: 'Back-compat task',
          success_criteria: 'passes without commit_sha',
        },
      ],
    });
    const batchData = parseResult(batchResult);
    const taskId2 = String(batchData[0].id);

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: taskId2,
      status: 'completed',
    });
    const updated = parseResult(result);
    assert.ok(!result.isError, 'Back-compat call without commit_sha should succeed');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.commit_sha, null, 'commit_sha should remain null when not provided');
  });

  it('step 7+8: issue_snapshot_md writes a file with all records and commit_sha', async () => {
    const reports = reportTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;
    const sha = 'deadbeefcafe1234567890abcdef0123456789ab';

    const result = await call(reports.handlers, 'issue_snapshot_md', {
      agent: 'pr-reviewer',
      issue_id: issueId,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.ok(data.path, 'Should return a path');
    assert.ok(data.bytes_written > 0, 'Should write some bytes');
    assert.equal(data.path, `docs/trustmybot/snapshots/${issueId}.md`);

    const absPath = join(tmpWorkDir, data.path);
    assert.ok(existsSync(absPath), 'Snapshot file must exist on disk');

    const content = readFileSync(absPath, 'utf8');
    assert.ok(content.includes('Generated by issue_snapshot_md'), 'Must have GENERATED header');
    assert.ok(content.includes('Phase 2 integration test issue'), 'Must have issue objective');
    assert.ok(content.includes('We want to build the discussion tools'), 'Must include discussion body');
    assert.ok(content.includes('Approved. SWE will implement.'), 'Must include all discussion entries');
    assert.ok(content.includes('feat/phase-2-discussions'), 'Must include task branch_id');
    assert.ok(content.includes(sha), 'Must include commit_sha from the task row');
    assert.ok(content.includes('docs/trustmybot/tasks/feat-phase-2-discussions.md'), 'Must include task_spec_path');
  });

  it('step 8b: issue_snapshot_md rejects output_path outside docs/trustmybot/', async () => {
    const reports = reportTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(reports.handlers, 'issue_snapshot_md', {
      agent: 'pr-reviewer',
      issue_id: issueId,
      output_path: '/tmp/dangerous-path.md',
    });
    assert.ok(result.isError, 'Should reject path outside docs/trustmybot/');
    const data = parseResult(result);
    assert.ok(data.error.includes('docs/trustmybot'), 'Error should mention scope restriction');
  });

  it('issue_get_with_discussions returns combined data in one call', async () => {
    const disc = discussionTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'architect',
      issue_id: issueId,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.ok(data.issue, 'Should have issue field');
    assert.ok(Array.isArray(data.discussions), 'Should have discussions array');
    assert.ok(Array.isArray(data.tasks), 'Should have tasks array');
    assert.equal(data.issue.id, Number(issueId));
    assert.equal(data.discussions.length, 2, 'Should return both discussions');
    assert.ok(data.tasks.length >= 1, 'Should return at least one task');

    const taskFields = Object.keys(data.tasks[0]);
    assert.ok(taskFields.includes('id'), 'Task must have id');
    assert.ok(taskFields.includes('branch_id'), 'Task must have branch_id');
    assert.ok(taskFields.includes('status'), 'Task must have status');
    assert.ok(taskFields.includes('title'), 'Task must have title');
  });
});
