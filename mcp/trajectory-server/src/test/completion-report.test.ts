/**
 * Success Criteria ids and the typed swe completion report (GH 1744):
 * the spec-writing tools refuse unlabeled criteria, task_update_status needs a
 * report covering every id on a move to completed, task_brief returns it,
 * bro_atomic_close refuses a close it does not cover and stores spawn_note,
 * and task_reopen clears the report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { taskTools } from '../tools/tasks.js';
import { specCriteriaProblem, specCriterionIds } from '../success-criteria.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works', '  - Writer: x', '- SC2: tested'].join('\n');
const LEGACY_SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');
const FULL_REPORT = {
  criteria: [
    { id: 'SC1', status: 'met', evidence_cmd: 'bun test' },
    { id: 'SC2', status: 'not_applicable', note: 'covered by SC1' },
  ],
  extras: [{ path: 'docs/x.md', reason: 'doc sync' }],
  findings_fixed: ['F1'],
};
const CLOSE_ARGS = {
  agent: 'bro', commit_sha: 'abc1234', verification_summary: 'ok',
  waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
};

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return (await h(args)) as RawResult;
}

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

function errorOf(r: RawResult): string {
  assert.equal(r.isError, true, `expected an error, got ${r.content[0].text}`);
  return String(parse(r)['error']);
}

function seed(db: TrajectoryDB, spec: string, status = 'running'): number {
  db.run(
    `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`,
  );
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, commit_sha, created_at, updated_at)
     VALUES (1, 'fix/1-report', 't', 'd', ?, ?, '[]', '[]', 'abc1234', datetime('now'), datetime('now'))`,
    [status, spec],
  );
  return db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
}

function stored(db: TrajectoryDB, id: number): { completion_report: string | null; spawn_note: string | null } {
  return db.get<{ completion_report: string | null; spawn_note: string | null }>(
    'SELECT completion_report, spawn_note FROM tasks WHERE id = ?',
    [id],
  )!;
}

function fixture(): { db: TrajectoryDB; tasks: Handlers; composites: Handlers } {
  const db = tempDB();
  return {
    db,
    tasks: taskTools(db).handlers as Handlers,
    composites: compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null).handlers as Handlers,
  };
}

describe('Success Criteria ids (GH 1744)', () => {
  it('specCriteriaProblem names missing, unlabeled and duplicate ids; sub-bullets and fenced bullets carry none', () => {
    assert.equal(specCriteriaProblem(SPEC), null);
    assert.match(specCriteriaProblem('## Description\nno criteria')!, /## Success Criteria/);
    assert.match(specCriteriaProblem(LEGACY_SPEC)!, /^success_criteria_ids_missing: no bullet/);
    assert.match(specCriteriaProblem(`${SPEC}\n- plain`)!, /^success_criteria_ids_missing: 1 top-level bullet.*"plain"/);
    assert.match(specCriteriaProblem(`${SPEC}\n- SC1: again`)!, /^success_criteria_ids_duplicate: SC1/);
    assert.equal(specCriteriaProblem(`${SPEC}\n\`\`\`\n- not a criterion\n\`\`\`\n## Next\n- free`), null);
    assert.deepEqual(specCriterionIds(SPEC), ['SC1', 'SC2']);
    assert.deepEqual(specCriterionIds(LEGACY_SPEC), []);
  });

  it('task_provision refuses a spec whose criteria carry no ids', async () => {
    const { db, composites } = fixture();
    const r = await call(composites, 'task_provision', {
      agent: 'bro', issue_id: 1, branch_id: 'fix/1-ids', decision_body: 'approach: ids.',
      task: { description: 'd', spec_body: LEGACY_SPEC, files: ['src/x.ts'], verification: ['true'] },
    });
    assert.match(errorOf(r), /success_criteria_ids_missing/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n, 0);
    db.close();
  });

  it('task_update_spec refuses an unlabeled bullet and duplicate ids, and accepts ids', async () => {
    const { db, composites } = fixture();
    const id = seed(db, SPEC);
    const unlabeled = await call(composites, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', spec_body: `${SPEC}\n- plain` });
    assert.match(errorOf(unlabeled), /success_criteria_ids_missing/);
    const dup = await call(composites, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', spec_body: `${SPEC}\n- SC2: again` });
    assert.match(errorOf(dup), /success_criteria_ids_duplicate: SC2/);
    const good = await call(composites, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', spec_body: `${SPEC}\n- SC3: more` });
    assert.ok(!good.isError, JSON.stringify(parse(good)));
    db.close();
  });

  it('task_create_batch refuses missing ids inside the shape gate, and waive_spec_shape lets them through', async () => {
    const { db, tasks } = fixture();
    seed(db, SPEC);
    const batch = (waive: boolean) => call(tasks, 'task_create_batch', {
      waive_scope_gate: true, waive_scope_gate_reason: 'not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
      ...(waive ? { waive_spec_shape: true, waive_spec_shape_reason: 'legacy fixture spec' } : {}),
      agent: 'bro', issue_id: '1',
      tasks: [{ branch_id: `feat/legacy-${waive}`, description: 'd', spec_body: LEGACY_SPEC, files: ['a.ts'], verification: ['true'] }],
    });
    assert.match(errorOf(await batch(false)), /Spec shape gate: .*success_criteria_ids_missing/);
    const waived = await batch(true);
    assert.ok(!waived.isError, JSON.stringify(parse(waived)));
    db.close();
  });
});

describe('task_update_status completion report (GH 1744)', () => {
  const complete = (tasks: Handlers, id: number, report?: unknown) =>
    call(tasks, 'task_update_status', {
      agent: 'swe', task_id: String(id), status: 'completed', commit_sha: 'abc1234',
      ...(report === undefined ? {} : { report }),
    });

  it('refuses a move to completed without a report when the spec has ids, showing a minimal payload', async () => {
    const { db, tasks } = fixture();
    const id = seed(db, SPEC);
    const msg = errorOf(await complete(tasks, id));
    assert.match(msg, /^completion_report_missing: .*SC1, SC2/);
    assert.ok(msg.includes('report={"criteria":[{"id":"SC1","status":"met"},{"id":"SC2","status":"met"}]}'), msg);
    assert.equal(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status, 'running');
    db.close();
  });

  it('refuses missing, unknown and repeated ids and a bad status', async () => {
    const { db, tasks } = fixture();
    const id = seed(db, SPEC);
    assert.match(errorOf(await complete(tasks, id, { criteria: [{ id: 'SC1', status: 'met' }] })), /completion_report_incomplete: .*missing ids: SC2/);
    assert.match(
      errorOf(await complete(tasks, id, { criteria: [{ id: 'SC1', status: 'met' }, { id: 'SC2', status: 'met' }, { id: 'SC9', status: 'met' }] })),
      /unknown ids: SC9/,
    );
    assert.match(
      errorOf(await complete(tasks, id, { criteria: [{ id: 'SC1', status: 'met' }, { id: 'SC1', status: 'met' }, { id: 'SC2', status: 'met' }] })),
      /ids listed more than once: SC1/,
    );
    assert.match(errorOf(await complete(tasks, id, { criteria: [{ id: 'SC1', status: 'done' }, { id: 'SC2', status: 'met' }] })), /completion_report_invalid: .*status must be one of met, not_met, not_applicable/);
    assert.equal(stored(db, id).completion_report, null);
    db.close();
  });

  it('stores a full report with the move to completed', async () => {
    const { db, tasks } = fixture();
    const id = seed(db, SPEC);
    const r = await complete(tasks, id, FULL_REPORT);
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(JSON.parse(stored(db, id).completion_report!), FULL_REPORT);
    db.close();
  });

  it('needs no report on a legacy spec without ids', async () => {
    const { db, tasks } = fixture();
    const id = seed(db, LEGACY_SPEC);
    const r = await complete(tasks, id);
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal(stored(db, id).completion_report, null);
    db.close();
  });

  it('rejects a report with any status but completed, and a move to needs_validation clears the stored report', async () => {
    const { db, tasks } = fixture();
    const id = seed(db, SPEC);
    const withFailed = await call(tasks, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'failed', report: FULL_REPORT });
    assert.match(errorOf(withFailed), /report is accepted only with status='completed'/);
    assert.ok(!(await complete(tasks, id, FULL_REPORT)).isError);
    const back = await call(tasks, 'task_update_status', { agent: 'bro', task_id: String(id), status: 'needs_validation' });
    assert.ok(!back.isError, JSON.stringify(parse(back)));
    assert.equal(stored(db, id).completion_report, null);
    db.close();
  });
});

describe('completion report and spawn_note through task_brief, bro_atomic_close and task_reopen (GH 1744)', () => {
  it('task_brief round-trips the stored report, and null before one', async () => {
    const { db, tasks, composites } = fixture();
    const id = seed(db, SPEC);
    const before = parse(await call(composites, 'task_brief', { agent: 'bro', task_id: id }));
    assert.equal(before['completion_report'], null);
    assert.equal(before['spawn_note'], null);
    await call(tasks, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'completed', commit_sha: 'abc1234', report: FULL_REPORT });
    const after = parse(await call(composites, 'task_brief', { agent: 'bro', task_id: id }));
    assert.deepEqual(after['completion_report'], FULL_REPORT);
    db.close();
  });

  it('bro_atomic_close refuses a close whose stored report misses ids, naming them', async () => {
    const { db, composites } = fixture();
    const id = seed(db, SPEC, 'completed');
    const none = errorOf(await call(composites, 'bro_atomic_close', { ...CLOSE_ARGS, task_id: id }));
    assert.match(none, /^completion_report_missing: .*is missing for: SC1, SC2/);
    db.run('UPDATE tasks SET completion_report = ? WHERE id = ?', [JSON.stringify({ criteria: [{ id: 'SC1', status: 'met' }] }), id]);
    const partial = errorOf(await call(composites, 'bro_atomic_close', { ...CLOSE_ARGS, task_id: id }));
    assert.match(partial, /does not cover: SC2/);
    assert.equal(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status, 'completed');
    db.close();
  });

  it('bro_atomic_close stores spawn_note and task_brief returns it; a note over 300 chars is refused', async () => {
    const { db, tasks, composites } = fixture();
    const id = seed(db, SPEC);
    await call(tasks, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'completed', commit_sha: 'abc1234', report: FULL_REPORT });
    const long = errorOf(await call(composites, 'bro_atomic_close', { ...CLOSE_ARGS, task_id: id, spawn_note: 'x'.repeat(301) }));
    assert.match(long, /spawn_note is 301 characters \(max 300\)/);
    const r = await call(composites, 'bro_atomic_close', { ...CLOSE_ARGS, task_id: id, spawn_note: 'Check the v48 migration backup.' });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    const brief = parse(await call(composites, 'task_brief', { agent: 'pr-reviewer', task_id: id }));
    assert.equal(brief['spawn_note'], 'Check the v48 migration backup.');
    assert.deepEqual(brief['completion_report'], FULL_REPORT, 'the close keeps the report');
    db.close();
  });

  it('bro_atomic_close on a legacy spec needs no report and leaves spawn_note NULL when none is passed', async () => {
    const { db, composites } = fixture();
    const id = seed(db, LEGACY_SPEC, 'completed');
    db.run(`UPDATE tasks SET spawn_note = 'stale' WHERE id = ?`, [id]);
    const r = await call(composites, 'bro_atomic_close', { ...CLOSE_ARGS, task_id: id });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal(stored(db, id).spawn_note, null);
    db.close();
  });

  it('task_reopen clears the completion report and overwrites spawn_note', async () => {
    const { db, composites } = fixture();
    const id = seed(db, SPEC, 'closed');
    db.run('UPDATE tasks SET completion_report = ?, spawn_note = ? WHERE id = ?', [JSON.stringify(FULL_REPORT), 'old note', id]);
    const r = await call(composites, 'task_reopen', {
      agent: 'bro', task_id: id, reason: 'review found a missing test', spawn_note: 'Add the SC2 test.',
    });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual({ ...stored(db, id) }, { completion_report: null, spawn_note: 'Add the SC2 test.' });
    const again = await call(composites, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review found another gap' });
    assert.ok(!again.isError, JSON.stringify(parse(again)));
    assert.equal(stored(db, id).spawn_note, null);
    db.close();
  });
});
