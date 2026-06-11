import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { discussionTools } from '../tools/discussions.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { reportTools } from '../tools/reports.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

function parseBatch(result: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(result.content[0].text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
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

describe('discussions + snapshot integration', () => {
  let db: TrajectoryDB;
  let snapshotDir: string;
  let originalCwd: string;
  let tmpWorkDir: string;

  before(() => {
    db = tempDB();

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
      agent: 'bro',
      objective: 'discussion integration test issue',
      description: '# Goals\n- Prove the tools work',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(created)}`);
    assert.equal(created.objective, 'discussion integration test issue');
    assert.equal(created.status, 'open');

    (globalThis as Record<string, unknown>)['testIssueId'] = String(created.id);
  });

  it('step 2: issue_list returns the row', async () => {
    const issues = issueTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
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
    assert.ok(!('description' in row), 'Row must NOT have description');
    assert.ok(!('discussions' in row), 'Row must NOT have discussions');
  });

  it('step 2b: issue_list with status filter works', async () => {
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
      status: 'open',
    });
    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(Array.isArray(rows));

    const resultClosed = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
      status: 'closed',
    });
    const closedRows = parseResult(resultClosed);
    assert.ok(!resultClosed.isError);
    assert.equal(closedRows.length, 0, 'No closed issues yet');
  });

  it('step 2c: issue_list rejects invalid status', async () => {
    const issues = issueTools(db);

    const result = await call(issues.handlers, 'issue_list', {
      agent: 'bro',
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
      agent: 'bro',
      issue_id: issueId,
      author: 'architect',
      kind: 'intent',
      body: 'We want to build the discussion tools.',
    });
    assert.ok(!r1.isError, `Expected no error: ${JSON.stringify(parseResult(r1))}`);
    const d1 = parseResult(r1);
    assert.equal(d1.kind, 'intent');
    assert.equal(d1.author, 'architect');

    const r2 = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      kind: 'decision',
      body: 'Approved. SWE will implement.',
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
      agent: 'bro',
      issue_id: issueId,
      author: 'architect',
      kind: 'invalid_kind',
      body: 'This should fail',
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
      agent: 'bro',
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

    // Use an id below the schema-seeded system issue (-1) but definitely
    // not created by any test setup. 8 has no fixtures or upstream creates.
    const result = await call(disc.handlers, 'discussion_list', {
      agent: 'bro',
      issue_id: '8',
    });
    assert.ok(!result.isError, 'Should NOT throw for unknown issue');
    const data = parseResult(result);
    assert.ok(data.warning, 'Should have warning field');
    assert.ok(data.warning.includes('issue not found'));
    assert.ok(Array.isArray(data.discussions));
    assert.equal(data.discussions.length, 0);
  });

  it('step 4: create a task with spec_body inline', async () => {
    const tasks = taskTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const batchResult = await call(tasks.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test verbatim spec body; shape not under test',
      agent: 'bro',
      issue_id: issueId,
      tasks: [
        {
          branch_id: 'feat/discussions-integration',
          title: 'discussions task',
          description: 'Implement discussion tools',
          spec_body: 'This is the spec body for the discussions task.',
        },
      ],
    });
    const created = parseBatch(batchResult);
    assert.ok(!batchResult.isError);
    assert.equal(created.length, 1);

    const task = created[0]!;
    (globalThis as Record<string, unknown>)['testTaskId'] = String(task.id);
    assert.equal(
      task.spec_body,
      'This is the spec body for the discussions task.',
      'spec_body must persist as written',
    );
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
      agent: 'bro',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.commit_sha, sha, 'commit_sha must persist and be readable via task_get');
  });

  it('step 6a: task_update_status rejects non-hex commit_sha without mutating', async () => {
    const tasks = taskTools(db);
    const taskId = (globalThis as Record<string, unknown>)['testTaskId'] as string;

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: taskId,
      status: 'pending',
      commit_sha: 'not-hex!',
    });
    assert.ok(result.isError, 'Should reject non-hex commit_sha');

    const getResult = await call(tasks.handlers, 'task_get', {
      agent: 'bro',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.status, 'completed', 'Status must NOT have changed to pending');
  });

  it('step 6b: task_update_status rejects too-short commit_sha (less than 7 chars)', async () => {
    const tasks = taskTools(db);
    const taskId = (globalThis as Record<string, unknown>)['testTaskId'] as string;

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: taskId,
      status: 'running',
      commit_sha: 'abc',
    });
    assert.ok(result.isError, 'Should reject SHA shorter than 7 chars');

    const getResult = await call(tasks.handlers, 'task_get', {
      agent: 'bro',
      task_id: taskId,
    });
    const row = parseResult(getResult);
    assert.equal(row.status, 'completed', 'Status must NOT have changed');
  });

  it('step 6c: task_update_status leaves commit_sha null when the caller omits it', async () => {
    const tasks = taskTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const batchResult = await call(tasks.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: issueId,
      tasks: [
        {
          branch_id: 'feat/commit-sha-optional',
          description: 'Task that finishes without a commit_sha',
        },
      ],
    });
    const batchData = parseBatch(batchResult);
    const taskId2 = String(batchData[0]!.id);

    const result = await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: taskId2,
      status: 'completed',
    });
    const updated = parseResult(result);
    assert.ok(!result.isError, 'Call without commit_sha should succeed');
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
    assert.ok(content.includes('discussion integration test issue'), 'Must have issue objective');
    assert.ok(content.includes('We want to build the discussion tools'), 'Must include discussion body');
    assert.ok(content.includes('Approved. SWE will implement.'), 'Must include all discussion entries');
    assert.ok(content.includes('feat/discussions-integration'), 'Must include task branch_id');
    assert.ok(content.includes(sha), 'Must include commit_sha from the task row');
    assert.ok(
      content.includes('This is the spec body for the discussions task.'),
      'Must include spec_body content in per-task snapshot',
    );
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

  it('step 8c: issue_snapshot_md rejects path-traversal via .. (#361)', async () => {
    const reports = reportTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(reports.handlers, 'issue_snapshot_md', {
      agent: 'pr-reviewer',
      issue_id: issueId,
      output_path: 'docs/trustmybot/../../../etc/passwd',
    });
    assert.ok(result.isError, 'Should reject .. traversal path');
    const data = parseResult(result);
    assert.ok(data.error.includes('docs/trustmybot'), 'Error should mention scope restriction');
  });

  it('issue_get_with_discussions returns combined data in one call', async () => {
    const disc = discussionTools(db);
    const issueId = (globalThis as Record<string, unknown>)['testIssueId'] as string;

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
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

describe('discussion_append verified_human gate (#145)', () => {
  let db: TrajectoryDB;
  let issueId: string;

  before(async () => {
    db = tempDB();
    const issues = issueTools(db);

    async function call(
      handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
      name: string,
      args: Record<string, unknown>,
    ) {
      const handler = handlers[name];
      return handler(args) as unknown as RawResult;
    }

    const result = await call(issues.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'verified_human gate test issue',
      description: 'Isolated issue for gate tests.',
    });
    const created = JSON.parse((result as RawResult).content[0].text);
    issueId = String(created.id);
  });

  after(() => {
    db.close();
  });

  async function call(
    handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<RawResult> {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args) as unknown as RawResult;
  }

  it('rejects author="human" without verified_human', async () => {
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'human',
      kind: 'intent',
      body: 'This should be rejected',
    });
    assert.ok(result.isError, 'Should be error when author="human" without verified_human');
    const data = parseResult(result);
    assert.ok(
      data.error.includes('precondition_failed'),
      `Error must cite precondition_failed: ${data.error}`,
    );
    assert.ok(
      data.error.includes('verified_human=true'),
      `Error must mention verified_human=true: ${data.error}`,
    );
  });

  it('accepts author="human" with verified_human=true', async () => {
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'human',
      kind: 'intent',
      body: 'Verified human prompt capture',
      verified_human: true,
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(data.author, 'human');
  });

  it('accepts author="bro" without verified_human', async () => {
    const disc = discussionTools(db);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      kind: 'note',
      body: 'Per Human in chat: "@bro do the thing"',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(data.author, 'bro');
  });

  it('accepts consultant authors (ceo, cto, pm) without verified_human', async () => {
    const disc = discussionTools(db);

    for (const consultantAuthor of ['ceo', 'cto', 'pm']) {
      const result = await call(disc.handlers, 'discussion_append', {
        agent: 'bro',
        issue_id: issueId,
        author: consultantAuthor,
        kind: 'analysis',
        body: `${consultantAuthor} analysis entry`,
      });
      assert.ok(
        !result.isError,
        `author="${consultantAuthor}" must be accepted: ${JSON.stringify(parseResult(result))}`,
      );
    }
  });
});

describe('discussion_append body size cap (#219)', () => {
  let db: TrajectoryDB;
  let issueId: string;

  before(async () => {
    db = tempDB();
    const issues = issueTools(db);
    const result = await call(issues.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'body size cap test issue',
      description: 'Isolated issue for body cap tests.',
    });
    const created = parseResult(result as RawResult);
    issueId = String(created.id);
  });

  after(() => {
    db.close();
  });

  it('accepts body exactly at the 64KB cap', async () => {
    const disc = discussionTools(db);
    const body = 'a'.repeat(65_536);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      kind: 'note',
      body,
    });
    assert.ok(!result.isError, `Expected no error at cap: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(data.author, 'bro');
  });

  it('rejects body over 64KB with a named validation error (not a SQLite error)', async () => {
    const disc = discussionTools(db);
    const body = 'a'.repeat(65_537);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      kind: 'note',
      body,
    });
    assert.ok(result.isError, 'Should be error for oversized body');
    const data = parseResult(result);
    assert.ok(data.error.includes('64KB'), `Error must mention 64KB limit: ${data.error}`);
    assert.ok(data.error.includes('65537'), `Error must include byte count: ${data.error}`);
    assert.ok(!data.error.includes('SQLITE'), `Error must not be a SQLite error: ${data.error}`);
  });
});

