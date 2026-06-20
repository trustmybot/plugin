import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { validationTools } from '../tools/validation.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';

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

async function createIssue(db: TrajectoryDB): Promise<number> {
  const issues = issueTools(db);
  const result = await call(issues.handlers, 'issue_create', {
    labels: ['Bug', 'Priority: High'],
    agent: 'bro',
    objective: 'Validation test carrier issue',
  });
  const data = parseResult(result);
  assert.ok(!result.isError, `issue_create failed: ${JSON.stringify(data)}`);
  return data.id as number;
}

async function createTask(db: TrajectoryDB, issueId: number): Promise<number> {
  const tasks = taskTools(db);
  const result = await call(tasks.handlers, 'task_create_batch', {
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
    tasks: [{ branch_id: 'fix/validation-test', description: 'Test task' }],
  });
  assert.ok(!result.isError, `task_create_batch failed: ${JSON.stringify(parseResult(result))}`);
  return parseBatch(result)[0]!.id as number;
}

describe('validation_record subagent_session_id gate', () => {
  let db: TrajectoryDB;
  let taskId: number;

  before(async () => {
    db = tempDB();
    const issueId = await createIssue(db);
    taskId = await createTask(db, issueId);
  });

  after(() => {
    db.close();
  });

  it('rejects pr-reviewer call without subagent_session_id with precondition_failed', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: '# LGTM',
    });
    assert.ok(result.isError, 'Expected error result');
    const data = parseResult(result);
    assert.ok(
      data.error.includes('precondition_failed'),
      `Error must cite precondition_failed: ${data.error}`,
    );
    assert.ok(
      data.error.includes('subagent_session_id'),
      `Error must mention subagent_session_id: ${data.error}`,
    );
  });

  it('rejects pr-reviewer call without mcp_available with precondition_failed', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: '# LGTM',
      subagent_session_id: 'abc123',
    });
    assert.ok(result.isError, 'Expected error result');
    const data = parseResult(result);
    assert.ok(
      data.error.includes('precondition_failed'),
      `Error must cite precondition_failed: ${data.error}`,
    );
    assert.ok(
      data.error.includes('mcp_available'),
      `Error must mention mcp_available: ${data.error}`,
    );
  });

  it('persists mcp_available:false as 0', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 4,
      verdict: 'pass',
      feedback: 'honor-system review',
      mcp_available: false,
      subagent_session_id: 'sess-honor',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const row = parseResult(result);
    assert.equal(row.mcp_available, 0, 'mcp_available:false must persist as 0');
  });

  it('accepts pr-reviewer call with subagent_session_id and persists it', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 1,
      verdict: 'pass',
      feedback: '# LGTM',
      mcp_available: true,
      subagent_session_id: 'abc123',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const row = parseResult(result);
    assert.equal(row.agent, 'pr-reviewer');
    assert.equal(row.verdict, 'pass');
    assert.equal(row.mcp_available, 1, 'mcp_available:true must persist as 1 on the row');
    assert.equal(row.subagent_session_id, 'abc123', 'subagent_session_id must be stored on the row');
    assert.equal(row.task_id, taskId);
    assert.equal(row.attempt_n, 1);
  });

  it('rejects bro call with forbidden (not precondition_failed) — role gate fires first', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'bro',
      task_id: taskId,
      attempt_n: 2,
      verdict: 'pass',
      feedback: '# Bro self-sign attempt',
    });
    assert.ok(result.isError, 'Expected error for bro caller');
    const data = parseResult(result);
    assert.equal(data.error, 'forbidden', `Expected forbidden, got: ${data.error}`);
    assert.ok(
      !String(data.error).includes('precondition_failed'),
      'bro must not hit the subagent_session_id gate; it should be blocked by requireRoles',
    );
  });

  it('rejects swe call with forbidden (not precondition_failed) — role gate fires first', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'swe',
      task_id: taskId,
      attempt_n: 2,
      verdict: 'pass',
      feedback: '# SWE self-sign attempt',
    });
    assert.ok(result.isError, 'Expected error for swe caller');
    const data = parseResult(result);
    assert.equal(data.error, 'forbidden', `Expected forbidden, got: ${data.error}`);
    assert.ok(
      !String(data.error).includes('precondition_failed'),
      'swe must not hit the subagent_session_id gate; it should be blocked by requireRoles',
    );
  });

  it('validation_record writes a pr_review_runs row transactionally with the verdict', async () => {
    const tools = validationTools(db);
    const result = await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 2,
      verdict: 'pass',
      feedback: '# LGTM',
      mcp_available: true,
      subagent_session_id: 'sess-pr-runs-test',
    });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);

    const prRow = db.get<{ task_id: number; verdict: string; attempt_n: number }>(
      `SELECT task_id, verdict, attempt_n FROM pr_review_runs WHERE task_id = ? AND attempt_n = 2`,
      [taskId],
    );
    assert.ok(prRow, 'pr_review_runs row must exist after validation_record');
    assert.equal(prRow.task_id, taskId, 'pr_review_runs.task_id must match');
    assert.equal(prRow.verdict, 'pass', 'pr_review_runs.verdict must match');
    assert.equal(prRow.attempt_n, 2, 'pr_review_runs.attempt_n must match');
  });

  it('validation_record pr_review_runs row is idempotent on (task_id, attempt_n)', async () => {
    const tools = validationTools(db);
    await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 3,
      verdict: 'fail',
      feedback: '# Needs work',
      mcp_available: true,
      subagent_session_id: 'sess-idem-1',
    });
    await call(tools.handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: 3,
      verdict: 'pass',
      feedback: '# Now LGTM',
      mcp_available: true,
      subagent_session_id: 'sess-idem-2',
    });

    const rows = db.all<{ verdict: string }>(
      `SELECT verdict FROM pr_review_runs WHERE task_id = ? AND attempt_n = 3`,
      [taskId],
    );
    assert.equal(rows.length, 1, 'idempotent: only one pr_review_runs row per (task_id, attempt_n)');
    assert.equal(rows[0].verdict, 'pass', 'second upsert must update verdict to pass');
  });

  it('backward compat: pre-migration rows with NULL subagent_session_id are readable via validation_history', async () => {
    const altDb = tempDB();
    const issueId = await createIssue(altDb);
    const altTaskId = await createTask(altDb, issueId);

    altDb.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))`,
      [altTaskId, 1, 'pr-reviewer', 'pass', '# Legacy row'],
    );

    const tools = validationTools(altDb);
    const result = await call(tools.handlers, 'validation_history', {
      agent: 'bro',
      task_id: altTaskId,
    });
    assert.ok(!result.isError, `validation_history failed: ${JSON.stringify(parseResult(result))}`);
    const rows = parseResult(result) as Array<{ subagent_session_id: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subagent_session_id, null, 'Legacy rows must have null subagent_session_id');

    altDb.close();
  });
});
