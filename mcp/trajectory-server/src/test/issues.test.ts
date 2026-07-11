import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools, objectiveSimilarity } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { makeSpawnFn } from './sync-issue.test.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// Mandatory tagging (#93/#777): a valid issue_create must carry one
// classification + one priority label. Shared so existing cases stay valid.
const VALID_LABELS = ['Bug', 'Priority: High'];

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

// Issue-scoped sync (#155/#146) resolves the issue's repo to a `repos` row and
// reads that row's `remotes` to pick the explicit gh --repo / glab -R target.
// Register a single repo so the sole-repo fallback resolves and the remotes are
// available; with exactly one repos row the issue inherits it at create time.
function registerSoleRepo(
  db: ReturnType<typeof tempDB>,
  remotes: Array<{ name?: string; provider: string; url: string }> = [
    { name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' },
    { name: 'origin', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' },
  ],
): void {
  db.run(
    `INSERT INTO repos (name, path, remotes) VALUES ('app', '/tmp/app', ?)`,
    [JSON.stringify(remotes)],
  );
}

describe('issueTools', () => {
  it('create then get returns the created issue', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Build feature X',
      labels: VALID_LABELS,
      description: '# Requirements\n- Do X',
    });
    const created = parseResult(createResult);
    assert.ok(!createResult.isError, `Expected no error, got: ${created.error}`);
    assert.equal(created.objective, 'Build feature X');
    assert.equal(created.status, 'open');

    const getResult = await call(tools.handlers, 'issue_get', {
      agent: 'bro',
      issue_id: String(created.id),
      include_description: true,
    });
    const fetched = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.description, '# Requirements\n- Do X');

    db.close();
  });

  it('issue_get with include_description=false omits description', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Test redaction',
      labels: VALID_LABELS,
      description: 'secret description',
    });
    const created = parseResult(createResult);

    const getResult = await call(tools.handlers, 'issue_get', {
      agent: 'bro',
      issue_id: String(created.id),
      include_description: false,
    });
    const fetched = parseResult(getResult);
    assert.ok(!('description' in fetched), 'description should be omitted when include_description=false');

    db.close();
  });

  it('issue_resume returns the issue and first pending task', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const { taskTools } = await import('../tools/tasks.js');
    const tTools = taskTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Resume test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    await call(tTools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issue.id),
      tasks: [
        { branch_id: 'feat/first-task', description: 'First task' },
        { branch_id: 'feat/second-task', description: 'Second task' },
      ],
    });

    const resumeResult = await call(tools.handlers, 'issue_resume', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const resumed = parseResult(resumeResult);
    assert.ok(!resumeResult.isError);
    assert.equal(resumed.issue.id, issue.id);
    assert.ok(resumed.next_task !== null);
    assert.equal(resumed.next_task.branch_id, 'feat/first-task');

    db.close();
  });

  it('issue_close sets status to closed', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Close test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'bro',
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
      agent: 'bro',
      objective: 'Phase test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    await call(tTools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issue.id),
      tasks: [
        { branch_id: 'feat/task-1', description: 'Task 1' },
        { branch_id: 'feat/task-2', description: 'Task 2' },
      ],
    });

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'bro',
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
      agent: 'bro',
      issue_id: '99999',
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Should be an error result');
    assert.match(data.error, /Not found/);

    db.close();
  });
});

describe('issueTools — gh_iid + gl_iid tri-source', () => {
  it('issue_create with issue_sync=gh populates gh_iid from remote', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'tri-source gh create',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{
        status: 0,
        stdout: 'https://github.com/owner/repo/issues/77\n',
        stderr: '',
      }, {
        status: 0,
        stdout: '{"number":77,"url":"https://github.com/owner/repo/issues/77"}',
        stderr: '',
      }]),
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 77);
    assert.equal(issue.remote_kind, 'github');

    const row = db.get<{ gh_iid: number | null; gl_iid: number | null }>(
      'SELECT gh_iid, gl_iid FROM issues WHERE id = ?',
      [issue.id],
    );
    assert.equal(row?.gh_iid, 77, 'gh_iid must be set after gh sync');
    assert.equal(row?.gl_iid, null, 'gl_iid must remain null for gh-only sync');

    db.close();
  });

  it('issue_create with issue_sync=glab populates gl_iid from remote', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'glab',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'tri-source glab create',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{
        status: 0,
        stdout: 'https://gitlab.com/owner/repo/-/issues/55\n',
        stderr: '',
      }, {
        status: 0,
        stdout: 'issue 55 details',
        stderr: '',
      }]),
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 55);
    assert.equal(issue.remote_kind, 'gitlab');

    const row = db.get<{ gh_iid: number | null; gl_iid: number | null }>(
      'SELECT gh_iid, gl_iid FROM issues WHERE id = ?',
      [issue.id],
    );
    assert.equal(row?.gh_iid, null, 'gh_iid must remain null for glab-only sync');
    assert.equal(row?.gl_iid, 55, 'gl_iid must be set after glab sync');

    db.close();
  });

  it('issue_close mirrors to gh when gh_iid is set', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'tri-source close gh',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    db.run(
      `UPDATE issues SET gh_iid = 101, remote_iid = 101, remote_kind = 'github' WHERE id = ?`,
      [issue.id],
    );

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: makeSpawnFn([{ status: 0, stdout: '', stderr: '' }]),
    });
    const closed = parseResult(closeResult);
    assert.ok(!closeResult.isError, 'issue_close should succeed with gh_iid set');
    assert.equal(closed.status, 'closed');

    db.close();
  });

  it('issue_close mirrors to gl when gl_iid is set', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'tri-source close gl',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    db.run(
      `UPDATE issues SET gl_iid = 202, remote_iid = 202, remote_kind = 'gitlab' WHERE id = ?`,
      [issue.id],
    );

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: makeSpawnFn([{ status: 0, stdout: '', stderr: '' }]),
    });
    const closed = parseResult(closeResult);
    assert.ok(!closeResult.isError, 'issue_close should succeed with gl_iid set');
    assert.equal(closed.status, 'closed');

    db.close();
  });
});

