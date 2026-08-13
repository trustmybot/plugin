import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { auditTools } from '../tools/audit.js';

// Each git fixture is its OWN sandbox under the OS temp dir — never inside the
// plugin tree / ambient cwd — so no git op can ever drift onto the caller's
// branch. `dir` is the absolute sandbox; every git op below targets it via
// `-C dir` or `cwd: dir`. `name` is the directory basename, kept for tests that
// register a repo by name.
function makeGitSubdir(label: string): { name: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `tmb-${label}-`));
  const name = dir.slice(dir.lastIndexOf('/') + 1);
  spawnSync('git', ['-C', dir, 'init'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
  return { name, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

function parseBatch(result: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(result.content[0].text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
}

async function createIssue(
  db: ReturnType<typeof tempDB>,
  objective = 'Test issue',
): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    labels: ['Bug', 'Priority: High'],
    agent: 'bro',
    objective,
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/task-one', description: 'Task one' },
        { branch_id: 'feat/task-two', description: 'Task two' },
        { branch_id: 'feat/task-three', description: 'Task three' },
      ],
    });

    const inserted = parseBatch(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    assert.ok(Array.isArray(inserted));
    assert.equal(inserted.length, 3);
    assert.equal(inserted[0].branch_id, 'feat/task-one');
    assert.equal(inserted[1].branch_id, 'feat/task-two');
    assert.equal(inserted[2].branch_id, 'feat/task-three');
    assert.ok(inserted.every((t) => (t as { status: string }).status === 'pending'));

    db.close();
  });

  it('task_update_status rejects unknown status', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/a-task', description: 'A task' }],
    });
    const tasks = parseBatch(batchResult);

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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/first', description: 'First' },
        { branch_id: 'feat/second', description: 'Second' },
        { branch_id: 'feat/third', description: 'Third' },
      ],
    });

    const allTasks = db.all<{ id: number; branch_id: string }>(
      'SELECT id, branch_id FROM tasks WHERE issue_id = ? ORDER BY branch_id',
      [issueId],
    );

    // SWE completes the first (completion is swe's transition, not bro's).
    await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
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

  it('task_update_status accepts every legal bro transition through the lifecycle (#278)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/lifecycle', description: 'lifecycle walk' }],
    });
    const taskId = String(parseBatch(batchResult)[0].id);

    const step = async (status: string) => {
      const result = await call(tools.handlers, 'task_update_status', {
        agent: 'bro', task_id: taskId, status,
      });
      const updated = parseResult(result);
      assert.ok(!result.isError, `Expected legal transition to "${status}": ${JSON.stringify(updated)}`);
      assert.equal(updated.status, status);
      return updated;
    };

    await step('running');           // pending → running
    await step('needs_validation');  // running → needs_validation
    const completed = await step('completed'); // needs_validation → completed
    assert.ok(completed.completed_at, 'completed sets completed_at');

    // 'closed' is reached only via bro_atomic_close (#1025); set it directly to
    // exercise the one remaining task_update_status edge out of closed.
    db.run("UPDATE tasks SET status = 'closed' WHERE id = ?", [Number(taskId)]);
    await step('escalated');         // closed → escalated (push-gate pushback)

    db.close();
  });

  it('task_update_status rejects illegal bro transitions and clears completed_at on reopen (#278)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const waivers = {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
    };
    const mk = async (branch: string): Promise<string> => {
      const r = await call(tools.handlers, 'task_create_batch', {
        ...waivers, agent: 'bro', issue_id: String(issueId),
        tasks: [{ branch_id: branch, description: 'x' }],
      });
      return String(parseBatch(r)[0]!.id);
    };

    // pending → closed is rejected: bro can't skip verification.
    const t1 = await mk('feat/illegal-close');
    const r1 = await call(tools.handlers, 'task_update_status', { agent: 'bro', task_id: t1, status: 'closed' });
    assert.ok(r1.isError, 'bro must not jump pending → closed');

    // pending → completed is rejected: bro can't fabricate completion.
    const t2 = await mk('feat/illegal-complete');
    const r2 = await call(tools.handlers, 'task_update_status', { agent: 'bro', task_id: t2, status: 'completed' });
    assert.ok(r2.isError, 'bro must not jump pending → completed');

    // Reopening out of 'completed' clears the stale completion stamp.
    const t3 = await mk('feat/reopen-clears-stamp');
    await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: t3, status: 'running' });
    const comp = parseResult(await call(tools.handlers, 'task_update_status', {
      agent: 'swe', task_id: t3, status: 'completed', commit_sha: 'abc1234',
    }));
    assert.ok(comp.completed_at, 'completed sets completed_at');
    const reopened = parseResult(await call(tools.handlers, 'task_update_status', {
      agent: 'bro', task_id: t3, status: 'needs_validation',
    }));
    assert.equal(reopened.completed_at, null, 'reopening out of completed clears completed_at');

    db.close();
  });

  it('task_create_batch accepts valid git-convention branch_id: feat/user-login', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/user-login', description: 'login feature' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'refactor/extract-helper', description: 'extract helper' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'Foo/Bar', description: 'bad' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/UPPERCASE', description: 'bad' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/-leading-hyphen', description: 'bad' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: '', description: 'bad' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/double//slash', description: 'bad' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/foo',
          parent_branch_id: 'bad value',
          description: 'bad parent',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-dev', parent_branch_id: 'dev', description: 'branches off dev' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-main', parent_branch_id: 'main', description: 'branches off main' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/from-master', parent_branch_id: 'master', description: 'branches off master' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/child-task', parent_branch_id: 'feat/foo', description: 'child of feat/foo' }],
    });
    const inserted = parseBatch(result);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/foo', parent_branch_id: 'random-junk', description: 'bad parent' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'dev', description: 'bad branch_id' }],
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test verbatim spec body; shape not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/spec-body-test',
          description: 'Test spec body storage',
          spec_body: specBody,
        },
      ],
    });
    const inserted = parseBatch(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);

    const thinResult = await call(tools.handlers, 'task_get', {
      agent: 'bro',
      task_id: String(inserted[0].id),
    });
    const thin = parseResult(thinResult);
    assert.ok(!thinResult.isError);
    assert.equal(thin.spec_body, undefined, 'task_get omits spec_body by default');

    const getResult = await call(tools.handlers, 'task_get', {
      agent: 'bro',
      task_id: String(inserted[0].id),
      include_spec_body: true,
    });
    const task = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(task.spec_body, specBody);

    db.close();
  });

  it('task_create_batch persists typed files[]/verification[] as JSON arrays', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/typed-fields',
          description: 'Typed Rails fields',
          files: ['src/foo.ts', 'tests/foo.test.ts'],
          verification: ['npm test', 'npm run lint'],
        },
      ],
    });
    const inserted = parseBatch(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);

    const row = db.get<{ files: string; verification: string }>(
      'SELECT files, verification FROM tasks WHERE id = ?',
      [inserted[0].id],
    );
    assert.deepEqual(JSON.parse(row!.files), ['src/foo.ts', 'tests/foo.test.ts']);
    assert.deepEqual(JSON.parse(row!.verification), ['npm test', 'npm run lint']);

    db.close();
  });

  it('task_create_batch defaults omitted files[]/verification[] to empty arrays', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/no-typed-fields', description: 'No typed fields' }],
    });
    const inserted = parseBatch(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);

    const row = db.get<{ files: string; verification: string }>(
      'SELECT files, verification FROM tasks WHERE id = ?',
      [inserted[0].id],
    );
    assert.equal(row!.files, '[]', 'omitted files[] defaults to empty array');
    assert.equal(row!.verification, '[]', 'omitted verification[] defaults to empty array');

    db.close();
  });

  it('task_create_batch rejects non-array files with a named typed_field_violation', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/bad-files', description: 'Bad files', files: 'src/foo.ts' as unknown as string[] },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /typed_field_violation/);
    assert.match(data.error, /'files' must be an array/);

    const count = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'feat/bad-files'`,
    );
    assert.equal(count?.c, 0, 'no task row may be written on a rejected shape');

    db.close();
  });

  it('task_create_batch rejects an empty files[] array (provide commands or omit the field)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/empty-files', description: 'Empty files', files: [] }],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /typed_field_violation/);
    assert.match(data.error, /non-empty array/);

    db.close();
  });

  it('task_create_batch rejects a verification[] entry that is not a non-empty string', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/bad-verify',
          description: 'Bad verify entry',
          verification: ['npm test', '   '],
        },
      ],
    });
    const data = parseResult(result);
    assert.ok(result.isError, 'Expected isError=true');
    assert.match(data.error, /typed_field_violation/);
    assert.match(data.error, /every 'verification' entry must be a non-empty string/);

    db.close();
  });

  it('task_create_batch without spec_body defaults to empty string', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-spec-body',
          description: 'No spec body',
        },
      ],
    });
    const inserted = parseBatch(batchResult);
    assert.ok(!batchResult.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].spec_body, undefined, 'thin batch return omits spec_body');

    const getResult = await call(tools.handlers, 'task_get', {
      agent: 'bro',
      task_id: String(inserted[0].id),
      include_spec_body: true,
    });
    const task = parseResult(getResult);
    assert.ok(!getResult.isError);
    assert.equal(task.spec_body, '');

    db.close();
  });

  it('task_create_batch rejects spec_body longer than 8000 chars (over-engineering guard)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const oversizeBody = 'x'.repeat(8001);
    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test oversized body; spec shape not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/oversize-spec',
          description: 'Oversize spec body',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/swe-guard-test', description: 'SWE guard test' },
      ],
    });
    const tasks = parseBatch(batchResult);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/swe-running-test', description: 'SWE running test' },
        { branch_id: 'feat/swe-completed-test', description: 'SWE completed test' },
        { branch_id: 'feat/swe-failed-test', description: 'SWE failed test' },
      ],
    });
    const tasks = parseBatch(batchResult);

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

  it('task_update_status blocks completed → closed (only bro_atomic_close closes) and allows reopen for re-validation (#278 #1025)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/bro-closed-test', description: 'Bro closed test' },
        { branch_id: 'feat/bro-needs-validation-test', description: 'Bro needs_validation test' },
      ],
    });
    const tasks = parseBatch(batchResult);

    // SWE completes task 0; bro may NOT close it via task_update_status —
    // completed → closed is reserved for bro_atomic_close (#1025).
    await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: String(tasks[0].id), status: 'completed', commit_sha: 'abc1234' });
    const closedResult = await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: String(tasks[0].id),
      status: 'closed',
    });
    assert.ok(closedResult.isError, 'completed → closed via task_update_status must be rejected');
    assert.equal(parseResult(closedResult).status, undefined, 'no status flip on a rejected close');

    // Task 1: completed → needs_validation (bro reopens for re-validation).
    await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: String(tasks[1].id), status: 'completed', commit_sha: 'def5678' });
    const nvResult = await call(tools.handlers, 'task_update_status', {
      agent: 'bro',
      task_id: String(tasks[1].id),
      status: 'needs_validation',
    });
    assert.ok(!nvResult.isError, `Expected no error for completed → needs_validation: ${JSON.stringify(parseResult(nvResult))}`);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test boundary body; spec shape not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/boundary-spec',
          description: 'Boundary spec',
          spec_body: body,
        },
      ],
    });
    assert.ok(!result.isError, `Expected success at 8000 chars; got: ${JSON.stringify(result)}`);

    db.close();
  });

  it('task_create_batch stores repo and task_get returns it verbatim', async () => {
    const db = tempDB();
    db.run("INSERT INTO repos (name, path) VALUES ('inner', '/tmp/inner')");
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/repo-test',
          description: 'Task with repo set',
          repo: 'inner',
        },
      ],
    });
    const inserted = parseBatch(batchResult);
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
    db.run("INSERT INTO repos (name, path) VALUES ('repos/backend', '/tmp/backend')");
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/nested-repo',
          description: 'Task with nested repo path',
          repo: 'repos/backend',
        },
      ],
    });
    const inserted = parseBatch(batchResult);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-repo',
          description: 'Task without repo',
        },
      ],
    });
    const inserted = parseBatch(batchResult);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/empty-repo',
          description: 'Task with empty repo string',
          repo: '',
        },
      ],
    });
    const inserted = parseBatch(batchResult);
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/bad-repo',
          description: 'Task with bad repo path',
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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/abs-repo',
          description: 'Task with absolute repo path',
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
    const { name, dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-branch-exists');
    try {
      spawnSync('git', ['-C', repoDir, 'branch', 'feat/my-feature'], { stdio: 'pipe' });
      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, [name, repoDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
          {
            branch_id: 'feat/my-feature',
            description: 'Feature task',
            repo: name,
          },
        ],
      });
      const inserted = parseBatch(result);
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
      assert.equal(inserted[0].branch_id, 'feat/my-feature');
      assert.equal(inserted[0].repo, name);

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch auto-creates branch when missing from explicit repo (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-branch-missing');
    try {
      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['fixture-missing', repoDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
          {
            branch_id: 'feat/auto-created-branch',
            description: 'Feature task',
            repo: 'fixture-missing',
          },
        ],
      });
      assert.ok(!result.isError, `Expected no error (auto-create): ${JSON.stringify(parseResult(result))}`);
      const inserted = parseBatch(result);
      assert.equal(inserted[0].branch_id, 'feat/auto-created-branch');

      const branchCheck = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', 'feat/auto-created-branch'], { encoding: 'utf8' });
      assert.equal(branchCheck.status, 0, 'Branch must have been created in git');

      const auditRow = db.get<{ event_type: string; summary: string }>(
        `SELECT event_type, summary FROM audit WHERE event_type = 'tmb_branch_autocreated' LIMIT 1`,
      );
      assert.ok(auditRow !== undefined, 'tmb_branch_autocreated audit row must exist');
      assert.ok(auditRow.summary.includes('feat/auto-created-branch'), 'Audit summary must name the branch');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch uses subdir repo for branch ensure, auto-creates in repoB (#529)', async () => {
    const { dir: repoADir, cleanup: cleanupA } = makeGitSubdir('test-git-fixture-repo-a');
    const { dir: repoBDir, cleanup: cleanupB } = makeGitSubdir('test-git-fixture-repo-b');
    try {
      spawnSync('git', ['-C', repoADir, 'branch', 'feat/exists-in-a-only'], { stdio: 'pipe' });

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['repo-a', repoADir]);
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['repo-b', repoBDir]);
      const tools = taskTools(db);

      const issueIdA = await createIssue(db, 'Subdir repo A branch ensure');
      const issueIdB = await createIssue(db, 'Subdir repo B auto-create branch');

      const acceptedResult = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueIdA),
        tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo A (already exists)', repo: 'repo-a' }],
      });
      assert.ok(!acceptedResult.isError, `Expected accepted for repoA: ${JSON.stringify(parseResult(acceptedResult))}`);

      const autocreatedResult = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueIdB),
        tasks: [{ branch_id: 'feat/exists-in-a-only', description: 'Uses repo B (auto-creates)', repo: 'repo-b' }],
      });
      assert.ok(!autocreatedResult.isError, `Expected auto-create in repoB: ${JSON.stringify(parseResult(autocreatedResult))}`);

      const branchCheck = spawnSync('git', ['-C', repoBDir, 'rev-parse', '--verify', 'feat/exists-in-a-only'], { encoding: 'utf8' });
      assert.equal(branchCheck.status, 0, 'Branch must have been auto-created in repoB');

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
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        {
          branch_id: 'feat/no-repo-set',
          description: 'Task without explicit repo',
        },
      ],
    });
    const inserted = parseBatch(result);
    assert.ok(!result.isError, `Expected no error when repo is unset: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].branch_id, 'feat/no-repo-set');

    db.close();
  });

  it('task_create_batch rejects without branch_id_proposed audit event (#155)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_append', {
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
      tasks: [{ branch_id: 'fix/test-gate', description: 'd' }],
    });

    assert.ok(result.isError, 'Expected isError=true');
    const data = parseResult(result);
    assert.equal(data.error, 'branch_state_violation');

    db.close();
  });

  it('task_create_batch defaults repo to the sole registered repo when task.repo omitted (single-repo fallback)', async () => {
    const { name: repoName, dir: repoDir, cleanup } = makeGitSubdir('test-sole-repo-gate');
    try {
      spawnSync('git', ['-C', repoDir, 'branch', 'feat/sole-repo-test'], { stdio: 'pipe' });

      const db = tempDB();
      db.run(
        `INSERT INTO repos (name, path) VALUES (?, ?)`,
        [repoName, repoDir],
      );
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [
          { branch_id: 'feat/sole-repo-test', description: 'No repo arg' },
        ],
      });
      const inserted = parseBatch(result);
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
      assert.equal(inserted[0].repo, repoName, 'repo should default to the sole registered repo');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch returns a named error when task.repo is omitted and multiple repos are registered (#15)', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a')`);
    db.run(`INSERT INTO repos (name, path) VALUES ('b', '/ws/b')`);
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/multi-repo-no-default', description: 'No repo, multi-repo' },
      ],
    });
    assert.ok(result.isError, 'multi-repo with no task.repo must be a named error');
    assert.match(parseResult(result).error as string, /omits repo but 2 repos are registered/);

    // No task row was created — the error fires before any INSERT.
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE issue_id = ?', [issueId]);
    assert.equal(count?.n, 0, 'no task row persisted on the named error');

    db.close();
  });

  it('task_create_batch auto-creates branch via the sole registered repo when the branch is missing (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-sole-repo-autocreate');
    try {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (name, path) VALUES (?, ?)`,
        [repoDir, repoDir],
      );
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/autocreated-via-default', description: 'Branch missing from the sole (registered) repo' }],
      });
      assert.ok(!result.isError, `Expected auto-create success: ${JSON.stringify(parseResult(result))}`);

      const branchCheck = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', 'feat/autocreated-via-default'], { encoding: 'utf8' });
      assert.equal(branchCheck.status, 0, 'Branch must have been auto-created in the sole (registered) repo');

      const auditRow = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type = 'tmb_branch_autocreated' LIMIT 1`,
      );
      assert.ok(auditRow !== undefined, 'tmb_branch_autocreated audit row must exist');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch defaults repo to null when task.repo omitted and no repos are registered', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/null-repo-back-compat', description: 'No repo, no registered repos' },
      ],
    });
    const inserted = parseBatch(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);
    assert.equal(inserted[0].repo, null, 'repo should be null when no repos registered and no task.repo');

    db.close();
  });

  it('task_create_batch passes with branch_id_proposed audit event (#155)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);
    const audit = auditTools(db);

    await call(audit.handlers, 'audit_append', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'branch_id_proposed',
      summary: 'Branch fix/test-gate created from origin/dev. Main checkout switched.',
    });

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'fix/test-gate', description: 'd' }],
    });

    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });

  // Slim contract — only branch_id + description are required now. The full
  // task body lives in spec_body. Dropped: tools_required, skills_required,
  // success_criteria. Verifies a minimal payload lands a row without any of
  // the dropped columns.
  it('task_create_batch accepts the minimal slim payload (branch_id + description only)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/slim', description: 'minimal' }],
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const tasks = parseBatch(result);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.branch_id, 'feat/slim');
    assert.equal(tasks[0]!.description, undefined, 'thin batch return omits description');

    const getResult = await call(tools.handlers, 'task_get', {
      agent: 'bro',
      task_id: String(tasks[0]!.id),
      include_spec_body: true,
    });
    assert.equal(parseResult(getResult).description, 'minimal');

    // Verify the dropped columns no longer exist on the row.
    const colInfo = db.all<{ name: string }>(`PRAGMA table_info(tasks)`);
    const present = new Set(colInfo.map((c) => c.name));
    assert.ok(!present.has('tools_required'), 'tasks.tools_required must be dropped');
    assert.ok(!present.has('skills_required'), 'tasks.skills_required must be dropped');
    assert.ok(!present.has('success_criteria'), 'tasks.success_criteria must be dropped');

    db.close();
  });

  it('scope_gate_waived audit row is inserted in the same transaction as task INSERTs', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);
    const aTools = auditTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true,
      waive_scope_gate_reason: 'txn regression test: verifying waiver audit is in same txn',
      waive_branch_gate: true,
      waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true,
      waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true,
      waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/txn-test', description: 'txn test task' }],
    });
    const inserted = parseBatch(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(inserted)}`);

    const auditResult = await call(aTools.handlers, 'audit_list', {
      agent: 'bro',
      issue_id: String(issueId),
    });
    const auditData = parseResult(auditResult);
    assert.ok(!auditResult.isError);
    const waiverRow = auditData.find((r: { event_type: string }) => r.event_type === 'scope_gate_waived');
    assert.ok(waiverRow, 'scope_gate_waived audit row must exist after task_create_batch with waiver');
    assert.equal(waiverRow.issue_id, issueId);

    db.close();
  });

  it('task_update_status stores commit_sha lowercase', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'fix/sha-case', description: 'sha case test' }],
    });
    const tasks = parseBatch(batchResult);
    const taskId = tasks[0].id as number;

    await call(tools.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(taskId),
      status: 'completed',
      commit_sha: 'ABCDEF1234567',
    });

    const updated = db.get<{ commit_sha: string }>(`SELECT commit_sha FROM tasks WHERE id = ?`, [taskId]);
    assert.equal(updated?.commit_sha, 'abcdef1234567', 'commit_sha must be stored lowercase');

    db.close();
  });

  it('task_update_status normalizes mixed-case agent — Swe passes role gate and obeys SWE matrix (#343)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/mixed-case-swe', description: 'mixed-case swe test' }],
    });
    const taskId = String(parseBatch(batchResult)[0].id);

    const result = await call(tools.handlers, 'task_update_status', {
      agent: 'Swe',
      task_id: taskId,
      status: 'running',
    });
    assert.ok(!result.isError, `'Swe' must normalize to swe and allow running: ${JSON.stringify(parseResult(result))}`);
    assert.equal(parseResult(result).status, 'running');

    const forbidden = await call(tools.handlers, 'task_update_status', {
      agent: 'Swe',
      task_id: taskId,
      status: 'closed',
    });
    assert.ok(forbidden.isError, 'Mixed-case Swe must be blocked from setting closed');

    db.close();
  });

  it('task_update_status swe cannot move a closed task to any status (#343)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const batchResult = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/swe-closed', description: 'swe closed resurrection test' }],
    });
    const taskId = String(parseBatch(batchResult)[0].id);

    await call(tools.handlers, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed' });
    // 'closed' is reached only via bro_atomic_close (#1025); set it directly to
    // put the task into the terminal state this test guards against.
    db.run("UPDATE tasks SET status = 'closed' WHERE id = ?", [Number(taskId)]);

    for (const status of ['completed', 'running', 'failed']) {
      const result = await call(tools.handlers, 'task_update_status', {
        agent: 'swe',
        task_id: taskId,
        status,
      });
      assert.ok(result.isError, `SWE must not resurrect a closed task to '${status}'`);
      assert.match(parseResult(result).error, /#114/);
    }

    db.close();
  });

  it('task_create_batch emits audit rows for all waived gates (#358)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'scope waiver test reason here',
      waive_branch_gate: true, waive_branch_gate_reason: 'branch waiver test reason here',
      waive_registry_gate: true, waive_registry_gate_reason: 'registry waiver test reason',
      waive_intent_gate: true, waive_intent_gate_reason: 'intent waiver test reason here',
      waive_decision_gate: true, waive_decision_gate_reason: 'decision waiver test reason',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/audit-waiver-test', description: 'all gates waived' }],
    });

    const auditRows = db.all<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ? ORDER BY event_type`,
      [issueId],
    );
    const types = auditRows.map((r) => r.event_type);
    assert.ok(types.includes('scope_gate_waived'), 'scope_gate_waived audit row must exist');
    assert.ok(types.includes('branch_gate_waived'), 'branch_gate_waived audit row must exist');
    assert.ok(types.includes('registry_gate_waived'), 'registry_gate_waived audit row must exist');
    assert.ok(types.includes('intent_gate_waived'), 'intent_gate_waived audit row must exist');
    assert.ok(types.includes('decision_gate_waived'), 'decision_gate_waived audit row must exist');

    db.close();
  });

  it('task_create_batch spec-shape gate: rejects spec_body missing ## Success Criteria', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{
        branch_id: 'feat/shape-test',
        description: 'spec without required sections',
        spec_body: '## Description\nno success criteria heading anywhere',
      }],
    });

    assert.ok(result.isError, 'Expected spec-shape gate to reject spec missing ## Success Criteria');
    const data = parseResult(result);
    assert.equal(data.error, 'spec_shape_violation');
    assert.ok(data.missing_sections.includes('## Success Criteria'), 'Must list missing Success Criteria');
    assert.ok(data.message.includes('waive_spec_shape=true'), 'Error must teach waiver path');

    db.close();
  });

  it('task_create_batch spec-shape gate: accepts spec_body without ## Files/## Verification', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{
        branch_id: 'feat/no-files-section',
        description: 'spec with only ## Success Criteria',
        spec_body: '## Description\ndo the thing\n\n## Success Criteria\n- it works',
        files: ['mcp/trajectory-server/src/tools/tasks.ts'],
        verification: ['bun test'],
      }],
    });

    assert.ok(!result.isError, `Expected no error for spec with only ## Success Criteria: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });

  it('task_create_batch spec-shape gate: rejects spec_body exceeding 200 lines', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const longBody = '## Files\n- file.ts\n\n## Success Criteria\n- done\n\n## Verification\n- run tests\n' +
      Array.from({ length: 195 }, (_, i) => `line ${i + 1}`).join('\n');

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{
        branch_id: 'feat/long-spec',
        description: 'long spec',
        spec_body: longBody,
      }],
    });

    assert.ok(result.isError, 'Expected spec-shape gate to reject spec over 200 lines');
    const data = parseResult(result);
    assert.equal(data.error, 'spec_shape_violation');
    assert.ok(data.message.includes('max 200'), 'Error must mention 200-line limit');

    db.close();
  });

  it('task_create_batch spec-shape gate: passes with waive_spec_shape=true', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      waive_spec_shape: true, waive_spec_shape_reason: 'placeholder task — no full spec needed',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/waived-shape', description: 'placeholder', spec_body: 'placeholder' }],
    });

    assert.ok(!result.isError, `Expected no error with spec-shape waived: ${JSON.stringify(parseResult(result))}`);

    const auditRow = db.get<{ event_type: string }>(
      "SELECT event_type FROM audit WHERE event_type = 'spec_shape_gate_waived' LIMIT 1",
    );
    assert.ok(auditRow !== undefined, 'spec_shape_gate_waived audit row must be written when waived');

    db.close();
  });

  it('task_create_batch spec-shape gate: still accepts a spec that includes ## Files/## Verification (backward-compat)', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validSpec = [
      '## Files',
      '- mcp/trajectory-server/src/tools/tasks.ts',
      '',
      '## Success Criteria',
      '- Gate rejects invalid specs',
      '',
      '## Verification',
      '- bun test',
    ].join('\n');

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/valid-spec', description: 'valid spec', spec_body: validSpec }],
    });

    assert.ok(!result.isError, `Expected no error for valid spec: ${JSON.stringify(parseResult(result))}`);

    db.close();
  });

  it('task_create_batch parallel_groups: single task produces one group', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validSpec = '## Success Criteria\n- pass';

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [{ branch_id: 'feat/parallel-single', description: 'single task', spec_body: validSpec, files: ['src/tools/tasks.ts'] }],
    });

    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const raw = JSON.parse(result.content[0].text);
    assert.ok('parallel_groups' in raw, 'Response must include parallel_groups');
    assert.ok('overlapping_pairs' in raw, 'Response must include overlapping_pairs');
    assert.equal(raw.overlapping_pairs.length, 0, 'Single task has no overlapping pairs');

    db.close();
  });

  it('task_create_batch parallel_groups: two tasks with no file overlap are in separate groups', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validSpec = '## Success Criteria\n- pass';

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/parallel-a', description: 'task a', spec_body: validSpec, files: ['src/tools/tasks.ts'] },
        { branch_id: 'feat/parallel-b', description: 'task b', spec_body: validSpec, files: ['src/db/schema.sql'] },
      ],
    });

    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const raw = JSON.parse(result.content[0].text);
    assert.equal(raw.overlapping_pairs.length, 0, 'Non-overlapping tasks must have no overlapping pairs');
    assert.equal(raw.parallel_groups.length, 2, 'Each non-overlapping task gets its own group');

    db.close();
  });

  it('task_create_batch parallel_groups: two tasks sharing a file dir form one group with an overlapping pair', async () => {
    const db = tempDB();
    const issueId = await createIssue(db);
    const tools = taskTools(db);

    const validSpec = '## Success Criteria\n- pass';

    const result = await call(tools.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      agent: 'bro',
      issue_id: String(issueId),
      tasks: [
        { branch_id: 'feat/overlap-a', description: 'task a', spec_body: validSpec, files: ['src/tools/tasks.ts'] },
        { branch_id: 'feat/overlap-b', description: 'task b', spec_body: validSpec, files: ['src/tools/agents.ts'] },
      ],
    });

    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const raw = JSON.parse(result.content[0].text);
    assert.equal(raw.overlapping_pairs.length, 1, 'Tasks sharing src/tools dir must produce one overlapping pair');
    assert.equal(raw.parallel_groups.length, 1, 'Overlapping tasks belong to the same group');
    assert.ok(raw.overlapping_pairs[0].shared_paths.includes('src/tools'), 'Shared path must be src/tools');

    db.close();
  });

  it('task_create_batch resolves repo via repos.path when repos.name differs from directory basename (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-repos-table');
    try {
      spawnSync('git', ['-C', repoDir, 'branch', 'feat/repos-table-test'], { stdio: 'pipe' });

      const db = tempDB();
      db.run(
        `INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`,
        ['plugin', repoDir],
      );

      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/repos-table-test', description: 'repo resolved via repos table', repo: 'plugin' }],
      });
      assert.ok(!result.isError, `Expected no error when resolving via repos table: ${JSON.stringify(parseResult(result))}`);
      const inserted = parseBatch(result);
      assert.equal(inserted[0].branch_id, 'feat/repos-table-test');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch auto-creates branch from parent_branch_id and emits tmb_branch_autocreated audit (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-autocreate-from-parent');
    try {
      const parentCommitResult = spawnSync(
        'git',
        ['-C', repoDir, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      );
      assert.equal(parentCommitResult.status, 0, 'Fixture HEAD must resolve');
      const parentCommit = parentCommitResult.stdout.trim();
      const parentRefResult = spawnSync(
        'git',
        ['-C', repoDir, 'branch', 'test/parent-base', parentCommit],
        { encoding: 'utf8' },
      );
      assert.equal(parentRefResult.status, 0, 'Fixture test/parent-base ref must be created');
      const advanceHeadResult = spawnSync(
        'git',
        ['-C', repoDir, 'commit', '--allow-empty', '-m', 'advance HEAD past parent'],
        { encoding: 'utf8' },
      );
      assert.equal(advanceHeadResult.status, 0, 'Fixture HEAD must advance past test/parent-base');
      const advancedHeadResult = spawnSync(
        'git',
        ['-C', repoDir, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      );
      assert.equal(advancedHeadResult.status, 0, 'Advanced fixture HEAD must resolve');
      assert.notEqual(advancedHeadResult.stdout.trim(), parentCommit, 'Fixture parent ref must differ from HEAD');

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['fixture-from-parent', repoDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{
          branch_id: 'feat/new-from-parent',
          parent_branch_id: 'test/parent-base',
          description: 'auto-create from parent',
          repo: 'fixture-from-parent',
        }],
      });
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

      const branchCheck = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', 'feat/new-from-parent'], { encoding: 'utf8' });
      assert.equal(branchCheck.status, 0, 'Branch must have been created');
      assert.equal(
        branchCheck.stdout.trim(),
        parentCommit,
        'Branch must start from the caller-provided parent branch commit',
      );

      const auditRow = db.get<{ summary: string; content_json: string }>(
        `SELECT summary, content_json FROM audit WHERE event_type = 'tmb_branch_autocreated' LIMIT 1`,
      );
      assert.ok(auditRow !== undefined, 'tmb_branch_autocreated audit row must exist');
      const content = JSON.parse(auditRow.content_json) as { start_point: string };
      assert.equal(content.start_point, 'test/parent-base', 'Start point must be parent_branch_id');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch auto-creates branch from HEAD when parent_branch_id does not exist in repo (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-autocreate-from-head');
    try {
      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['fixture-from-head', repoDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{
          branch_id: 'feat/new-from-head',
          parent_branch_id: 'feat/does-not-exist-in-git',
          description: 'auto-create from HEAD when parent not in repo',
          repo: 'fixture-from-head',
        }],
      });
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

      const branchCheck = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', 'feat/new-from-head'], { encoding: 'utf8' });
      assert.equal(branchCheck.status, 0, 'Branch must have been created from HEAD');

      const auditRow = db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'tmb_branch_autocreated' LIMIT 1`,
      );
      assert.ok(auditRow !== undefined, 'tmb_branch_autocreated audit row must exist');
      const content = JSON.parse(auditRow.content_json) as { start_point: string };
      assert.equal(content.start_point, 'HEAD', 'Start point must be HEAD when parent does not exist in repo');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch does not mutate git or emit audit when branch already exists (#529)', async () => {
    const { dir: repoDir, cleanup } = makeGitSubdir('test-git-fixture-already-exists');
    try {
      spawnSync('git', ['-C', repoDir, 'branch', 'feat/already-there'], { stdio: 'pipe' });

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['fixture-already-exists', repoDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/already-there', description: 'branch exists', repo: 'fixture-already-exists' }],
      });
      assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

      const auditRow = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type = 'tmb_branch_autocreated' LIMIT 1`,
      );
      assert.equal(auditRow, undefined, 'No tmb_branch_autocreated audit row when branch already exists');

      db.close();
    } finally {
      cleanup();
    }
  });

  it('task_create_batch warn-skips branch ensure when repo path is not a git repository (#529)', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'tmb-test-non-git-fixture-529-'));
    try {
      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, file_count) VALUES (?, ?, 0)`, ['fixture-non-git', nonGitDir]);
      const issueId = await createIssue(db);
      const tools = taskTools(db);

      const result = await call(tools.handlers, 'task_create_batch', {
        waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
        waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        agent: 'bro',
        issue_id: String(issueId),
        tasks: [{ branch_id: 'feat/no-git-check', description: 'non-git path skips check', repo: 'fixture-non-git' }],
      });
      assert.ok(!result.isError, `Expected warn-skip (no error) for non-git path: ${JSON.stringify(parseResult(result))}`);

      db.close();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
