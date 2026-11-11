import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { seedPassingRun, seedReviewerObservation, tempDB } from './helpers.js';
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
const PROBES = [{ target: 'validation_record callers', probe_cmd: 'npm test', observed: 'exit 0: 60 passing' }];

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
  const taskId = parseBatch(result)[0]!.id as number;
  seedPassingRun(db, taskId);
  return taskId;
}

describe('validation_record probes (GH 2866)', () => {
  let db: TrajectoryDB;
  let taskId: number;

  before(async () => {
    db = tempDB();
    taskId = await createTask(db, await createIssue(db));
  });

  after(() => {
    db.close();
  });

  function record(attemptN: number, args: Record<string, unknown>): Promise<RawResult> {
    seedReviewerObservation(db, taskId, attemptN, { agentId: `probe-agent-${String(attemptN).padStart(4, '0')}` });
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'code-reviewer', task_id: taskId, attempt_n: attemptN, feedback: '# Review', mcp_available: true, ...args,
    });
  }

  const rowCount = (): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ?', [taskId])!.n;
  const probe = PROBES[0];
  type AttemptResult = { error?: string; probes?: unknown };
  const attemptOf = (r: RawResult): AttemptResult => parseResult(r) as AttemptResult;
  const historyOf = async (args: Record<string, unknown>): Promise<AttemptResult> => {
    const rows = parseResult(await call(validationTools(db).handlers, 'validation_history', { agent: 'bro', task_id: taskId, ...args })) as AttemptResult[];
    return rows[rows.length - 1];
  };

  for (const [n, label, probes, code] of [
    [201, 'absent', undefined, 'probes_required'],
    [202, 'an empty array', [], 'probes_required'],
    [203, 'not an array', { ...probe }, 'probes_invalid'],
    [204, 'a non-object entry', ['npm test'], 'probes_invalid'],
    [205, 'a missing target', [{ probe_cmd: probe.probe_cmd, observed: probe.observed }], 'probes_invalid'],
    [206, 'a missing probe_cmd', [{ target: probe.target, observed: probe.observed }], 'probes_invalid'],
    [207, 'a missing observed', [{ target: probe.target, probe_cmd: probe.probe_cmd }], 'probes_invalid'],
    [208, 'a blank target', [{ ...probe, target: '  ' }], 'probes_invalid'],
    [209, 'a blank probe_cmd', [{ ...probe, probe_cmd: '' }], 'probes_invalid'],
    [210, 'a blank observed', [{ ...probe, observed: '\t' }], 'probes_invalid'],
    [211, 'a non-string field', [{ ...probe, observed: 0 }], 'probes_invalid'],
    [212, 'an unknown key', [{ ...probe, expected: 'exit 0' }], 'probes_invalid'],
  ] as const) {
    it(`a pass with probes ${label} is refused with ${code} and writes no row`, async () => {
      const before_ = rowCount();
      const result = await record(n, { verdict: 'pass', ...(probes === undefined ? {} : { probes }) });
      assert.ok(result.isError, JSON.stringify(parseResult(result)));
      const error = attemptOf(result).error ?? '';
      assert.ok(error.startsWith(`${code}:`), error);
      assert.equal(rowCount(), before_, 'no validation_attempts row');
    });
  }

  it('a pass with probes stores them trimmed in probes_json and validation_history returns them', async () => {
    const result = await record(1, { verdict: 'pass', probes: [{ ...probe, target: `  ${probe.target}  ` }, { target: 't2', probe_cmd: 'git diff --stat', observed: '3 files' }] });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    const expected = [probe, { target: 't2', probe_cmd: 'git diff --stat', observed: '3 files' }];
    assert.deepEqual(attemptOf(result).probes, expected, 'validation_record returns the stored probes');
    assert.ok(!('probes_json' in attemptOf(result)), 'the raw column is not returned');
    const stored = db.get<{ probes_json: string | null }>('SELECT probes_json FROM validation_attempts WHERE task_id = ? AND attempt_n = 1', [taskId])!;
    assert.notEqual(stored.probes_json, null);
    assert.deepEqual(JSON.parse(stored.probes_json!), expected);

    const latest = await historyOf({});
    assert.deepEqual(latest.probes, expected);
    assert.ok(!('probes_json' in latest));
    const projected = await historyOf({ fields: ['attempt_n', 'probes'] });
    assert.deepEqual(Object.keys(projected), ['attempt_n', 'probes']);
    assert.deepEqual(projected.probes, expected);
  });

  it('fail and escalate accept probes without requiring them; none stores NULL and reads back null', async () => {
    const fail = await record(2, { verdict: 'fail', findings: [FINDING] });
    assert.ok(!fail.isError, JSON.stringify(parseResult(fail)));
    assert.equal(attemptOf(fail).probes, null);
    const escalate = await record(3, { verdict: 'escalate', findings: [FINDING], probes: PROBES });
    assert.ok(!escalate.isError, JSON.stringify(parseResult(escalate)));
    assert.deepEqual(attemptOf(escalate).probes, PROBES);
    const bad = await record(4, { verdict: 'fail', findings: [FINDING], probes: [{ ...probe, extra: 'x' }] });
    assert.ok((attemptOf(bad).error ?? '').startsWith('probes_invalid:'), 'a malformed list is refused on any verdict');
    assert.equal(
      db.get<{ p: string | null }>('SELECT probes_json AS p FROM validation_attempts WHERE task_id = ? AND attempt_n = 2', [taskId])!.p,
      null,
    );
  });
});

