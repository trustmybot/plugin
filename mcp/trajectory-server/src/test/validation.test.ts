import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { seedReviewerObservation, tempDB } from './helpers.js';
import { REVIEWER_OBSERVATION_TTL_S, validationTools } from '../tools/validation.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { auditTools } from '../tools/audit.js';
import { compositeTools } from '../tools/composites.js';
import { DATA_CONTRACTS } from '../data-contracts.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

function parseBatch(result: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(result.content[0].text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
}

const FINDING = { criterion_id: 'SC1', probe_cmd: 'npm test', expected: 'exit 0', observed: 'exit 1: 2 failing' };

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

describe('validation_record review findings (GH 1737)', () => {
  let db: TrajectoryDB;
  let taskId: number;

  before(async () => {
    db = tempDB();
    taskId = await createTask(db, await createIssue(db));
  });

  after(() => {
    db.close();
  });

  function record(attemptN: number, extra: Record<string, unknown>): Promise<RawResult> {
    seedReviewerObservation(db, taskId, attemptN, { agentId: `reviewer-agent-${String(attemptN).padStart(4, '0')}` });
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      feedback: '# Review',
      mcp_available: true,
      ...extra,
    });
  }

  const attempts = (attemptN: number): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = ?', [taskId, attemptN])!.n;
  const findingRows = (): Array<Record<string, unknown>> =>
    db.all<Record<string, unknown>>('SELECT * FROM review_findings WHERE task_id = ? ORDER BY created_at, id', [taskId]).map((r) => ({ ...r }));

  for (const verdict of ['fail', 'escalate'] as const) {
    for (const [label, findings] of [['missing', undefined], ['empty', []]] as const) {
      it(`a ${verdict} verdict with ${label} findings is refused naming findings and writes no validation_attempts row`, async () => {
        const n = verdict === 'fail' ? (label === 'missing' ? 101 : 102) : label === 'missing' ? 103 : 104;
        const result = await record(n, { verdict, ...(findings === undefined ? {} : { findings }) });
        assert.ok(result.isError);
        const error = parseResult(result).error as string;
        assert.match(error, /^findings_required/);
        assert.match(error, /findings\[\]/);
        assert.equal(attempts(n), 0, 'no validation_attempts row');
        assert.deepEqual(findingRows(), [], 'no review_findings row');
      });
    }
  }

  it('a pass verdict carrying findings is refused and writes nothing', async () => {
    const result = await record(105, { verdict: 'pass', findings: [FINDING] });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^findings_refused/);
    assert.equal(attempts(105), 0);
    assert.deepEqual(findingRows(), []);
  });

  it('refuses a finding with an empty probe_cmd, or a server-owned or unknown field', async () => {
    for (const [n, bad, pattern] of [
      [106, { ...FINDING, probe_cmd: '   ' }, /probe_cmd/],
      [107, { ...FINDING, status: 'fixed' }, /unknown field\(s\) status/],
      [108, { probe_cmd: 'npm test', expected: 'exit 0' }, /observed/],
    ] as const) {
      const result = await record(n, { verdict: 'fail', findings: [bad] });
      assert.ok(result.isError, JSON.stringify(parseResult(result)));
      assert.match(parseResult(result).error, pattern);
      assert.equal(attempts(n), 0);
    }
    assert.deepEqual(findingRows(), []);
  });

  it('a fail verdict writes one open row per finding with every non-nullable column set and returns them', async () => {
    const result = await record(1, {
      verdict: 'fail',
      findings: [FINDING, { probe_cmd: '  bash tests/l3.sh  ', expected: 'exit 0', observed: 'exit 2' }],
    });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    const out = parseResult(result) as { verdict: string; findings: Array<Record<string, unknown>> };
    assert.equal(out.verdict, 'fail');
    const rows = findingRows();
    assert.deepEqual(out.findings, rows, 'the response carries the written rows');
    assert.equal(rows.length, 2);
    for (const col of ['id', 'task_id', 'attempt_n', 'probe_cmd', 'expected', 'observed', 'status', 'created_at']) {
      for (const row of rows) assert.notEqual(row[col], null, `${col} is set`);
    }
    assert.deepEqual(
      rows.map(({ id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, resolved_at }) => ({
        id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, resolved_at,
      })),
      [
        { id: `F${taskId}-1`, task_id: taskId, attempt_n: 1, criterion_id: 'SC1', probe_cmd: 'npm test', expected: 'exit 0', observed: 'exit 1: 2 failing', status: 'open', resolved_at: null },
        { id: `F${taskId}-2`, task_id: taskId, attempt_n: 1, criterion_id: null, probe_cmd: 'bash tests/l3.sh', expected: 'exit 0', observed: 'exit 2', status: 'open', resolved_at: null },
      ],
    );
    assert.match(String(rows[0]!['created_at']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('re-recording an attempt replaces its open findings, keeps fixed ones, and numbers on from the highest id', async () => {
    db.run("UPDATE review_findings SET status = 'fixed', resolved_at = ? WHERE id = ?", [new Date().toISOString(), `F${taskId}-1`]);
    const result = await record(1, { verdict: 'fail', findings: [{ probe_cmd: 'npm run lint', expected: 'exit 0', observed: 'exit 1' }] });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.deepEqual(
      findingRows().map((r) => [r['id'], r['status'], r['probe_cmd']]),
      [
        [`F${taskId}-1`, 'fixed', 'npm test'],
        [`F${taskId}-3`, 'open', 'npm run lint'],
      ],
      'the open F-2 of attempt 1 is replaced by F-3; the fixed F-1 stays',
    );
  });

  it('task_brief.open_findings lists only open findings with id, criterion_id, probe_cmd, expected and observed', async () => {
    const second = await record(2, { verdict: 'escalate', findings: [{ ...FINDING, criterion_id: 'SC2', probe_cmd: 'exit 3' }] });
    assert.ok(!second.isError, JSON.stringify(parseResult(second)));
    db.run(
      `INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, status, created_at)
       VALUES (?, ?, 2, 'exit 9', 'exit 0', 'exit 9', 'wontfix', ?)`,
      [`F${taskId}-5`, taskId, new Date().toISOString()],
    );
    const brief = parseResult(
      (await call(compositeTools(db, '').handlers, 'task_brief', { agent: 'swe', task_id: taskId })) as RawResult,
    ) as { open_findings: unknown };
    assert.deepEqual(brief.open_findings, [
      { id: `F${taskId}-3`, criterion_id: null, probe_cmd: 'npm run lint', expected: 'exit 0', observed: 'exit 1' },
      { id: `F${taskId}-4`, criterion_id: 'SC2', probe_cmd: 'exit 3', expected: 'exit 0', observed: 'exit 1: 2 failing' },
    ]);
  });

  it('a later pass verdict is accepted with no findings and leaves the ledger as it is', async () => {
    const before = findingRows();
    const result = await record(3, { verdict: 'pass' });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.deepEqual(parseResult(result).findings, []);
    assert.deepEqual(findingRows(), before);
  });
});

describe('validation_record reviewer identity', () => {
  let db: TrajectoryDB;
  let taskId: number;
  let issueId: number;

  before(async () => {
    db = tempDB();
    issueId = await createIssue(db);
    taskId = await createTask(db, issueId);
  });

  after(() => {
    db.close();
  });

  function record(attemptN: number, extra: Record<string, unknown> = {}): Promise<RawResult> {
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      verdict: 'pass',
      feedback: '# LGTM',
      mcp_available: true,
      ...extra,
    });
  }

  function consumed(auditId: number): number {
    return db.get<{ c: number }>(
      `SELECT json_extract(content_json, '$.consumed') AS c FROM audit WHERE id = ?`,
      [auditId],
    )!.c;
  }

  it('stamps subagent_session_id and reviewer_agent_id from the observed row, consumes it, ignores the caller value', async () => {
    const auditId = seedReviewerObservation(db, taskId, 1, { agentId: 'reviewer-agent-0001', sessionId: 'main-sess-1' });
    const result = await record(1, { subagent_session_id: 'caller-forged' });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const row = parseResult(result);
    assert.equal(row.subagent_session_id, 'main-sess-1');
    assert.equal(row.reviewer_agent_id, 'reviewer-agent-0001');
    assert.equal(row.mcp_available, 1);
    assert.equal(consumed(auditId), 1, 'the observed row is consumed');
  });

  it('a consumed row is not reused: a second call for the same attempt is refused', async () => {
    const result = await record(1);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^subagent_session_unavailable/);
  });

  it('refuses subagent_session_unavailable when no row was observed', async () => {
    const result = await record(2, { subagent_session_id: 'caller-supplied' });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^subagent_session_unavailable/);
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = 2', [taskId])!.n,
      0,
    );
  });

  it('ignores an observed row not written by the hook', async () => {
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'bro', 'reviewer_identity_observed', 'forged', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [issueId, JSON.stringify({ task_id: taskId, attempt_n: 3, session_id: 's', agent_id: 'forged-agent-01', consumed: 0 })],
    );
    const result = await record(3);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^subagent_session_unavailable/);
  });

  it('takes the latest unconsumed row for (task, attempt)', async () => {
    seedReviewerObservation(db, taskId, 4, { agentId: 'older-reviewer-01' });
    seedReviewerObservation(db, taskId, 4, { agentId: 'newer-reviewer-01' });
    const result = await record(4);
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(parseResult(result).reviewer_agent_id, 'newer-reviewer-01');
  });

  it('consumes a fresh row only: a row observed past the TTL is refused with its age and left unconsumed', async () => {
    const staleAt = new Date(Date.now() - (REVIEWER_OBSERVATION_TTL_S + 60) * 1000).toISOString();
    const auditId = seedReviewerObservation(db, taskId, 11, { agentId: 'stale-reviewer-01', observedAt: staleAt });
    const result = await record(11);
    assert.ok(result.isError);
    const error = parseResult(result).error as string;
    assert.match(error, /^subagent_session_unavailable/);
    assert.match(error, new RegExp(`audit id ${auditId}\\) is (6[6-9]\\d|7\\d\\d)s old`));
    assert.equal(consumed(auditId), 0, 'a stale row is never consumed');
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = 11', [taskId])!.n,
      0,
    );
  });

  it('two rows: the newest fresh one is consumed, the older one is superseded, not consumed', async () => {
    const older = seedReviewerObservation(db, taskId, 12, { agentId: 'older-reviewer-02', toolUseId: 'toolu_older' });
    const newer = seedReviewerObservation(db, taskId, 12, { agentId: 'newer-reviewer-02', toolUseId: 'toolu_newer' });
    const result = await record(12);
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(parseResult(result).reviewer_agent_id, 'newer-reviewer-02');
    assert.equal(consumed(newer), 1);
    assert.equal(consumed(older), 0);
    assert.equal(db.get<{ s: number }>(`SELECT json_extract(content_json, '$.superseded_by') AS s FROM audit WHERE id = ?`, [older])!.s, newer);
  });

  it('a verified pass is never overwritten by an honor-system call (verified_verdict_exists)', async () => {
    seedReviewerObservation(db, taskId, 13, { agentId: 'reviewer-agent-0013' });
    const verified = await record(13);
    assert.ok(!verified.isError, JSON.stringify(parseResult(verified)));
    const before = db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]);
    const honor = await record(13, { mcp_available: false, verdict: 'fail', subagent_session_id: 'sess-honor', findings: [FINDING] });
    assert.ok(honor.isError);
    const error = parseResult(honor).error as string;
    assert.match(error, /^verified_verdict_exists/);
    assert.match(error, /verified pass verdict/);
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]) },
      { ...before },
      'the verified row is unchanged',
    );
  });

  it('a verified verdict replaces a verified verdict', async () => {
    seedReviewerObservation(db, taskId, 14, { agentId: 'reviewer-agent-0014' });
    assert.ok(!(await record(14)).isError);
    seedReviewerObservation(db, taskId, 14, { agentId: 'reviewer-agent-0014' });
    const replaced = await record(14, { verdict: 'fail', feedback: '# re-recorded', findings: [FINDING] });
    assert.ok(!replaced.isError, JSON.stringify(parseResult(replaced)));
    const row = parseResult(replaced);
    assert.equal(row.verdict, 'fail');
    assert.equal(row.mcp_available, 1);
    assert.equal(row.reviewer_agent_id, 'reviewer-agent-0014');
  });

  it('honor-system path (mcp_available:false, no row) records caller values and audits validation_session_unverified', async () => {
    const result = await record(5, { mcp_available: false, subagent_session_id: 'sess-honor' });
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    const row = parseResult(result);
    assert.equal(row.mcp_available, 0);
    assert.equal(row.subagent_session_id, 'sess-honor');
    assert.equal(row.reviewer_agent_id, null);
    const audit = db.get<{ issue_id: number; from_node: string; content_json: string }>(
      `SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'validation_session_unverified' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(audit, 'validation_session_unverified row written');
    assert.equal(audit.issue_id, issueId);
    assert.equal(audit.from_node, 'trajectory-server');
    assert.deepEqual(JSON.parse(audit.content_json), { task_id: taskId, attempt_n: 5, subagent_session_id: 'sess-honor' });
  });

  it('refuses reviewer_not_independent when the observed agent_id is the task\'s swe spawn_id', async () => {
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at) VALUES (?, ?, 'swe', 'swe-agent-00001', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [taskId, issueId],
    );
    const auditId = seedReviewerObservation(db, taskId, 6, { agentId: 'swe-agent-00001' });
    const result = await record(6);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^reviewer_not_independent/);
    assert.equal(consumed(auditId), 0, 'a refused call consumes nothing');
  });

  it('refuses reviewer_not_independent when the observed row carries no agent_id (main loop)', async () => {
    seedReviewerObservation(db, taskId, 7, { agentId: '' });
    const result = await record(7);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^reviewer_not_independent/);
  });

  it('refuses a malformed observed agent_id', async () => {
    seedReviewerObservation(db, taskId, 8, { agentId: 'bad id;' });
    const result = await record(8);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^reviewer_agent_id_malformed/);
  });

  it('rejects pr-reviewer call without mcp_available with precondition_failed', async () => {
    const result = await call(validationTools(db).handlers, 'validation_record', {
      agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: '# LGTM',
    });
    assert.ok(result.isError);
    const data = parseResult(result);
    assert.ok(data.error.includes('precondition_failed') && data.error.includes('mcp_available'), data.error);
  });

  for (const role of ['bro', 'swe']) {
    it(`rejects ${role} with forbidden — role gate fires first`, async () => {
      const result = await call(validationTools(db).handlers, 'validation_record', {
        agent: role, task_id: taskId, attempt_n: 2, verdict: 'pass', feedback: '# self-sign',
      });
      assert.ok(result.isError);
      assert.equal(parseResult(result).error, 'forbidden');
    });
  }

  it('audit_append refuses reviewer_identity_observed', async () => {
    const result = await call(auditTools(db).handlers, 'audit_append', {
      agent: 'bro', issue_id: String(issueId), from_node: 'hook:reviewer-identity-observe',
      event_type: 'reviewer_identity_observed', summary: 'forge',
      content_json: JSON.stringify({ task_id: taskId, attempt_n: 9, session_id: 's', agent_id: 'forged-agent-01', consumed: 0 }),
    });
    assert.ok(result.isError);
    assert.equal(parseResult(result).error, 'audit_event_not_writable_by_role');
  });

  it('validation_record leaves pr_review_runs alone — it is the /monitor cursor table only', async () => {
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pr_review_runs')!.n;
    seedReviewerObservation(db, taskId, 10);
    const result = await record(10);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(parseResult(result))}`);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pr_review_runs')!.n, before);
  });

  it('backward compat: pre-migration rows with NULL subagent_session_id are readable via validation_history', async () => {
    const altDb = tempDB();
    const altIssueId = await createIssue(altDb);
    const altTaskId = await createTask(altDb, altIssueId);
    altDb.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, datetime('now'))`,
      [altTaskId, 1, 'pr-reviewer', 'pass', '# Legacy row'],
    );
    const result = await call(validationTools(altDb).handlers, 'validation_history', { agent: 'bro', task_id: altTaskId });
    assert.ok(!result.isError);
    const rows = parseResult(result) as Array<{ subagent_session_id: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subagent_session_id, null);
    altDb.close();
  });
});

describe('validation_record supersedes older unconsumed observations', () => {
  let db: TrajectoryDB;
  let taskId: number;

  before(async () => {
    db = tempDB();
    taskId = await createTask(db, await createIssue(db));
  });

  after(() => {
    db.close();
  });

  function record(attemptN: number, extra: Record<string, unknown> = {}): Promise<RawResult> {
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'pr-reviewer', task_id: taskId, attempt_n: attemptN, verdict: 'pass', feedback: '# LGTM', mcp_available: true, ...extra,
    });
  }

  interface ObservationState { consumed: number | null; superseded: number | null; superseded_by: number | null; superseded_at: string | null }

  function state(auditId: number): ObservationState {
    return db.get<ObservationState>(
      `SELECT json_extract(content_json, '$.consumed') AS consumed,
              json_extract(content_json, '$.superseded') AS superseded,
              json_extract(content_json, '$.superseded_by') AS superseded_by,
              json_extract(content_json, '$.superseded_at') AS superseded_at
         FROM audit WHERE id = ?`,
      [auditId],
    )!;
  }

  function assertSuperseded(auditId: number, by: number): void {
    const s = state(auditId);
    assert.equal(s.consumed, 0);
    assert.equal(s.superseded, 1);
    assert.equal(s.superseded_by, by);
    assert.ok(Number.isFinite(Date.parse(String(s.superseded_at))), `superseded_at is a timestamp: ${s.superseded_at}`);
  }

  function assertUntouched(auditId: number): void {
    assert.deepEqual({ ...state(auditId) }, { consumed: 0, superseded: null, superseded_by: null, superseded_at: null });
  }

  function orphanWarned(): boolean {
    const contract = DATA_CONTRACTS.find((c) => c.id === 'no_unconsumed_reviewer_observations')!;
    const report = runDataContracts(trajectoryDbReader(db), [contract], { env: {} });
    assert.deepEqual(report.skipped, []);
    return report.violations.some((v) => v.id === contract.id);
  }

  function age(auditId: number): void {
    db.run(`UPDATE audit SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id = ?`, [auditId]);
  }

  it('retry then success: the failed call\'s row is superseded by the consumed one', async () => {
    const first = seedReviewerObservation(db, taskId, 1, { toolUseId: 'toolu_first' });
    const failed = await record(1, { verdict: 'approve' });
    assert.ok(failed.isError);
    assertUntouched(first);
    const second = seedReviewerObservation(db, taskId, 1, { toolUseId: 'toolu_second' });
    const ok = await record(1);
    assert.ok(!ok.isError, JSON.stringify(parseResult(ok)));
    assert.equal(state(second).consumed, 1);
    assert.equal(state(second).superseded, null);
    assertSuperseded(first, second);
  });

  it('two stale rows plus one fresh: the fresh row is consumed, both older rows superseded', async () => {
    const staleAt = new Date(Date.now() - (REVIEWER_OBSERVATION_TTL_S + 60) * 1000).toISOString();
    const a = seedReviewerObservation(db, taskId, 2, { observedAt: staleAt });
    const b = seedReviewerObservation(db, taskId, 2, { observedAt: staleAt });
    const fresh = seedReviewerObservation(db, taskId, 2);
    const result = await record(2);
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(state(fresh).consumed, 1);
    assertSuperseded(a, fresh);
    assertSuperseded(b, fresh);
  });

  it('no older rows: nothing is superseded, other attempts are untouched', async () => {
    const otherAttempt = seedReviewerObservation(db, taskId, 4);
    const only = seedReviewerObservation(db, taskId, 3);
    const result = await record(3);
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(state(only).consumed, 1);
    assert.equal(state(only).superseded, null);
    assertUntouched(otherAttempt);
  });

  it('a superseded row is never consumed by a later call', async () => {
    const older = seedReviewerObservation(db, taskId, 5);
    const newer = seedReviewerObservation(db, taskId, 5);
    assert.ok(!(await record(5)).isError);
    assertSuperseded(older, newer);
    const again = await record(5);
    assert.ok(again.isError);
    assert.match(parseResult(again).error, /^subagent_session_unavailable/);
    assertSuperseded(older, newer);
  });

  it('a stale-row refusal supersedes nothing', async () => {
    const staleAt = new Date(Date.now() - (REVIEWER_OBSERVATION_TTL_S + 60) * 1000).toISOString();
    const a = seedReviewerObservation(db, taskId, 6, { observedAt: staleAt });
    const b = seedReviewerObservation(db, taskId, 6, { observedAt: staleAt });
    const result = await record(6);
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^subagent_session_unavailable/);
    assertUntouched(a);
    assertUntouched(b);
  });

  it('honor-system path (mcp_available:false, no fresh row) supersedes nothing', async () => {
    const staleAt = new Date(Date.now() - (REVIEWER_OBSERVATION_TTL_S + 60) * 1000).toISOString();
    const stale = seedReviewerObservation(db, taskId, 7, { observedAt: staleAt });
    const result = await record(7, { mcp_available: false, subagent_session_id: 'sess-honor' });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(parseResult(result).reviewer_agent_id, null);
    assertUntouched(stale);
  });

  it('no_unconsumed_reviewer_observations ignores superseded rows and still warns on an orphaned one', async () => {
    db.run(`DELETE FROM audit WHERE event_type = 'reviewer_identity_observed'`);
    const older = seedReviewerObservation(db, taskId, 8);
    const newer = seedReviewerObservation(db, taskId, 8);
    assert.ok(!(await record(8)).isError);
    age(older);
    age(newer);
    assertSuperseded(older, newer);
    assert.equal(orphanWarned(), false, 'a routine retry does not warn');
    const orphan = seedReviewerObservation(db, taskId, 9);
    age(orphan);
    assert.equal(orphanWarned(), true, 'an orphaned row still warns');
  });
});

describe('system issue -1 is reserved', () => {
  it('task_create_batch refuses issue_id -1 with system_issue_reserved', async () => {
    const db = tempDB();
    const result = await call(taskTools(db).handlers, 'task_create_batch', {
      agent: 'bro', issue_id: '-1',
      tasks: [{ branch_id: 'fix/system', description: 'd' }],
    });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^system_issue_reserved/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n, 0);
    db.close();
  });

  it('task_provision refuses issue_id -1 with system_issue_reserved', async () => {
    const db = tempDB();
    const result = await call(compositeTools(db, '').handlers, 'task_provision', {
      agent: 'bro', issue_id: -1, branch_id: 'fix/system', decision_body: 'Chosen approach: none.',
      task: { description: 'd', spec_body: 's', files: ['x'], verification: ['true'] },
    });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /^system_issue_reserved/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n, 0);
    db.close();
  });
});