describe('issueTools — remote sync', () => {
  it('issue_create with issue_sync=off skips sync, no remote fields set', async () => {
    const db = tempDB();
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'off',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Test off sync',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);
    assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync is off');
    assert.equal(created.remote_kind ?? null, null, 'remote_kind should be null when sync is off');

    db.close();
  });

  it('issue_create with issue_sync=gh, remote fails → local insert succeeds', async () => {
    const db = tempDB();
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Test gh sync failure fallback',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated gh auth error' }]),
    });
    const created = parseResult(result);
    assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
    assert.equal(created.objective, 'Test gh sync failure fallback');
    assert.equal(created.status, 'open');
    assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync fails');

    db.close();
  });

  it('issue_create with issue_sync=glab, remote fails → local insert succeeds', async () => {
    const db = tempDB();
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'glab',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Test glab sync failure fallback',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated glab auth error' }]),
    });
    const created = parseResult(result);
    assert.ok(!result.isError, 'Local insert must succeed even when remote fails');
    assert.equal(created.objective, 'Test glab sync failure fallback');
    assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when sync fails');

    db.close();
  });

  it('issue_create with issue_sync=auto and nothing available → null sync, local insert succeeds', async () => {
    const db = tempDB();
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'auto',
    });
    const tools = issueTools(db);

    // _spawnFn guards against real remote calls if a backend is detected in this environment
    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Test auto with no remote',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated no-remote failure' }]),
    });
    const created = parseResult(result);
    assert.ok(!result.isError, 'Local insert must succeed even when no backend available');
    assert.equal(created.objective, 'Test auto with no remote');
    assert.equal(created.remote_iid ?? null, null, 'remote_iid should be null when no backend resolves');

    db.close();
  });

  it('issue_close with no remote_iid skips remote close', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Close without remote',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const closed = parseResult(closeResult);
    assert.ok(!closeResult.isError, 'issue_close should succeed when no remote_iid');
    assert.equal(closed.status, 'closed');

    db.close();
  });

  it('issue_close mirrors to remote when remote_iid is set', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Close with remote',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    db.run(
      `UPDATE issues SET remote_iid = 99, remote_kind = 'github' WHERE id = ?`,
      [issue.id],
    );

    const closeResult = await call(tools.handlers, 'issue_close', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated remote close failure' }]),
    });
    const closed = parseResult(closeResult);
    assert.ok(!closeResult.isError, 'issue_close should be non-fatal even if remote close fails');
    assert.equal(closed.status, 'closed');

    db.close();
  });

  it('issue_sync_retry is forbidden to swe', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'swe',
      issue_id: '1',
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'swe should be forbidden from issue_sync_retry');
    assert.equal(data.error, 'forbidden');

    db.close();
  });

  it('issue_create with successful sync bumps updated_at (regression: Bug 2)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const before = new Date().toISOString();

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'updated_at regression',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([{
        status: 0,
        stdout: 'https://github.com/owner/repo/issues/42\n',
        stderr: '',
      }, {
        status: 0,
        stdout: '{"number":42,"url":"https://github.com/owner/repo/issues/42"}',
        stderr: '',
      }]),
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 42, 'remote_iid should be set after successful sync');

    const row = db.get<{ updated_at: string; remote_iid: number }>(
      `SELECT updated_at, remote_iid FROM issues WHERE id = ?`,
      [issue.id],
    );
    assert.ok(row, 'issue row must exist');
    assert.equal(row!.remote_iid, 42, 'remote_iid must be persisted');
    assert.ok(
      row!.updated_at >= before,
      `updated_at must be set on successful remote_iid UPDATE, got: ${row!.updated_at}`,
    );

    db.close();
  });

  it('issue_sync_retry returns skipped when issue_sync=off', async () => {
    const db = tempDB();
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'off',
    });
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Retry test off',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const data = parseResult(retryResult);
    assert.ok(!retryResult.isError);
    assert.equal(data.skipped, true);

    db.close();
  });

  it('issue_get_phase returns ready_to_close when all tasks completed and issue open', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Phase regression test issue',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-a', 'main', '', 'task a', 'completed', 0, '', NULL, datetime('now'), datetime('now'))`,
      [issue.id],
    );

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const phaseData = parseResult(phaseResult);
    assert.ok(!phaseResult.isError, `Expected no error: ${JSON.stringify(phaseData)}`);
    assert.equal(phaseData.phase, 'ready_to_close', `Expected ready_to_close, got ${phaseData.phase}`);
    assert.equal(phaseData.counts.tasks_total, 1);
    assert.equal(phaseData.counts.tasks_completed, 1);

    db.close();
  });

  it('issue_get_phase returns tasks when some tasks still pending', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Phase tasks regression test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-b', 'main', '', 'task b', 'completed', 0, '', NULL, datetime('now'), datetime('now'))`,
      [issue.id],
    );
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-c', 'main', '', 'task c', 'pending', 0, '', NULL, datetime('now'), datetime('now'))`,
      [issue.id],
    );

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const phaseData = parseResult(phaseResult);
    assert.ok(!phaseResult.isError);
    assert.equal(phaseData.phase, 'tasks', `Expected tasks, got ${phaseData.phase}`);

    db.close();
  });

  it('issue_get_phase counts closed tasks as done — ready_to_close after bro_atomic_close (#357)', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Closed-task phase regression test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, repo, created_at, updated_at)
       VALUES (?, 'feat/task-closed', 'main', '', 'closed task', 'closed', 0, '', NULL, datetime('now'), datetime('now'))`,
      [issue.id],
    );

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const phaseData = parseResult(phaseResult);
    assert.ok(!phaseResult.isError, `Expected no error: ${JSON.stringify(phaseData)}`);
    assert.equal(phaseData.phase, 'ready_to_close', `Expected ready_to_close for closed task, got ${phaseData.phase}`);
    assert.equal(phaseData.counts.tasks_total, 1);
    assert.equal(phaseData.counts.tasks_completed, 1, 'Closed task must count as completed');

    db.close();
  });

  it('issue_get_phase returns 0 not null for zero-task issues (#357)', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Zero-task phase null-check test',
      labels: VALID_LABELS,
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    const phaseResult = await call(tools.handlers, 'issue_get_phase', {
      agent: 'bro',
      issue_id: String(issue.id),
    });
    const phaseData = parseResult(phaseResult);
    assert.ok(!phaseResult.isError, `Expected no error: ${JSON.stringify(phaseData)}`);
    assert.equal(phaseData.counts.tasks_total, 0);
    assert.equal(phaseData.counts.tasks_completed, 0, 'tasks_completed must be 0 not null for zero-task issues');
    assert.equal(phaseData.counts.tasks_failed, 0, 'tasks_failed must be 0 not null for zero-task issues');

    db.close();
  });
});

describe('issueTools — issue-sync hardening (#314)', () => {
  it('blank remote URL in remotes config → sync skipped with diagnostic', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: '' }]);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const noCallSpawn = makeSpawnFn([]);
    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'blank URL sync skip test',
      labels: VALID_LABELS,
      _spawnFn: noCallSpawn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid ?? null, null, 'remote_iid must be null when URL is blank');
    assert.ok(issue._sync, 'sync diagnostic must be present');
    assert.equal(issue._sync.sync_skipped, true, 'sync_skipped must be true');
    assert.equal(issue._sync.reason, 'blank_remote_url');

    db.close();
  });

  it('read-back returns PR url → no gh_iid persisted, diagnostic surfaced (#314)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'verify_failed PR test',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([
        {
          status: 0,
          stdout: 'https://github.com/owner/repo/issues/30\n',
          stderr: '',
        },
        {
          status: 0,
          stdout: '{"number":30,"url":"https://github.com/owner/repo/pull/30"}',
          stderr: '',
        },
      ]),
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, 'local insert must succeed even when verify fails');
    assert.equal(issue.remote_iid ?? null, null, 'remote_iid must NOT be persisted when verify_failed');

    const row = db.get<{ gh_iid: number | null }>(
      'SELECT gh_iid FROM issues WHERE id = ?',
      [issue.id],
    );
    assert.equal(row?.gh_iid ?? null, null, 'gh_iid must NOT be persisted when read-back shows PR');
    assert.ok(issue._sync, 'sync diagnostic must be present');
    assert.equal(issue._sync.sync_failed, true);
    assert.equal(issue._sync.reason, 'verify_failed');

    db.close();
  });
});

describe('issue_link (#336)', () => {
  it('records gh_iid for a manually-mirrored issue', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'manual mirror', labels: VALID_LABELS });
    const issue = parseResult(createResult);

    const linkResult = await call(tools.handlers, 'issue_link', {
      agent: 'bro',
      issue_id: String(issue.id),
      backend: 'github',
      iid: 99,
    });
    const linked = parseResult(linkResult);
    assert.ok(!linkResult.isError, `Expected no error: ${JSON.stringify(linked)}`);
    assert.equal(linked.linked, true);
    assert.equal(linked.backend, 'github');
    assert.equal(linked.iid, 99);

    const row = db.get<{ gh_iid: number | null; remote_iid: number | null; remote_kind: string | null }>(
      'SELECT gh_iid, remote_iid, remote_kind FROM issues WHERE id = ?', [issue.id],
    );
    assert.equal(row?.gh_iid, 99);
    assert.equal(row?.remote_iid, 99);
    assert.equal(row?.remote_kind, 'github');

    db.close();
  });

  it('rejects double-link without force=true', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'double link test', labels: VALID_LABELS });
    const issue = parseResult(createResult);

    await call(tools.handlers, 'issue_link', { agent: 'bro', issue_id: String(issue.id), backend: 'github', iid: 42 });

    const second = await call(tools.handlers, 'issue_link', {
      agent: 'bro', issue_id: String(issue.id), backend: 'github', iid: 99,
    });
    assert.ok(second.isError, 'second link without force must be rejected');
    const msg = parseResult(second as RawResult);
    assert.ok((msg.error as string).includes('already_linked'));

    db.close();
  });

  it('allows overwrite with force=true', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'force link test', labels: VALID_LABELS });
    const issue = parseResult(createResult);

    await call(tools.handlers, 'issue_link', { agent: 'bro', issue_id: String(issue.id), backend: 'github', iid: 42 });

    const overwrite = await call(tools.handlers, 'issue_link', {
      agent: 'bro', issue_id: String(issue.id), backend: 'github', iid: 99, force: true,
    });
    assert.ok(!overwrite.isError);
    const row = db.get<{ gh_iid: number | null }>('SELECT gh_iid FROM issues WHERE id = ?', [issue.id]);
    assert.equal(row?.gh_iid, 99);

    db.close();
  });

  it('emits issue_linked audit row on success', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'audit test', labels: VALID_LABELS });
    const issue = parseResult(createResult);

    await call(tools.handlers, 'issue_link', { agent: 'bro', issue_id: String(issue.id), backend: 'gitlab', iid: 77 });

    const auditRow = db.get<{ event_type: string; summary: string }>(
      `SELECT event_type, summary FROM audit WHERE issue_id = ? AND event_type = 'issue_linked'`,
      [issue.id],
    );
    assert.ok(auditRow, 'audit row must exist');
    assert.equal(auditRow.event_type, 'issue_linked');
    assert.ok(auditRow.summary.includes('77'));

    db.close();
  });

  it('rejects swe caller', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'role guard test', labels: VALID_LABELS });
    const issue = parseResult(createResult);

    const result = await call(tools.handlers, 'issue_link', {
      agent: 'swe', issue_id: String(issue.id), backend: 'github', iid: 10,
    });
    assert.ok(result.isError, 'swe must be forbidden from issue_link');

    db.close();
  });
});

describe('issue_sync_retry — partial create only missing backend (#345)', () => {
  it('returns already_synced when all backends have iids set', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'both' });
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'already synced test',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([
        { status: 1, stdout: '', stderr: 'simulated gh create failure' },
        { status: 1, stdout: '', stderr: 'simulated glab create failure' },
      ]),
    });
    const issue = parseResult(createResult);

    db.run('UPDATE issues SET gh_iid = 10, gl_iid = 20, remote_iid = 10, remote_kind = ? WHERE id = ?', ['github', issue.id]);

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: makeSpawnFn([]),
    });
    const data = parseResult(retryResult);
    assert.ok(!retryResult.isError);
    assert.equal(data.skipped, true);
    assert.equal(data.reason, 'already_synced');

    db.close();
  });

  it('gh_iid preserved after retry when gh already synced', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'both' });
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'partial sync gh done',
      labels: VALID_LABELS,
      _spawnFn: makeSpawnFn([
        { status: 1, stdout: '', stderr: 'simulated gh create failure' },
        { status: 1, stdout: '', stderr: 'simulated glab create failure' },
      ]),
    });
    const issue = parseResult(createResult);

    db.run('UPDATE issues SET gh_iid = 55, remote_iid = 55, remote_kind = ? WHERE id = ?', ['github', issue.id]);

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: makeSpawnFn([
        { status: 0, stdout: 'https://gitlab.com/owner/repo/-/issues/20\n', stderr: '' },
        { status: 0, stdout: 'issue 20 details', stderr: '' },
      ]),
    });
    assert.ok(!retryResult.isError, 'retry must not error');

    const rowAfter = db.get<{ gh_iid: number | null }>('SELECT gh_iid FROM issues WHERE id = ?', [issue.id]);
    assert.equal(rowAfter?.gh_iid, 55, 'gh_iid must not be overwritten by retry');

    db.close();
  });
});

describe('issue_sync_retry — milestone + valid labels (#1028)', () => {
  it('retry create carries the persisted milestone and a valid label set', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    // Create with the initial gh create failing so gh_iid stays null → retryable.
    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'retry milestone + labels',
      labels: VALID_LABELS,
      milestone: 'v0.10.0',
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated gh create failure' }]),
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError, `create should succeed locally: ${issue.error}`);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":88,"url":"https://github.com/owner/repo/issues/88"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/88\n', stderr: '' };
    };

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: spawnFn,
    });
    const data = parseResult(retryResult);
    assert.ok(!retryResult.isError, `retry should not error: ${JSON.stringify(data)}`);

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall !== undefined, 'gh issue create must run on retry');

    const mIdx = createCall.args.indexOf('--milestone');
    assert.ok(mIdx >= 0, 'retry create must include --milestone (not undefined)');
    assert.equal(createCall.args[mIdx + 1], 'v0.10.0');

    // A valid label set: at least one classification + one priority default,
    // never labels:[] (which a tagging-enforced remote would reject).
    const labelValues: string[] = [];
    for (let i = 0; i < createCall.args.length; i++) {
      if (createCall.args[i] === '--label') labelValues.push(createCall.args[i + 1]!);
    }
    assert.ok(labelValues.length >= 2, `retry create must supply labels, got: ${JSON.stringify(labelValues)}`);
    assert.ok(labelValues.includes('Bug'), 'default classification label present');
    assert.ok(
      labelValues.some((l) => l.startsWith('Priority: ')),
      `a priority label present, got: ${JSON.stringify(labelValues)}`,
    );

    db.close();
  });
});

describe('issue_create persists labels on the row (#53)', () => {
  it('stores the validated label set verbatim as a JSON array string', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'persist the labels',
      labels: ['Improvement', 'Priority: Low'],
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError, `create should succeed: ${issue.error}`);

    const row = db.get<{ labels: string | null }>('SELECT labels FROM issues WHERE id = ?', [
      issue.id,
    ]);
    assert.equal(
      row!.labels,
      JSON.stringify(['Improvement', 'Priority: Low']),
      'issue_create must persist the validated label set verbatim',
    );

    db.close();
  });
});

describe('issue_sync_retry replays the persisted label set (#53)', () => {
  it('sends the original labels, not the derived defaultSyncLabels pair', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    // Create with labels that differ from defaultSyncLabels (Bug + Priority:
    // Urgent) so a replay is distinguishable from a re-derivation. The observed
    // bug: [Improvement, Priority: Low] silently retried as [Bug, Priority: Urgent].
    // The gh create fails so gh_iid stays null → retryable.
    const createResult = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'replay the original labels',
      labels: ['Improvement', 'Priority: Low'],
      _spawnFn: makeSpawnFn([{ status: 1, stdout: '', stderr: 'simulated gh create failure' }]),
    });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError, `create should succeed locally: ${issue.error}`);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":88,"url":"https://github.com/owner/repo/issues/88"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/88\n', stderr: '' };
    };

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issue.id),
      _spawnFn: spawnFn,
    });
    assert.ok(!retryResult.isError, 'retry must not error');

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall !== undefined, 'gh issue create must run on retry');
    const labelValues: string[] = [];
    for (let i = 0; i < createCall.args.length; i++) {
      if (createCall.args[i] === '--label') labelValues.push(createCall.args[i + 1]!);
    }
    assert.deepEqual(
      labelValues,
      ['Improvement', 'Priority: Low'],
      'retry must replay the persisted labels, not the derived defaults',
    );
    assert.ok(!labelValues.includes('Bug'), 'must not substitute the default classification');

    db.close();
  });
});

describe('issue_sync_retry on a legacy NULL-labels row (#53)', () => {
  it('falls back to defaultSyncLabels when row.labels is NULL', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    // A pre-v28 row: inserted directly with NULL labels (no issue_create persist).
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo, labels)
       VALUES (?, '', 'open', datetime('now'), datetime('now'), 'app', NULL)`,
      ['legacy null-labels row'],
    );
    const issueId = db.get<{ id: number }>('SELECT id FROM issues WHERE objective = ?', [
      'legacy null-labels row',
    ])!.id;

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":90,"url":"https://github.com/owner/repo/issues/90"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/90\n', stderr: '' };
    };

    const retryResult = await call(tools.handlers, 'issue_sync_retry', {
      agent: 'bro',
      issue_id: String(issueId),
      _spawnFn: spawnFn,
    });
    assert.ok(!retryResult.isError, 'retry must not error');

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall !== undefined, 'gh issue create must run on retry');
    const labelValues: string[] = [];
    for (let i = 0; i < createCall.args.length; i++) {
      if (createCall.args[i] === '--label') labelValues.push(createCall.args[i + 1]!);
    }
    assert.deepEqual(
      labelValues,
      ['Bug', 'Priority: Urgent'],
      'a NULL-labels legacy row falls back to defaultSyncLabels',
    );

    db.close();
  });
});

