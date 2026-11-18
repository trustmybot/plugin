/**
 * The task lifecycle as events (GH 3224, schema v77): the seeded tables and
 * edges, the refusals the DB makes, and the writers that move a task's status
 * through task_events.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { TrajectoryDB } from '../db.js';
import { spawnSql } from '../hooks/record-swe-spawn.js';
import { TASK_EVENTS_SCHEMA_SQL } from '../task-events.js';
import { runTaskStatusMove, sqlText, TASK_STATUSES } from '../task-status.js';
import { compositeTools } from '../tools/composites.js';
import { taskTools } from '../tools/tasks.js';
import { pinScanEnv, seedPassingRun, seedReviewedCommit, TEST_COMMIT_SHA, tempDB } from './helpers.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = '2026-11-18T10:00:00.000Z';

const scanPin = pinScanEnv();
const tmpDirs: string[] = [];
after(() => {
  scanPin.restore();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return (await h(args).catch((e: Error) => ({ content: [{ type: 'text', text: e.message }], isError: true }))) as RawResult;
}

interface EventRow {
  seq: number;
  event_type: string;
  from_state: string | null;
  to_state: string;
  role: string;
  cause: string;
  record_kind: string | null;
  record_id: number | null;
}

function events(db: TrajectoryDB, taskId: number): EventRow[] {
  return db
    .all<EventRow>(
      'SELECT seq, event_type, from_state, to_state, role, cause, record_kind, record_id FROM task_events WHERE task_id = ? ORDER BY seq',
      [taskId],
    )
    .map((r) => ({ ...r }));
}

const statusOf = (db: TrajectoryDB, taskId: number): string | undefined =>
  db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;

function seedIssue(db: TrajectoryDB): void {
  db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)`, [T0, T0]);
}

/** A task inserted at `status` with no event yet, as a pre-event fixture holds it. */
function seedTask(db: TrajectoryDB, id: number, status: string): number {
  db.run(
    `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, ?)`,
    [id, `feat/t${id}`, status, T0, T0],
  );
  return id;
}

/** A raw event insert, every column given. */
function insertEvent(
  db: TrajectoryDB,
  e: { task: number; seq?: number; type: string; from: string | null; to: string; cause?: string; note?: string | null; kind?: string | null; record?: number | null; key?: string | null },
): void {
  db.run(
    `INSERT INTO task_events (task_id, seq, event_type, from_state, to_state, role, cause, note, record_kind, record_id, idempotency_key, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, 'bro', ?, ?, ?, ?, ?, ?, ?)`,
    [e.task, e.seq ?? 1, e.type, e.from, e.to, e.cause ?? 'rework', e.note ?? null, e.kind ?? null, e.record ?? null, e.key ?? null, T0, T0],
  );
}

// The chart of TASKS.md over v77's seven states, plus the two interim edges
// (decision 459): bro's close and the feature-branch drop.
const EXPECTED_EDGES = [
  'NULL>pending provisioned task -',
  'pending>running spawned agent_run -',
  'running>pending spawn_rolled_back agent_run -',
  'running>submitted submitted verification_run -',
  'running>submitted submitted_unverified task unverified',
  'running>submitted resubmitted audit -',
  'running>failed failed agent_run -',
  'running>failed run_stale audit -',
  'submitted>closed bro_closed audit -',
  'pending>closed merged_outside_flow task -',
  'running>closed merged_outside_flow task -',
  'submitted>closed merged_outside_flow task -',
  'pending>closed recovered audit -',
  'submitted>closed recovered audit -',
  'submitted>running reopened audit -',
  'failed>running reopened audit -',
  'closed>running reopened audit -',
  'pending>superseded superseded task -',
  'running>superseded superseded task -',
  'submitted>superseded superseded task -',
  'failed>superseded superseded task -',
  'closed>superseded superseded task -',
  'pending>cancelled issue_cancelled issue -',
  'running>cancelled issue_cancelled issue -',
  'submitted>cancelled issue_cancelled issue -',
  'closed>cancelled branch_dropped audit feature_branch_dropped',
];

describe('task_events schema (GH 3224, v77)', () => {
  it('SC1: seeds every table and exactly the chart edges', () => {
    const db = tempDB();
    for (const table of ['task_event_types', 'task_event_causes', 'task_status_edges']) {
      assert.ok(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n > 0, `${table} holds seeded rows`);
    }
    const edges = db
      .all<{ e: string }>(
        `SELECT IFNULL(from_state, 'NULL') || '>' || to_state || ' ' || event_type || ' ' || record_kind || ' ' || IFNULL(required_cause, '-') AS e
           FROM task_status_edges`,
      )
      .map((r) => r.e)
      .sort();
    assert.deepEqual(edges, [...EXPECTED_EDGES].sort());
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_events')!.n, 0);
    db.close();
  });

  it('SC1: the tasks CHECK holds the seven v77 states and refuses the renamed ones', () => {
    const db = tempDB();
    seedIssue(db);
    assert.deepEqual([...TASK_STATUSES], ['pending', 'running', 'submitted', 'failed', 'closed', 'superseded', 'cancelled']);
    for (const old of ['completed', 'needs_validation', 'escalated']) {
      assert.throws(() => seedTask(db, 50, old), /CHECK/, `${old} is no v77 state`);
    }
    assert.ok(db.all("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'retry_of'").length === 1, 'tasks.retry_of exists');
    db.close();
  });

  it('SC1: schema.sql carries TASK_EVENTS_SCHEMA_SQL verbatim', () => {
    const schema = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
    assert.ok(schema.includes(TASK_EVENTS_SCHEMA_SQL.trim()));
  });
});