describe('validation_record verification_run_required (GH 2897)', () => {
  const SHA = 'c0ffee00'.padEnd(40, '1');
  const OTHER_SHA = 'deadbeef'.padEnd(40, '2');
  let db: TrajectoryDB;
  let issueId: number;
  let taskSeq = 0;

  before(async () => {
    db = tempDB();
    issueId = await createIssue(db);
  });

  after(() => {
    db.close();
  });

  async function bareTask(commitSha: string | null): Promise<number> {
    const tasks = taskTools(db);
    const result = await call(tasks.handlers, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      agent: 'bro', issue_id: String(issueId), tasks: [{ branch_id: `fix/validation-run-required-${++taskSeq}`, description: 'Run gate task' }],
    });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    const taskId = parseBatch(result)[0].id as number;
    db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', [commitSha, taskId]);
    return taskId;
  }

  function addRun(taskId: number, sha: string, exitCode: number | null, timedOut: 0 | 1, startedAt: string): void {
    db.run(
      `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (?, ?, 'gate', ?, ?, ?, 900, ?)`,
      [taskId, sha, startedAt, exitCode === null ? null : startedAt, exitCode, timedOut],
    );
  }

  function record(taskId: number, verdict: string, extra: Record<string, unknown> = {}): Promise<RawResult> {
    seedReviewerObservation(db, taskId, 1, { agentId: 'runrequired-agent' });
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'code-reviewer', task_id: taskId, attempt_n: 1, verdict, feedback: '# Review', mcp_available: true,
      ...(verdict === 'pass' ? { probes: PROBES } : { findings: [FINDING] }),
      ...extra,
    });
  }

  const outcome = (result: RawResult) => parseResult(result) as { error?: unknown; verdict?: string; reviewed_sha?: string };

  const rows = (taskId: number): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ?', [taskId])!.n;

  const T1 = '2026-11-11T10:00:00.000Z';
  const T2 = '2026-11-11T10:05:00.000Z';

  for (const [label, commitSha, runs, found] of [
    ['no run', SHA, [], 'no verification run for the task'],
    ['a failed run', SHA, [[SHA, 1, 0, T1]], 'a failed run (exit_code=1)'],
    ['an unfinished run', SHA, [[SHA, null, 0, T1]], 'a failed run (exit_code=null)'],
    ['a timed-out run', SHA, [[SHA, 124, 1, T1]], 'a run that timed out'],
    ['only a passing run at another commit', SHA, [[OTHER_SHA, 0, 0, T1]], `only a run at another commit (${OTHER_SHA})`],
    ['a passing run followed by a failed one at the commit', SHA, [[SHA, 0, 0, T1], [SHA, 2, 0, T2]], 'a failed run (exit_code=2)'],
    ['no commit recorded', null, [[SHA, 0, 0, T1]], 'no commit recorded for the task'],
  ] as const) {
    it(`refuses a pass with ${label}, naming the run state, and writes no row`, async () => {
      const taskId = await bareTask(commitSha);
      for (const [sha, exitCode, timedOut, at] of runs) addRun(taskId, sha, exitCode, timedOut, at);
      const result = await record(taskId, 'pass');
      assert.ok(result.isError, JSON.stringify(parseResult(result)));
      const error = String(outcome(result).error);
      assert.ok(error.startsWith('verification_run_required:'), error);
      assert.ok(error.includes(`found ${found}.`), error);
      assert.equal(rows(taskId), 0, 'no validation_attempts row');
    });
  }

  it('accepts a pass with a passing run at the commit, matching a short task SHA by prefix', async () => {
    const taskId = await bareTask(SHA.slice(0, 9));
    addRun(taskId, OTHER_SHA, 1, 0, T2);
    addRun(taskId, SHA, 0, 0, T1);
    const result = await record(taskId, 'pass');
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(outcome(result).verdict, 'pass');
    assert.equal(rows(taskId), 1);
  });

  it('judges tasks.commit_sha, as the preflight does, so a merge-only re-review of another sha passes on the task commit run', async () => {
    const taskId = await bareTask(SHA);
    addRun(taskId, SHA, 0, 0, T1);
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'hook:record-reviewer-spawn', 'reviewer_spawn_observed', 'spawn', ?, ?)`,
      [issueId, JSON.stringify({ task_id: taskId, attempt_n: 1, commit_sha: OTHER_SHA }), T2],
    );
    const accepted = await record(taskId, 'pass');
    assert.ok(!accepted.isError, JSON.stringify(parseResult(accepted)));
    assert.equal(outcome(accepted).reviewed_sha, OTHER_SHA);
  });

  for (const verdict of ['fail', 'escalate']) {
    it(`a ${verdict} needs no verification run`, async () => {
      const taskId = await bareTask(SHA);
      const result = await record(taskId, verdict);
      assert.ok(!result.isError, JSON.stringify(parseResult(result)));
      assert.equal(rows(taskId), 1);
    });
  }
});

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
      agent: 'code-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      feedback: '# Review',
      mcp_available: true,
      probes: PROBES,
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

  it('re-recording an attempt appends at the next attempt, keeps every earlier finding, and numbers on from the highest id', async () => {
    db.run("UPDATE review_findings SET status = 'fixed', resolved_at = ? WHERE id = ?", [new Date().toISOString(), `F${taskId}-1`]);
    const result = await record(1, { verdict: 'fail', findings: [{ probe_cmd: 'npm run lint', expected: 'exit 0', observed: 'exit 1' }] });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(parseResult(result).attempt_n, 2);
    assert.equal(attempts(1), 1);
    assert.equal(attempts(2), 1);
    assert.deepEqual(
      findingRows().map((r) => [r['id'], r['attempt_n'], r['status'], r['probe_cmd']]),
      [
        [`F${taskId}-1`, 1, 'fixed', 'npm test'],
        [`F${taskId}-2`, 1, 'open', 'bash tests/l3.sh'],
        [`F${taskId}-3`, 2, 'open', 'npm run lint'],
      ],
      'attempt 1 keeps F-1 and F-2; F-3 attaches to the stored attempt 2',
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
      { id: `F${taskId}-2`, criterion_id: null, probe_cmd: 'bash tests/l3.sh', expected: 'exit 0', observed: 'exit 2', severity: 'blocking', class: null },
      { id: `F${taskId}-3`, criterion_id: null, probe_cmd: 'npm run lint', expected: 'exit 0', observed: 'exit 1', severity: 'blocking', class: null },
      { id: `F${taskId}-4`, criterion_id: 'SC2', probe_cmd: 'exit 3', expected: 'exit 0', observed: 'exit 1: 2 failing', severity: 'blocking', class: null },
    ]);
  });

  it('types findings[].criterion_id as string or null, and stores an explicit null as NULL (GH 1783)', async () => {
    const def = validationTools(db).definitions.find((d) => d.name === 'validation_record')!;
    const findingsSchema = (def.inputSchema.properties as Record<string, { items: { properties: Record<string, { type: unknown }> } }>)['findings']!;
    assert.deepEqual(findingsSchema.items.properties['criterion_id']!.type, ['string', 'null']);
    const result = await record(4, { verdict: 'fail', findings: [{ ...FINDING, criterion_id: null }] });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    const ids = (parseResult(result).findings as Array<{ id: string }>).map((f) => f.id);
    assert.equal(ids.length, 1);
    const row = db.get<{ criterion_id: string | null }>('SELECT criterion_id FROM review_findings WHERE id = ?', [ids[0]!]);
    assert.equal(row!.criterion_id, null);
  });

  it('a later pass verdict is accepted with no findings and leaves the ledger as it is', async () => {
    const before = findingRows();
    const result = await record(3, { verdict: 'pass' });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.deepEqual(parseResult(result).findings, []);
    assert.deepEqual(findingRows(), before);
  });
});

describe('validation_record finding severity and class (GH 1955)', () => {
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
      agent: 'code-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      feedback: '# Review',
      mcp_available: true,
      probes: PROBES,
      ...extra,
    });
  }

  const attempts = (attemptN: number): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND attempt_n = ?', [taskId, attemptN])!.n;
  const rowsOf = (attemptN: number): Array<Record<string, unknown>> =>
    db
      .all<Record<string, unknown>>(
        'SELECT id, severity, class, status FROM review_findings WHERE task_id = ? AND attempt_n = ? ORDER BY id',
        [taskId, attemptN],
      )
      .map((r) => ({ ...r }));

  it('GH 1955: a fail verdict records a nit and a blocking finding with their severity and class', async () => {
    const result = await record(1, {
      verdict: 'fail',
      findings: [
        { ...FINDING, severity: 'blocking', class: 'unquoted SQL' },
        { ...FINDING, probe_cmd: 'npm run lint', severity: 'nit', class: '  naming  ' },
      ],
    });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    const rows = rowsOf(1);
    assert.deepEqual(rows, [
      { id: `F${taskId}-1`, severity: 'blocking', class: 'unquoted SQL', status: 'open' },
      { id: `F${taskId}-2`, severity: 'nit', class: 'naming', status: 'open' },
    ]);
    for (const row of rows) {
      assert.notEqual(row['severity'], null);
      assert.notEqual(row['class'], null);
    }
    const returned = parseResult(result).findings as Array<Record<string, unknown>>;
    assert.deepEqual(returned.map((f) => [f['severity'], f['class']]), [['blocking', 'unquoted SQL'], ['nit', 'naming']]);
  });

  it('GH 1955: an omitted severity stores blocking and an omitted class NULL', async () => {
    const result = await record(2, { verdict: 'fail', findings: [FINDING] });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.deepEqual(rowsOf(2), [{ id: `F${taskId}-3`, severity: 'blocking', class: null, status: 'open' }]);
  });

  it('GH 1955: a fail verdict with only nit and pre_existing findings is refused as findings_required naming severity', async () => {
    const result = await record(3, {
      verdict: 'fail',
      findings: [{ ...FINDING, severity: 'nit' }, { ...FINDING, severity: 'pre_existing' }],
    });
    assert.ok(result.isError);
    const error = parseResult(result).error as string;
    assert.match(error, /^findings_required/);
    assert.match(error, /severity blocking/);
    assert.equal(attempts(3), 0);
    assert.deepEqual(rowsOf(3), []);
  });

  it('GH 1955: a pass verdict records nit and pre_existing findings as open findings with that severity', async () => {
    const result = await record(4, {
      verdict: 'pass',
      findings: [
        { ...FINDING, severity: 'nit', class: 'style' },
        { ...FINDING, severity: 'pre_existing' },
      ],
    });
    assert.ok(!result.isError, JSON.stringify(parseResult(result)));
    assert.equal(parseResult(result).verdict, 'pass');
    assert.deepEqual(rowsOf(4), [
      { id: `F${taskId}-4`, severity: 'nit', class: 'style', status: 'open' },
      { id: `F${taskId}-5`, severity: 'pre_existing', class: null, status: 'open' },
    ]);
  });

  it('GH 1955: a pass verdict with a blocking finding, explicit or by default, is refused as findings_refused', async () => {
    for (const [n, findings] of [
      [5, [{ ...FINDING, severity: 'nit' }, { ...FINDING, severity: 'blocking' }]],
      [6, [FINDING]],
    ] as const) {
      const result = await record(n, { verdict: 'pass', findings });
      assert.ok(result.isError);
      assert.match(parseResult(result).error as string, /^findings_refused/);
      assert.equal(attempts(n), 0);
    }
  });

  it('GH 1955: an escalate verdict keeps needing a non-empty list and takes any severity', async () => {
    const empty = await record(7, { verdict: 'escalate', findings: [] });
    assert.match(parseResult(empty).error as string, /^findings_required/);
    const nitOnly = await record(8, { verdict: 'escalate', findings: [{ ...FINDING, severity: 'nit' }] });
    assert.ok(!nitOnly.isError, JSON.stringify(parseResult(nitOnly)));
  });

  it('GH 1955: refuses an unknown severity and a non-string or empty class', async () => {
    for (const [n, bad, pattern] of [
      [9, { ...FINDING, severity: 'major' }, /severity must be one of blocking, nit, pre_existing/],
      [10, { ...FINDING, severity: 3 }, /severity must be one of/],
      [11, { ...FINDING, class: 7 }, /class must be a non-empty string or null/],
      [12, { ...FINDING, class: '   ' }, /class must be a non-empty string or null/],
    ] as const) {
      const result = await record(n, { verdict: 'fail', findings: [bad] });
      assert.ok(result.isError, JSON.stringify(parseResult(result)));
      assert.match(parseResult(result).error as string, pattern);
      assert.equal(attempts(n), 0);
    }
  });

  it('GH 1955: task_brief.open_findings lists only open blocking findings, each with severity and class', async () => {
    const brief = parseResult(
      (await call(compositeTools(db, '').handlers, 'task_brief', { agent: 'swe', task_id: taskId })) as RawResult,
    ) as { open_findings: Array<Record<string, unknown>> };
    assert.deepEqual(
      brief.open_findings.map((f) => [f['id'], f['severity'], f['class']]),
      [
        [`F${taskId}-1`, 'blocking', 'unquoted SQL'],
        [`F${taskId}-3`, 'blocking', null],
      ],
    );
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
      agent: 'code-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      verdict: 'pass',
      feedback: '# LGTM',
      mcp_available: true,
      probes: PROBES,
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

  it('an honor-system call at a verified attempt appends at the next attempt and leaves the verified row unchanged', async () => {
    seedReviewerObservation(db, taskId, 13, { agentId: 'reviewer-agent-0013' });
    const verified = await record(13);
    assert.ok(!verified.isError, JSON.stringify(parseResult(verified)));
    const before = db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]);
    const honor = await record(13, { mcp_available: false, verdict: 'fail', subagent_session_id: 'sess-honor', findings: [FINDING] });
    assert.ok(!honor.isError, JSON.stringify(parseResult(honor)));
    const row = parseResult(honor);
    assert.equal(row.attempt_n, 14);
    assert.equal(row.verdict, 'fail');
    assert.equal(row.mcp_available, 0);
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 13', [taskId]) },
      { ...before },
      'the verified row is unchanged',
    );
  });

  it('a verified verdict at a recorded attempt appends after the verified one', async () => {
    seedReviewerObservation(db, taskId, 21, { agentId: 'reviewer-agent-0021' });
    assert.ok(!(await record(21)).isError);
    const before = db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 21', [taskId]);
    seedReviewerObservation(db, taskId, 21, { agentId: 'reviewer-agent-0021' });
    const appended = await record(21, { verdict: 'fail', feedback: '# re-recorded', findings: [FINDING] });
    assert.ok(!appended.isError, JSON.stringify(parseResult(appended)));
    const row = parseResult(appended);
    assert.equal(row.attempt_n, 22);
    assert.equal(row.verdict, 'fail');
    assert.equal(row.mcp_available, 1);
    assert.equal(row.reviewer_agent_id, 'reviewer-agent-0021');
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 21', [taskId]) },
      { ...before },
    );
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

  it('rejects code-reviewer call without mcp_available with precondition_failed', async () => {
    const result = await call(validationTools(db).handlers, 'validation_record', {
      agent: 'code-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: '# LGTM',
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
      [altTaskId, 1, 'code-reviewer', 'pass', '# Legacy row'],
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
      agent: 'code-reviewer', task_id: taskId, attempt_n: attemptN, verdict: 'pass', feedback: '# LGTM', mcp_available: true, probes: PROBES, ...extra,
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

describe('validation_record return_line (GH 1959)', () => {
  let db: TrajectoryDB;
  let taskId: number;

  before(async () => {
    db = tempDB();
    taskId = await createTask(db, await createIssue(db));
    db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', ['fedcba9876543210fedcba9876543210fedcba98', taskId]);
    seedPassingRun(db, taskId);
  });

  after(() => {
    db.close();
  });

  function record(attemptN: number, extra: Record<string, unknown>): Promise<RawResult> {
    seedReviewerObservation(db, taskId, attemptN, { agentId: `reviewer-agent-1959-${attemptN}` });
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'code-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      feedback: '# Review',
      mcp_available: true,
      probes: PROBES,
      ...extra,
    });
  }

  it('a pass returns findings=0 with the validation row id', async () => {
    const result = await record(1, { verdict: 'pass' });
    assert.ok(!result.isError, result.content[0].text);
    const data = parseResult(result);
    assert.equal(data.return_line, `verdict=pass task=${taskId} sha=fedcba98 attempt=1 row=${data.id} findings=0`);
  });

  it('a fail counts the findings it recorded', async () => {
    const result = await record(2, {
      verdict: 'fail',
      findings: [FINDING, { probe_cmd: 'bash tests/l3.sh', expected: 'exit 0', observed: 'exit 2' }],
    });
    assert.ok(!result.isError, result.content[0].text);
    const data = parseResult(result);
    assert.equal(data.findings.length, 2);
    assert.equal(data.return_line, `verdict=fail task=${taskId} sha=fedcba98 attempt=2 row=${data.id} findings=2`);
    assert.match(data.return_line, /^[\x20-\x7e]+$/);
  });

  it('GH 2412: a PASS at the attempt_n of an earlier FAIL appends at MAX+1 and leaves the FAIL and its open findings as they were', async () => {
    const fail = await record(7, { verdict: 'fail', findings: [FINDING] });
    assert.ok(!fail.isError, fail.content[0].text);
    const failRow = { ...db.get<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = 7', [taskId]) };
    assert.equal(failRow['reviewer_agent_id'], 'reviewer-agent-1959-7');
    const failFindings = db.all<Record<string, unknown>>('SELECT * FROM review_findings WHERE task_id = ? AND attempt_n = 7', [taskId]).map((r) => ({ ...r }));
    assert.equal(failFindings.length, 1);

    const pass = await record(7, { verdict: 'pass' });
    assert.ok(!pass.isError, pass.content[0].text);
    const data = parseResult(pass);
    assert.equal(data.attempt_n, 8);
    assert.equal(data.verdict, 'pass');
    assert.equal(data.return_line, `verdict=pass task=${taskId} sha=fedcba98 attempt=8 row=${data.id} findings=0`);

    const rows = db.all<Record<string, unknown>>('SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n IN (7, 8) ORDER BY id', [taskId]).map((r) => ({ ...r }));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], failRow, 'the FAIL row is unchanged: verdict, feedback, created_at, reviewer ids');
    assert.equal(rows[1]!['verdict'], 'pass');
    assert.equal(rows[1]!['id'], data.id);
    assert.deepEqual(
      db.all<Record<string, unknown>>('SELECT * FROM review_findings WHERE task_id = ? AND attempt_n = 7', [taskId]).map((r) => ({ ...r })),
      failFindings,
      'the FAIL findings stay open',
    );
    assert.equal(failFindings[0]!['status'], 'open');
  });
});

describe('validation_record wm_feedback (GH 2417)', () => {
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

  function record(attemptN: number, extra: Record<string, unknown>): Promise<RawResult> {
    seedReviewerObservation(db, taskId, attemptN, { agentId: `reviewer-agent-2417-${attemptN}` });
    return call(validationTools(db).handlers, 'validation_record', {
      agent: 'code-reviewer',
      task_id: taskId,
      attempt_n: attemptN,
      verdict: 'pass',
      feedback: '# Review',
      mcp_available: true,
      probes: PROBES,
      ...extra,
    });
  }

  const feedbackRows = () =>
    db.all<{ issue_id: number; from_node: string; content_json: string }>(
      `SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'wm_feedback' ORDER BY id`,
    );
  const attemptCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ?', [taskId])!.n;

  it('a call without wm_feedback writes no wm_feedback row', async () => {
    const result = await record(1, {});
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(feedbackRows().length, 0);
  });

  it('a call with wm_feedback writes one wm_feedback row on the task issue', async () => {
    const wm_feedback = { answered: 'callers of insertAudit', wrong: 'listed a deleted test file' };
    const result = await record(2, { wm_feedback });
    assert.ok(!result.isError, result.content[0].text);
    const rows = feedbackRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.issue_id, issueId);
    assert.equal(rows[0]!.from_node, 'code-reviewer');
    assert.deepEqual(JSON.parse(rows[0]!.content_json), { task_id: taskId, agent: 'code-reviewer', ...wm_feedback, missed: null });
  });

  it('an empty wm_feedback writes no wm_feedback row (GH 2421)', async () => {
    const before = feedbackRows().length;
    const result = await record(3, { wm_feedback: {} });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(feedbackRows().length, before);
  });

  for (const [label, wm_feedback, pattern] of [
    ['a non-object', 'fine', /wm_feedback must be an object/],
    ['an unknown key', { answered: 'x', note: 'y' }, /wm_feedback has unknown field\(s\) note/],
    ['a non-string value', { answered: true }, /wm_feedback\.answered must be a string/],
  ] as const) {
    it(`refuses ${label} wm_feedback with wm_feedback_invalid and writes nothing`, async () => {
      const before = attemptCount();
      const result = await record(10, { wm_feedback });
      assert.ok(result.isError);
      assert.match(parseResult(result).error, new RegExp(`^wm_feedback_invalid: ${pattern.source}`));
      assert.equal(attemptCount(), before);
      assert.equal(feedbackRows().length, 1);
    });
  }
});

describe('validation_history findings per attempt (GH 1955)', () => {
  let db: TrajectoryDB;
  let taskId: number;
  let otherTaskId: number;

  before(async () => {
    db = tempDB();
    const issueId = await createIssue(db);
    taskId = await createTask(db, issueId);
    otherTaskId = Number(db.run(`INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, 'fix/other', 'd', 'pending', datetime('now'), datetime('now'))`, [issueId]).lastInsertRowid);
    const now = new Date().toISOString();
    for (const [n, verdict] of [[1, 'fail'], [2, 'pass']] as const) {
      db.run(
        `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
         VALUES (?, ?, 'code-reviewer', ?, '# fb', 1, ?)`,
        [taskId, n, verdict, now],
      );
    }
    db.run(
      `INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
       VALUES (?, ?, 1, 'SC1', 'npm test', 'exit 0', 'exit 1', 'fixed', ?, 'blocking', 'off-by-one'),
              (?, ?, 2, NULL, 'npm run lint', 'clean', '1 warning', 'open', ?, 'nit', NULL)`,
      [`F${taskId}-1`, taskId, now, `F${taskId}-2`, taskId, now],
    );
  });

  after(() => db.close());

  const history = (args: Record<string, unknown>) =>
    call(validationTools(db).handlers, 'validation_history', { task_id: taskId, ...args });

  it('each row carries the findings of its attempt with their text, severity and class', async () => {
    const rows = parseResult(await history({ agent: 'bro' })) as Array<{ attempt_n: number; findings: unknown }>;
    assert.deepEqual(rows.map((r) => r.findings), [
      [{ id: `F${taskId}-1`, criterion_id: 'SC1', status: 'fixed', probe_cmd: 'npm test', expected: 'exit 0', observed: 'exit 1', severity: 'blocking', class: 'off-by-one' }],
      [{ id: `F${taskId}-2`, criterion_id: null, status: 'open', probe_cmd: 'npm run lint', expected: 'clean', observed: '1 warning', severity: 'nit', class: null }],
    ]);
  });

  it("fields: ['findings'] projects the array, also on the paged form", async () => {
    const rows = parseResult(await history({ agent: 'bro', fields: ['findings'] })) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(rows[0]!), ['findings']);
    assert.equal((rows[0]!['findings'] as unknown[]).length, 1);
    const paged = parseResult(await history({ agent: 'bro', fields: ['attempt_n', 'findings'], limit: 1 })) as { rows: Array<Record<string, unknown>> };
    assert.equal((paged.rows[0]!['findings'] as Array<{ id: string }>)[0]!.id, `F${taskId}-1`);
  });

  it('swe gets findings exactly where it gets feedback', async () => {
    const own = parseResult(await history({ agent: 'swe', own_task_id: taskId })) as Array<Record<string, unknown>>;
    assert.ok(own.every((r) => 'feedback' in r && Array.isArray(r['findings'])));
    const other = parseResult(await history({ agent: 'swe', own_task_id: otherTaskId })) as Array<Record<string, unknown>>;
    assert.ok(other.length === 2 && other.every((r) => !('feedback' in r) && !('findings' in r)));
  });

  it('the tool description names findings', () => {
    const def = validationTools(db).definitions.find((d) => d.name === 'validation_history')!;
    assert.match(def.description ?? '', /findings, the review_findings rows of that attempt/);
  });
});