describe('issue_create sync_skipped audit marker (#336)', () => {
  it('writes sync_skipped audit row when issue_sync=off', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const createResult = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'off sync test', labels: VALID_LABELS });
    const issue = parseResult(createResult);
    assert.ok(!createResult.isError);

    const auditRow = db.get<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ? AND event_type = 'sync_skipped'`,
      [issue.id],
    );
    assert.ok(auditRow, 'sync_skipped audit row must exist when issue_sync=off');
    assert.equal(auditRow.event_type, 'sync_skipped');

    db.close();
  });
});

describe('issue_create mandatory tagging (#93/#777)', () => {
  it('accepts a classification + priority label', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'tagged correctly',
      labels: ['Feature', 'Priority: Medium'],
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.objective, 'tagged correctly');
    assert.equal(issue.status, 'open');

    db.close();
  });

  it('rejects when no priority label is present', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'missing priority',
      labels: ['Bug'],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'must reject when no priority label');
    assert.match(data.error, /missing_required_labels/);
    assert.match(data.error, /priority label/);

    db.close();
  });

  it('rejects when only a priority label and no classification', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'missing classification',
      labels: ['Priority: High'],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'must reject when no classification label');
    assert.match(data.error, /missing_required_labels/);
    assert.match(data.error, /classification label/);

    db.close();
  });

  it('rejects when labels arg is omitted entirely', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'no labels at all',
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'must reject when labels omitted (fail closed)');
    assert.match(data.error, /missing_required_labels/);

    db.close();
  });

  it('accepts the generic default classification + priority labels when config is unset', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    for (const classification of ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore']) {
      const result = await call(tools.handlers, 'issue_create', {
        agent: 'bro',
        objective: `generic ${classification}`,
        labels: [classification, 'Priority: Low'],
      });
      assert.ok(!result.isError, `default classification ${classification} must be accepted`);
    }

    db.close();
  });

  it('rejects a TMB-specific legacy label that is no longer in the generic default', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'legacy doctrine label',
      labels: ['Doctrine', 'Priority: High'],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Doctrine is no longer a shipped default classification');
    assert.match(data.error, /missing_required_labels/);
    assert.match(data.error, /classification label/);

    db.close();
  });

  it('honors a project-configured classification set via plugin_config', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const cfg = configTools(db);

    await call(cfg.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_classification_labels',
      value: ['Doctrine', 'Roundtable'],
    });

    const accepted = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'configured classification accepted',
      labels: ['Doctrine', 'Priority: High'],
    });
    assert.ok(!accepted.isError, 'configured classification label must be accepted');

    const rejected = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'default classification rejected once overridden',
      labels: ['Bug', 'Priority: High'],
    });
    const data = parseResult(rejected);
    assert.ok(rejected.isError, 'Bug is not in the configured set, so it must be rejected');
    assert.match(data.error, /Doctrine, Roundtable/);

    db.close();
  });

  it('honors a project-configured priority set via plugin_config', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const cfg = configTools(db);

    await call(cfg.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_priority_labels',
      value: ['P0', 'P1', 'P2'],
    });

    const accepted = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'configured priority accepted',
      labels: ['Bug', 'P1'],
    });
    assert.ok(!accepted.isError, 'configured priority label must be accepted');

    const rejected = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'default priority rejected once overridden',
      labels: ['Bug', 'Priority: High'],
    });
    const data = parseResult(rejected);
    assert.ok(rejected.isError, 'Priority: High is not in the configured set, so it must be rejected');
    assert.match(data.error, /P0, P1, P2/);

    db.close();
  });
});

describe('issueTools — milestone (#83/#763)', () => {
  it('issue_create persists the milestone on the row', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'milestone-bound issue',
      labels: VALID_LABELS,
      milestone: 'v0.10.0',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);
    assert.equal(created.milestone, 'v0.10.0', 'milestone returned on created issue');

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, 'v0.10.0', 'milestone persisted on the row');

    db.close();
  });

  it('issue_create without milestone leaves it NULL', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'no milestone issue',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, null, 'milestone NULL when omitted');

    db.close();
  });

  it('issue_create passes the milestone to the gh sync command', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', {
      agent: 'bro',
      key: 'issue_sync',
      value: 'gh',
    });
    const tools = issueTools(db);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":7,"url":"https://github.com/owner/repo/issues/7"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/7\n', stderr: '' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'sync milestone to gh',
      labels: VALID_LABELS,
      milestone: 'v0.10.0',
      _spawnFn: spawnFn,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const createCall = calls.find((c) => c.args[1] === 'create');
    assert.ok(createCall !== undefined, 'gh issue create must have been called');
    const mIdx = createCall.args.indexOf('--milestone');
    assert.ok(mIdx >= 0, 'gh create must include --milestone');
    assert.equal(createCall.args[mIdx + 1], 'v0.10.0');

    db.close();
  });
});

describe('issueTools — per-repo open-milestone default (#15)', () => {
  it('defaults milestone to the issue repo\'s sole OPEN milestone when omitted', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'omitted milestone defaults to the sole open milestone',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, 'v0.10.0', 'sole open milestone applied');

    db.close();
  });

  it('explicit milestone arg overrides the per-repo default and upserts (name, repo)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'explicit milestone wins over the per-repo default',
      labels: VALID_LABELS,
      milestone: 'v0.11.0',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, 'v0.11.0', 'explicit arg wins');
    const ms = db.get<{ name: string }>(
      `SELECT name FROM milestones WHERE name = 'v0.11.0' AND repo = 'app'`,
    );
    assert.ok(ms, 'explicit milestone (name, repo) row upserted');

    db.close();
  });

  it('stays NULL when the repo has zero open milestones', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'no open milestone stays null',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, null, 'zero open milestones → null');

    db.close();
  });

  it('stays NULL when the repo has more than one open milestone (ambiguous)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.11.0', 'app', 'open')`);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'two open milestones is ambiguous → null',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, null, '>1 open milestones → null');

    db.close();
  });

  it('ignores a non-open milestone and does not create a row on the default path', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.9.0', 'app', 'closed')`);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'closed milestone is not a default',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, null, 'a closed milestone is not auto-defaulted');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM milestones`);
    assert.equal(count?.n, 1, 'default path created no new milestones row');

    db.close();
  });

  it('stays NULL when no repo is registered (null repo)', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'null repo yields null milestone',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null; repo: string | null }>(
      'SELECT milestone, repo FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.repo, null, 'no repos registered → null repo');
    assert.equal(row?.milestone, null, 'null repo → null milestone');

    db.close();
  });
});