describe('the DB refuses a status written any other way (SC2)', () => {
  it('refuses a from_state that is not the task status', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'running');
    assert.throws(
      () => insertEvent(db, { task: 1, type: 'reopened', from: 'failed', to: 'running', kind: 'audit', record: 1 }),
      /from_state must be the task status/,
    );
    db.close();
  });

  it('refuses a move with no edge', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'pending');
    assert.throws(
      () => insertEvent(db, { task: 1, type: 'submitted', from: 'pending', to: 'submitted', cause: 'checks_passed', kind: 'verification_run', record: 1 }),
      /not a task_status_edges edge/,
    );
    assert.equal(statusOf(db, 1), 'pending');
    db.close();
  });

  it('refuses a move missing its record kind, unless the cause is manual with a note', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'pending');
    seedTask(db, 2, 'pending');
    assert.throws(() => insertEvent(db, { task: 1, type: 'spawned', from: 'pending', to: 'running', cause: 'author_spawned' }), /rests on its edge record kind/);
    assert.throws(
      () => insertEvent(db, { task: 1, type: 'spawned', from: 'pending', to: 'running', cause: 'author_spawned', kind: 'audit', record: 1 }),
      /rests on its edge record kind/,
      'a record of another kind is no record',
    );
    assert.throws(() => insertEvent(db, { task: 1, type: 'spawned', from: 'pending', to: 'running', cause: 'manual' }), /manual move carries a note/);
    insertEvent(db, { task: 2, type: 'spawned', from: 'pending', to: 'running', cause: 'manual', note: 'wedged spawn, freed by hand' });
    assert.equal(statusOf(db, 1), 'pending');
    assert.equal(statusOf(db, 2), 'running');
    db.close();
  });

  it('refuses closed -> cancelled with any cause but feature_branch_dropped', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'closed');
    for (const cause of ['manual', 'issue_closed']) {
      assert.throws(
        () => insertEvent(db, { task: 1, type: 'branch_dropped', from: 'closed', to: 'cancelled', cause, note: 'n', kind: 'audit', record: 1 }),
        /admits only the cause its edge names/,
      );
    }
    insertEvent(db, { task: 1, type: 'branch_dropped', from: 'closed', to: 'cancelled', cause: 'feature_branch_dropped', kind: 'audit', record: 1 });
    assert.equal(statusOf(db, 1), 'cancelled');
    db.close();
  });

  it('refuses an UPDATE of tasks.status outside the event insert, and any change to an event', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'pending');
    assert.throws(() => db.run(`UPDATE tasks SET status = 'running' WHERE id = 1`), /tasks\.status follows task_events/);
    insertEvent(db, { task: 1, type: 'spawned', from: 'pending', to: 'running', cause: 'manual', note: 'n' });
    assert.throws(() => db.run(`UPDATE tasks SET status = 'pending' WHERE id = 1`), /tasks\.status follows task_events/);
    db.run(`UPDATE tasks SET effort = 'high' WHERE id = 1`);
    assert.throws(() => db.run(`UPDATE task_events SET note = 'x'`), /append-only/);
    assert.throws(() => db.run(`DELETE FROM task_events`), /append-only/);
    db.close();
  });

  it('a repeated idempotency key, or a move another writer already made, writes nothing and raises nothing', () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'running');
    const fail = {
      status: 'failed',
      event: 'failed',
      cause: 'manual',
      role: 'bro',
      note: 'stuck',
      key: 'k1',
      set: { updated_at: T0 },
      where: sqlText('id = ?', 1),
    } as const;
    assert.equal(runTaskStatusMove(db, fail), 1);
    assert.equal(runTaskStatusMove(db, fail), 0, 'the same key again');
    assert.equal(runTaskStatusMove(db, { ...fail, key: 'k2' }), 0, 'the task already holds failed');
    assert.equal(events(db, 1).length, 1);
    assert.equal(statusOf(db, 1), 'failed');
    db.close();
  });
});

