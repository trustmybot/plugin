/**
 * swe's checkpoint handback (GH 1905): task_update_status stores a checkpoint
 * only with status='running', stamps it with `at`, clears it on a move to
 * completed and keeps it on every other move; task_brief's core returns it
 * with last_stop, read from the task's newest stopped swe agent_runs row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../db.js';
import { CHECKPOINT_MAX_FILES, CHECKPOINT_TEXT_MAX_CHARS, parseStoredCheckpoint } from '../checkpoint.js';
import { compositeTools } from '../tools/composites.js';
import { taskTools } from '../tools/tasks.js';
import { tempDB } from './helpers.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
const CHECKPOINT = { done: 'migration and tool', left: 'tests and docs', files: ['src/db.ts', 'src/tools/tasks.ts'] };

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return (await h(args)) as RawResult;
}

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function errorOf(r: RawResult): string {
  assert.equal(r.isError, true, `expected an error, got ${r.content[0]!.text}`);
  return String(parse(r)['error']);
}

function fixture(): { db: TrajectoryDB; tasks: Handlers; composites: Handlers; id: number } {
  const db = tempDB();
  db.run(
    `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`,
  );
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, created_at, updated_at)
     VALUES (1, 'feat/1-checkpoint', 't', 'd', 'running', ?, '[]', '[]', datetime('now'), datetime('now'))`,
    [SPEC],
  );
  const id = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  return {
    db,
    tasks: taskTools(db).handlers as Handlers,
    composites: compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null).handlers as Handlers,
    id,
  };
}

function storedCheckpoint(db: TrajectoryDB, id: number): string | null {
  return db.get<{ checkpoint: string | null }>('SELECT checkpoint FROM tasks WHERE id = ?', [id])!.checkpoint;
}

const checkpointCall = (id: number, status: string, checkpoint: unknown) => ({
  agent: 'swe',
  task_id: String(id),
  status,
  checkpoint,
});

describe('task_update_status checkpoint (GH 1905)', () => {
  it('stores the checkpoint with status=running and stamps it with at', async () => {
    const { db, tasks, id } = fixture();
    const before = Date.now();
    const r = await call(tasks, 'task_update_status', checkpointCall(id, 'running', { ...CHECKPOINT, commit_sha: 'abc1234' }));
    assert.notEqual(r.isError, true, r.content[0]!.text);
    const stored = JSON.parse(storedCheckpoint(db, id)!) as Record<string, unknown>;
    assert.deepEqual({ ...stored, at: undefined }, { ...CHECKPOINT, commit_sha: 'abc1234', at: undefined });
    assert.ok(Date.parse(String(stored['at'])) >= before - 1000, 'at is now');
    assert.equal(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status, 'running');
    db.close();
  });

  it('refuses a checkpoint with any status other than running', async () => {
    const { db, tasks, id } = fixture();
    for (const status of ['completed', 'failed']) {
      const args = { ...checkpointCall(id, status, CHECKPOINT), report: status === 'completed' ? { criteria: [{ id: 'SC1', status: 'met' }] } : undefined };
      assert.match(errorOf(await call(tasks, 'task_update_status', args)), /checkpoint is accepted only with status='running'/);
    }
    assert.equal(storedCheckpoint(db, id), null);
    assert.equal(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status, 'running');
    db.close();
  });

  it('refuses an empty or over-long done or left, too many files and a bad commit_sha', async () => {
    const { db, tasks, id } = fixture();
    const bad: Array<[unknown, RegExp]> = [
      [{ ...CHECKPOINT, done: '' }, /checkpoint\.done must be a non-empty string/],
      [{ ...CHECKPOINT, left: '   ' }, /checkpoint\.left must be a non-empty string/],
      [{ ...CHECKPOINT, left: undefined }, /checkpoint\.left must be a non-empty string/],
      [{ ...CHECKPOINT, done: 'x'.repeat(CHECKPOINT_TEXT_MAX_CHARS + 1) }, /checkpoint\.done/],
      [{ ...CHECKPOINT, files: Array.from({ length: CHECKPOINT_MAX_FILES + 1 }, (_, i) => `f${i}`) }, /checkpoint\.files/],
      [{ ...CHECKPOINT, files: 'src/db.ts' }, /checkpoint\.files must be an array of strings/],
      [{ ...CHECKPOINT, commit_sha: 'not-a-sha' }, /checkpoint\.commit_sha/],
    ];
    for (const [checkpoint, re] of bad) {
      assert.match(errorOf(await call(tasks, 'task_update_status', checkpointCall(id, 'running', checkpoint))), re);
    }
    assert.equal(storedCheckpoint(db, id), null);
    const atLimit = { ...CHECKPOINT, done: 'x'.repeat(CHECKPOINT_TEXT_MAX_CHARS), files: Array.from({ length: CHECKPOINT_MAX_FILES }, (_, i) => `f${i}`) };
    const ok = await call(tasks, 'task_update_status', checkpointCall(id, 'running', atLimit));
    assert.notEqual(ok.isError, true, ok.content[0]!.text);
    db.close();
  });

  it('a move to completed clears the checkpoint', async () => {
    const { db, tasks, id } = fixture();
    await call(tasks, 'task_update_status', checkpointCall(id, 'running', CHECKPOINT));
    assert.notEqual(storedCheckpoint(db, id), null);
    const r = await call(tasks, 'task_update_status', {
      agent: 'swe',
      task_id: String(id),
      status: 'completed',
      commit_sha: 'abc1234',
      report: { criteria: [{ id: 'SC1', status: 'met', evidence_cmd: 'bun test' }] },
    });
    assert.notEqual(r.isError, true, r.content[0]!.text);
    assert.equal(storedCheckpoint(db, id), null);
    db.close();
  });

  it('every other move keeps the checkpoint', async () => {
    const { db, tasks, id } = fixture();
    await call(tasks, 'task_update_status', checkpointCall(id, 'running', CHECKPOINT));
    const kept = storedCheckpoint(db, id);
    await call(tasks, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'running' });
    assert.equal(storedCheckpoint(db, id), kept);
    const r = await call(tasks, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'failed' });
    assert.notEqual(r.isError, true, r.content[0]!.text);
    assert.equal(storedCheckpoint(db, id), kept);
    db.close();
  });
});

describe('task_brief checkpoint and last_stop (GH 1905)', () => {
  it('core returns null checkpoint and last_stop on a task with neither', async () => {
    const { db, composites, id } = fixture();
    const brief = parse(await call(composites, 'task_brief', { agent: 'bro', task_id: id, section: 'core' }));
    assert.equal(brief['checkpoint'], null);
    assert.equal(brief['last_stop'], null);
    db.close();
  });

  it('core returns the parsed checkpoint and the newest stopped swe row as last_stop', async () => {
    const { db, tasks, composites, id } = fixture();
    await call(tasks, 'task_update_status', checkpointCall(id, 'running', CHECKPOINT));
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, stop_cause, stop_detail)
       VALUES (?, 1, 'swe', '2026-10-25T09:00:00.000Z', '2026-10-25T09:10:00.000Z', 'agent-a', 'hook_block', 'PreToolUse:Bash hook error: BLOCKED: x'),
              (?, 1, 'swe', '2026-10-25T09:20:00.000Z', '2026-10-25T09:30:00.000Z', 'agent-b', 'budget', NULL),
              (?, 1, 'swe', '2026-10-25T09:40:00.000Z', NULL, 'agent-c', NULL, NULL)`,
      [id, id, id],
    );
    const brief = parse(await call(composites, 'task_brief', { agent: 'bro', task_id: id, section: 'core' }));
    assert.deepEqual(brief['checkpoint'], parseStoredCheckpoint(storedCheckpoint(db, id)));
    assert.deepEqual({ ...(brief['checkpoint'] as unknown as Record<string, unknown>), at: undefined }, { ...CHECKPOINT, at: undefined });
    assert.deepEqual(brief['last_stop'], { cause: 'budget', detail: null, at: '2026-10-25T09:30:00.000Z' });
    db.close();
  });

  it('last_stop is null when the newest stopped swe row stopped cleanly', async () => {
    const { db, composites, id } = fixture();
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, stop_cause, stop_detail)
       VALUES (?, 1, 'swe', '2026-10-25T09:00:00.000Z', '2026-10-25T09:10:00.000Z', 'agent-a', 'hook_block', 'PreToolUse:Bash hook error: BLOCKED: x'),
              (?, 1, 'swe', '2026-10-25T09:20:00.000Z', '2026-10-25T09:30:00.000Z', 'agent-b', NULL, NULL)`,
      [id, id],
    );
    const brief = parse(await call(composites, 'task_brief', { agent: 'bro', task_id: id, section: 'core' }));
    assert.equal(brief['last_stop'], null);
    db.close();
  });

  it('parseStoredCheckpoint reads null for absent, unparseable or at-less values', () => {
    assert.equal(parseStoredCheckpoint(null), null);
    assert.equal(parseStoredCheckpoint('{not json'), null);
    assert.equal(parseStoredCheckpoint(JSON.stringify(CHECKPOINT)), null);
    assert.deepEqual(parseStoredCheckpoint(JSON.stringify({ ...CHECKPOINT, at: 'x' })), { ...CHECKPOINT, at: 'x' });
  });
});