describe('issueTools — explicit-milestone auto-create (#985)', () => {
  it('auto-creates the milestones row for an explicit unknown milestone (no FK error)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'explicit unknown milestone auto-created',
      labels: VALID_LABELS,
      milestone: 'v9.9.9',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no FK error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null; repo: string | null }>(
      'SELECT milestone, repo FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, 'v9.9.9', 'explicit milestone persisted');
    assert.equal(row?.repo, 'app');
    const ms = db.get<{ name: string; repo: string }>(
      `SELECT name, repo FROM milestones WHERE name = 'v9.9.9' AND repo = 'app'`,
    );
    assert.ok(ms, 'milestones row auto-created for the explicit milestone');

    db.close();
  });

  it('reuses an existing milestones row (no duplicate, no error)', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'explicit existing milestone reused',
      labels: VALID_LABELS,
      milestone: 'v0.10.0',
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, 'v0.10.0', 'explicit milestone persisted');
    const count = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM milestones WHERE name = 'v0.10.0' AND repo = 'app'`,
    );
    assert.equal(count?.n, 1, 'existing milestones row reused — no duplicate');

    db.close();
  });

  it('leaves milestone NULL (no row created) when omitted with no active config', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'omitted milestone unchanged',
      labels: VALID_LABELS,
    });
    const created = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${created.error}`);

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [created.id],
    );
    assert.equal(row?.milestone, null, 'milestone stays NULL when omitted');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM milestones`);
    assert.equal(count?.n, 0, 'no milestones row created for an omitted milestone');

    db.close();
  });
});

describe('issue_create dedup (#91/#775)', () => {
  it('objectiveSimilarity is a deterministic pure function pinning threshold behavior', () => {
    // Identical (ignoring case/punctuation) → 1.
    assert.equal(objectiveSimilarity('Fix the parser bug', 'fix the parser bug!'), 1);
    // Disjoint token sets → 0.
    assert.equal(objectiveSimilarity('apples oranges', 'rockets planets'), 0);
    // Token-set Jaccard: {a,b,c} vs {a,b,c,d} → 3/4 = 0.75 (>= 0.6).
    assert.equal(objectiveSimilarity('alpha beta gamma', 'alpha beta gamma delta'), 0.75);
    // {a,b} vs {a,b,c,d,e} → 2/5 = 0.4 (< 0.6).
    assert.equal(objectiveSimilarity('alpha beta', 'alpha beta gamma delta epsilon'), 0.4);
  });

  it('a closely-matching objective returns duplicate:true and does NOT insert', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const first = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
    });
    const firstIssue = parseResult(first);
    assert.ok(!first.isError);

    const dup = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add a dedup pre-check to issue_create!',
      labels: VALID_LABELS,
    });
    const dupResult = parseResult(dup);
    assert.ok(!dup.isError);
    assert.equal(dupResult.duplicate, true);
    assert.equal(dupResult.duplicate_of, firstIssue.id);
    assert.equal(dupResult.matched_objective, 'Add dedup pre-check to issue_create');
    assert.ok(dupResult.similarity >= 0.6);

    const count = db.get<{ n: number }>('SELECT COUNT(*) as n FROM issues WHERE id > 0');
    assert.equal(count?.n, 1, 'duplicate must not have inserted a second row');

    db.close();
  });

  it('allow_duplicate:true bypasses the check and creates normally', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const first = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
    });
    assert.ok(!first.isError);

    const second = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
      allow_duplicate: true,
    });
    const secondIssue = parseResult(second);
    assert.ok(!second.isError);
    assert.ok(!('duplicate' in secondIssue), 'allow_duplicate must create, not report a duplicate');
    assert.equal(secondIssue.status, 'open');

    const count = db.get<{ n: number }>('SELECT COUNT(*) as n FROM issues WHERE id > 0');
    assert.equal(count?.n, 2, 'allow_duplicate must insert a second row');

    db.close();
  });

  it('a clearly-distinct objective creates normally (no false positive)', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const first = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
    });
    assert.ok(!first.isError);

    const distinct = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Upgrade the kuzu world-model graph schema migration',
      labels: VALID_LABELS,
    });
    const distinctIssue = parseResult(distinct);
    assert.ok(!distinct.isError);
    assert.ok(!('duplicate' in distinctIssue), 'distinct objective must not be flagged a duplicate');
    assert.equal(distinctIssue.status, 'open');

    const count = db.get<{ n: number }>('SELECT COUNT(*) as n FROM issues WHERE id > 0');
    assert.equal(count?.n, 2, 'distinct objective must insert a second row');

    db.close();
  });

  it('a closed issue does not block a matching objective', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const first = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
    });
    const firstIssue = parseResult(first);
    await call(tools.handlers, 'issue_close', { agent: 'bro', issue_id: String(firstIssue.id) });

    const reopened = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'Add dedup pre-check to issue_create',
      labels: VALID_LABELS,
    });
    const reopenedIssue = parseResult(reopened);
    assert.ok(!reopened.isError);
    assert.ok(!('duplicate' in reopenedIssue), 'a closed match must not block a new open issue');

    db.close();
  });

  it('scopes dedup to the same repo — an equal objective in a different repo is not a duplicate (#1039)', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
    db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
    const tools = issueTools(db);

    const a = await call(tools.handlers, 'issue_create', {
      agent: 'bro', objective: 'Add dedup pre-check to issue_create', labels: VALID_LABELS, repo: 'frontend',
    });
    assert.ok(!a.isError, `first create errored: ${JSON.stringify(parseResult(a))}`);

    // Same objective in a DIFFERENT repo is distinct work — must not dedup.
    const other = await call(tools.handlers, 'issue_create', {
      agent: 'bro', objective: 'Add dedup pre-check to issue_create', labels: VALID_LABELS, repo: 'backend',
    });
    const otherIssue = parseResult(other);
    assert.ok(!other.isError);
    assert.ok(!('duplicate' in otherIssue), 'same objective in a different repo must not dedup');

    // Same objective in the SAME repo still dedups.
    const same = await call(tools.handlers, 'issue_create', {
      agent: 'bro', objective: 'Add dedup pre-check to issue_create', labels: VALID_LABELS, repo: 'frontend',
    });
    assert.equal(parseResult(same).duplicate, true, 'same objective in the same repo dedups');

    db.close();
  });
});

// A repos row with a single github remote so the adoption backend resolves
// unambiguously (registerSoleRepo defaults to both github + gitlab, which is
// ambiguous for a backend-less adopt).
function registerGithubRepo(db: ReturnType<typeof tempDB>): void {
  registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
}

describe('issue_create remote adoption (#36)', () => {
  it('adopts an existing remote at create: verifies, links, skips remote create', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":42,"title":"t","state":"OPEN"}', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'must not create remotely' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'adopt existing remote at create',
      labels: VALID_LABELS,
      remote_iid: 42,
      _spawnFn: spawnFn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.gh_iid, 42, 'gh_iid linked from adopted remote');
    assert.equal(issue.remote_kind, 'github');
    assert.equal(issue.remote_iid, 42);
    assert.deepEqual(issue._adopted, { backend: 'github', remote_iid: 42 });
    assert.ok(
      !calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create'),
      'adoption must skip the remote create',
    );

    const row = db.get<{ gh_iid: number | null; remote_kind: string | null }>(
      'SELECT gh_iid, remote_kind FROM issues WHERE id = ?',
      [issue.id],
    );
    assert.equal(row?.gh_iid, 42);
    assert.equal(row?.remote_kind, 'github');

    db.close();
  });

  it('honors an explicit remote_backend even when the repo has both remotes', async () => {
    const db = tempDB();
    registerSoleRepo(db); // both github + gitlab
    const tools = issueTools(db);

    const spawnFn = (cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: 'issue 88 details', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'must not create remotely' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'adopt explicit gitlab backend',
      labels: VALID_LABELS,
      remote_iid: 88,
      remote_backend: 'gitlab',
      _spawnFn: spawnFn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.gl_iid, 88);
    assert.equal(issue.remote_kind, 'gitlab');

    db.close();
  });

  it('nonexistent remote → named error, inserts nothing', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);

    const spawnFn = (cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'not found' };
      }
      return { status: 1, stdout: '', stderr: 'must not create remotely' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'adopt nonexistent remote',
      labels: VALID_LABELS,
      remote_iid: 999999,
      _spawnFn: spawnFn,
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'nonexistent remote must error');
    assert.match(data.error, /remote_verify_failed/);

    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues WHERE id > 0');
    assert.equal(count?.n, 0, 'a failed adoption must insert no issue row');

    db.close();
  });

  it('ambiguous backend (both remotes, no remote_backend) → named error, inserts nothing', async () => {
    const db = tempDB();
    registerSoleRepo(db); // both github + gitlab
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'adopt ambiguous backend',
      labels: VALID_LABELS,
      remote_iid: 5,
      _spawnFn: makeSpawnFn([]),
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'ambiguous backend must error');
    assert.match(data.error, /remote_backend_ambiguous/);

    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues WHERE id > 0');
    assert.equal(count?.n, 0, 'inserts nothing on ambiguous backend');

    db.close();
  });
});

describe('issue_adopt_remote (#36)', () => {
  async function createLocalIssue(
    tools: ReturnType<typeof issueTools>,
    objective: string,
  ): Promise<number> {
    const created = await call(tools.handlers, 'issue_create', { agent: 'bro', objective, labels: VALID_LABELS });
    return parseResult(created).id as number;
  }

  const viewOkSpawn = (cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: '{"number":42,"title":"t","state":"OPEN"}', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  it('links an existing local issue to a verified remote', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);
    const issueId = await createLocalIssue(tools, 'adopt-remote happy');

    const result = await call(tools.handlers, 'issue_adopt_remote', {
      agent: 'bro',
      issue_id: String(issueId),
      remote_iid: 42,
      _spawnFn: viewOkSpawn,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${data.error}`);
    assert.equal(data.adopted, true);
    assert.equal(data.backend, 'github');
    assert.equal(data.idempotent, false);

    const row = db.get<{ gh_iid: number | null; remote_iid: number | null; remote_kind: string | null }>(
      'SELECT gh_iid, remote_iid, remote_kind FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.gh_iid, 42);
    assert.equal(row?.remote_iid, 42);
    assert.equal(row?.remote_kind, 'github');

    const audit = db.get<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ? AND event_type = 'issue_adopted'`,
      [issueId],
    );
    assert.ok(audit, 'issue_adopted audit row must exist');

    db.close();
  });

  it('re-adopting the SAME iid is idempotent', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);
    const issueId = await createLocalIssue(tools, 'adopt-remote idempotent');

    await call(tools.handlers, 'issue_adopt_remote', { agent: 'bro', issue_id: String(issueId), remote_iid: 42, _spawnFn: viewOkSpawn });
    const second = await call(tools.handlers, 'issue_adopt_remote', { agent: 'bro', issue_id: String(issueId), remote_iid: 42, _spawnFn: viewOkSpawn });
    const data = parseResult(second);
    assert.ok(!second.isError, `idempotent re-adopt must succeed, got: ${data.error}`);
    assert.equal(data.idempotent, true);

    const row = db.get<{ gh_iid: number | null }>('SELECT gh_iid FROM issues WHERE id = ?', [issueId]);
    assert.equal(row?.gh_iid, 42);

    db.close();
  });

  it('adopting a DIFFERENT iid for a linked backend → conflict error', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);
    const issueId = await createLocalIssue(tools, 'adopt-remote conflict');

    await call(tools.handlers, 'issue_adopt_remote', { agent: 'bro', issue_id: String(issueId), remote_iid: 42, _spawnFn: viewOkSpawn });

    const conflictSpawn = (cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":43,"title":"t","state":"OPEN"}', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const conflict = await call(tools.handlers, 'issue_adopt_remote', { agent: 'bro', issue_id: String(issueId), remote_iid: 43, _spawnFn: conflictSpawn });
    const data = parseResult(conflict);
    assert.ok(conflict.isError, 'conflicting adopt must error');
    assert.match(data.error, /already_linked/);

    const row = db.get<{ gh_iid: number | null }>('SELECT gh_iid FROM issues WHERE id = ?', [issueId]);
    assert.equal(row?.gh_iid, 42, 'the original link is preserved on conflict');

    db.close();
  });

  it('nonexistent remote → named error, no link persisted', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const tools = issueTools(db);
    const issueId = await createLocalIssue(tools, 'adopt-remote missing');

    const missingSpawn = (cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'not found' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const result = await call(tools.handlers, 'issue_adopt_remote', { agent: 'bro', issue_id: String(issueId), remote_iid: 777, _spawnFn: missingSpawn });
    const data = parseResult(result);
    assert.ok(result.isError, 'nonexistent remote must error');
    assert.match(data.error, /remote_verify_failed/);

    const row = db.get<{ gh_iid: number | null }>('SELECT gh_iid FROM issues WHERE id = ?', [issueId]);
    assert.equal(row?.gh_iid ?? null, null, 'no link persisted on verification failure');

    db.close();
  });

  it('is forbidden to swe', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_adopt_remote', { agent: 'swe', issue_id: '1', remote_iid: 1 });
    assert.ok(result.isError, 'swe must be forbidden from issue_adopt_remote');
    assert.equal(parseResult(result).error, 'forbidden');
    db.close();
  });
});

describe('issue_create label pre-validation (#36)', () => {
  it('creates with the valid subset and surfaces the unknown labels as a warning', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'label' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify([{ name: 'Bug' }, { name: 'Priority: High' }]), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":7,"url":"https://github.com/owner/repo/issues/7"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/7\n', stderr: '' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'label split with one unknown',
      labels: ['Bug', 'Priority: High', 'nonexistent-label'],
      _spawnFn: spawnFn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 7, 'remote issue still created');
    assert.ok(issue._sync, 'label warning must surface');
    assert.deepEqual(issue._sync.labels_dropped, ['nonexistent-label']);
    assert.equal(issue._sync.reason, 'labels_not_in_remote_taxonomy');

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall, 'remote create must run');
    const labelValues: string[] = [];
    for (let i = 0; i < createCall.args.length; i++) {
      if (createCall.args[i] === '--label') labelValues.push(createCall.args[i + 1]!);
    }
    assert.deepEqual(labelValues.sort(), ['Bug', 'Priority: High'], 'remote create carries only the valid subset');
    assert.ok(!labelValues.includes('nonexistent-label'), 'unknown label must not reach the remote');

    db.close();
  });

  it('all-unknown labels still creates the remote issue with no labels + warning', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'label' && args[1] === 'list') {
        // Taxonomy exists but contains none of the requested labels.
        return { status: 0, stdout: JSON.stringify([{ name: 'unrelated' }]), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":9,"url":"https://github.com/owner/repo/issues/9"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/9\n', stderr: '' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'all labels unknown to remote',
      labels: ['Bug', 'Priority: High'],
      _spawnFn: spawnFn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 9, 'remote issue created even with an empty valid subset');
    assert.ok(issue._sync, 'warning surfaced');
    assert.deepEqual((issue._sync.labels_dropped as string[]).sort(), ['Bug', 'Priority: High']);

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall, 'remote create must run');
    assert.ok(!createCall.args.includes('--label'), 'no labels passed when the valid subset is empty');

    db.close();
  });

  it('taxonomy fetch failure → all labels pass through unchanged, no warning', async () => {
    const db = tempDB();
    registerGithubRepo(db);
    const cfgTools = configTools(db);
    await call(cfgTools.handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
    const tools = issueTools(db);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === 'label' && args[1] === 'list') {
        return { status: 1, stdout: '', stderr: 'taxonomy unavailable' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: '{"number":11,"url":"https://github.com/owner/repo/issues/11"}', stderr: '' };
      }
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/11\n', stderr: '' };
    };

    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'taxonomy fetch fails',
      labels: ['Bug', 'Priority: High', 'maybe-unknown'],
      _spawnFn: spawnFn,
    });
    const issue = parseResult(result);
    assert.ok(!result.isError, `Expected no error, got: ${issue.error}`);
    assert.equal(issue.remote_iid, 11);
    assert.ok(!issue._sync || issue._sync.reason !== 'labels_not_in_remote_taxonomy', 'no label warning when taxonomy is unavailable');

    const createCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.ok(createCall, 'remote create must run');
    const labelValues: string[] = [];
    for (let i = 0; i < createCall.args.length; i++) {
      if (createCall.args[i] === '--label') labelValues.push(createCall.args[i + 1]!);
    }
    assert.ok(labelValues.includes('maybe-unknown'), 'all labels pass through when taxonomy is unavailable');

    db.close();
  });
});