describe('the writers record every status move as an event (SC3)', () => {
  it('provision -> spawn -> submit -> close yields 4 events, each with its role and record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-task-events-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'trajectory.db');
    const db = tempDB({ path: dbPath });
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', '/tmp/app', 'main')`);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at, repo) VALUES (1, 'o', 'd', 'open', ?, ?, 'app')`, [T0, T0]);
    const waive = (gate: string) => ({ [`waive_${gate}`]: true, [`waive_${gate}_reason`]: 'unit test: gate not under test' });
    const created = await call(taskTools(db).handlers, 'task_create_batch', {
      agent: 'bro',
      issue_id: '1',
      ...waive('scope_gate'),
      ...waive('branch_gate'),
      ...waive('intent_gate'),
      ...waive('decision_gate'),
      ...waive('spec_shape'),
      tasks: [{ branch_id: 'feat/events', description: 'd', spec_body: 's', repo: 'app' }],
    });
    assert.ok(!created.isError, created.content[0].text);
    const taskId = db.get<{ id: number }>("SELECT id FROM tasks WHERE branch_id = 'feat/events'")!.id;

    // record-swe-spawn writes through the sqlite3 CLI; its SQL text runs the same here.
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      spawnSql({
        taskId: String(taskId),
        rootDir: '/tmp/app/.claude/worktrees/feat-events',
        fields: { sessionId: 's', toolUseId: 'tu1', effort: 'medium', model: 'm' },
        spawnId: 'tool_use:tu1',
        pluginVersion: '0.0.0',
        now: T0,
      }),
    );
    raw.close();
    const runId = db.get<{ id: number }>("SELECT id FROM agent_runs WHERE spawn_id = 'tool_use:tu1'")!.id;

    const verificationRunId = seedPassingRun(db, taskId);
    const submitted = await call(taskTools(db).handlers, 'task_update_status', {
      agent: 'swe',
      task_id: String(taskId),
      status: 'submitted',
      commit_sha: TEST_COMMIT_SHA,
    });
    assert.ok(!submitted.isError, submitted.content[0].text);

    seedReviewedCommit(db, 1, taskId, TEST_COMMIT_SHA);
    const closed = await call(compositeTools(db, dbPath, null).handlers, 'bro_atomic_close', {
      agent: 'bro',
      task_id: String(taskId),
      commit_sha: TEST_COMMIT_SHA,
      verification_summary: 'reviewed',
      waive_scope_gate: true,
      scope_waiver_reason: 'unit test: scope not under test',
    });
    assert.ok(!closed.isError, closed.content[0].text);
    const passAudit = db.get<{ id: number }>("SELECT MAX(id) AS id FROM audit WHERE event_type = 'bro_verification_pass'")!.id;

    assert.deepEqual(events(db, taskId), [
      { seq: 1, event_type: 'provisioned', from_state: null, to_state: 'pending', role: 'bro', cause: 'planned', record_kind: 'task', record_id: taskId },
      { seq: 2, event_type: 'spawned', from_state: 'pending', to_state: 'running', role: 'hook', cause: 'author_spawned', record_kind: 'agent_run', record_id: runId },
      {
        seq: 3,
        event_type: 'submitted',
        from_state: 'running',
        to_state: 'submitted',
        role: 'swe',
        cause: 'checks_passed',
        record_kind: 'verification_run',
        record_id: verificationRunId,
      },
      { seq: 4, event_type: 'bro_closed', from_state: 'submitted', to_state: 'closed', role: 'bro', cause: 'bro_close', record_kind: 'audit', record_id: passAudit },
    ]);
    assert.equal(statusOf(db, taskId), 'closed');
    db.close();
  });

  it("task_update_status refuses completed and escalated, and refuses bro's move without a note", async () => {
    const db = tempDB();
    seedIssue(db);
    seedTask(db, 1, 'running');
    const handlers = taskTools(db).handlers;
    const completed = await call(handlers, 'task_update_status', { agent: 'swe', task_id: '1', status: 'completed' });
    assert.match(completed.content[0].text, /renamed submitted/);
    const escalated = await call(handlers, 'task_update_status', { agent: 'bro', task_id: '1', status: 'escalated', note: 'n' });
    assert.match(escalated.content[0].text, /Invalid status: escalated/);
    const silent = await call(handlers, 'task_update_status', { agent: 'bro', task_id: '1', status: 'failed' });
    assert.match(silent.content[0].text, /needs a note/);
    const byHand = await call(handlers, 'task_update_status', { agent: 'bro', task_id: '1', status: 'failed', note: 'its swe is wedged' });
    assert.ok(!byHand.isError, byHand.content[0].text);
    assert.deepEqual(
      db.all<{ event_type: string; cause: string; note: string }>('SELECT event_type, cause, note FROM task_events WHERE task_id = 1').map((r) => ({ ...r })),
      [{ event_type: 'failed', cause: 'manual', note: 'its swe is wedged' }],
    );
    db.close();
  });

  it('no source file writes completed, needs_validation or escalated into tasks.status', () => {
    const src = join(SERVER_ROOT, 'src');
    const writers = ['task-status.ts', 'tools/tasks.ts', 'tools/composites.ts', 'tools/lifecycle.ts', 'tools/reopen.ts', 'cli/feature-branch.ts'];
    for (const file of writers) {
      const text = readFileSync(join(src, file), 'utf8');
      assert.doesNotMatch(text, /status:\s*'(completed|needs_validation|escalated)'/, `${file} moves no task to an old state`);
    }
  });
});