describe('discussion_append default issue_id resolution (#506)', () => {
  it('omitting issue_id lands on the newest open issue', async () => {
    const localDb = tempDB();
    const issues = issueTools(localDb);
    const disc = discussionTools(localDb);

    const r1 = await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'older issue' });
    await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'newer issue' });
    const newerIssue = parseResult(await call(issues.handlers, 'issue_list', { agent: 'bro' }) as RawResult);
    const newerIssueId = String(Math.max(...(newerIssue as Array<{ id: number }>).map((x) => x.id)));

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      author: 'bro',
      kind: 'note',
      body: 'No issue_id supplied',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(String(data.issue_id), newerIssueId, 'Must land on the newest open issue');

    void r1;
    localDb.close();
  });

  it('omitting issue_id with no open issues falls back to -1', async () => {
    const localDb = tempDB();
    const disc = discussionTools(localDb);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      author: 'bro',
      kind: 'note',
      body: 'Fallback to system issue',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(data.issue_id, -1, 'Must fall back to -1 system issue when no open issues exist');

    localDb.close();
  });

  it('explicit issue_id is unchanged by the default logic', async () => {
    const localDb = tempDB();
    const issues = issueTools(localDb);
    const disc = discussionTools(localDb);

    await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'explicit issue' });
    const issueList = parseResult(await call(issues.handlers, 'issue_list', { agent: 'bro' }) as RawResult) as Array<{ id: number }>;
    const firstId = String(issueList[0].id);

    const result = await call(disc.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: firstId,
      author: 'bro',
      kind: 'note',
      body: 'Explicit issue_id must be honored',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const data = parseResult(result);
    assert.equal(String(data.issue_id), firstId, 'Explicit issue_id must pass through unchanged');

    localDb.close();
  });
});

describe('issue_get_with_discussions swe redaction (#344)', () => {
  it('swe sees redacted description in the issue field', async () => {
    const localDb = tempDB();
    const issues = issueTools(localDb);
    const disc = discussionTools(localDb);

    const createResult = await call(issues.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Redaction test issue',
      description: 'TOP SECRET: this description must be hidden from swe.',
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError, `issue_create failed: ${JSON.stringify(issue)}`);

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'swe',
      issue_id: String(issue.id),
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(data)}`);
    assert.ok(data.issue, 'issue field must be present');
    assert.equal(data.issue.description, undefined, 'swe must not see the description field');
    assert.ok(!('description' in data.issue), 'description must be absent from swe response');
    assert.ok(typeof data.issue.objective === 'string', 'objective must be present');

    localDb.close();
  });

  it('bro sees the full issue (not redacted) in issue_get_with_discussions', async () => {
    const localDb = tempDB();
    const issues = issueTools(localDb);
    const disc = discussionTools(localDb);

    const createResult = await call(issues.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Redaction test for bro',
      description: 'Full description visible to bro.',
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    const result = await call(disc.handlers, 'issue_get_with_discussions', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const data = parseResult(result);
    assert.ok(!result.isError);
    assert.ok(data.issue, 'issue field must be present');

    localDb.close();
  });
});
