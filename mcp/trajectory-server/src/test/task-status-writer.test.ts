/**
 * The one writer of tasks.status (GH 3224 step 1): no source file outside
 * task-status.ts holds an UPDATE of tasks that assigns status, the scan that
 * says so catches each shape such a write takes, and the builder's two output
 * styles set what their callers ask for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  preEventStatusRewriteSql,
  sqlText,
  STATUS_CACHE_UPDATE_SQL,
  TASK_STATUSES,
  taskStatusMove,
  taskStatusMoveSql,
  type TaskStatus,
} from '../task-status.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(SERVER_ROOT, 'src');
const WRITER = join(SRC, 'task-status.ts');
const TESTS = join(SRC, 'test');

// One UPDATE of tasks, optionally aliased, from its SET to the end of the
// statement: a `;`, the end of the template literal or the end of the text.
const TASKS_UPDATE = /\bUPDATE\s+tasks(?:\s+AS\s+\w+)?\s+(SET\b[^;`]*)/gi;
// An assignment to status: the first SET item or one after a comma.
const STATUS_ASSIGNMENT = /(?:\bSET|,)\s*(?:\w+\.)?status\s*=/i;

/** The 1-based line of each UPDATE of tasks in `text` that assigns status. */
function statusWriteLines(text: string): number[] {
  const lines: number[] = [];
  for (const m of text.matchAll(TASKS_UPDATE)) {
    if (STATUS_ASSIGNMENT.test(m[1])) lines.push(text.slice(0, m.index).split('\n').length);
  }
  return lines;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === TESTS ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && path !== WRITER ? [path] : [];
  });
}

describe('task status single writer', () => {
  it('no source file outside task-status.ts writes tasks.status', () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      statusWriteLines(readFileSync(path, 'utf8')).map((line) => `${relative(SERVER_ROOT, path)}:${line}`),
    );
    assert.deepEqual(offenders, [], `route these status writes through src/task-status.ts:\n${offenders.join('\n')}`);
  });

  it('the scan catches a single-line, a multi-line and an aliased status write', () => {
    assert.deepEqual(statusWriteLines("db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [1]);"), [1]);
    assert.deepEqual(
      statusWriteLines("const a = 1;\nconst sql = `UPDATE tasks\n   SET commit_sha = ?,\n       status = ?\n WHERE id = ?`;"),
      [2],
    );
    assert.deepEqual(statusWriteLines("x;\n\nUPDATE tasks AS t SET updated_at = '1', t.status='escalated' WHERE t.id = 1;"), [3]);
    assert.deepEqual(statusWriteLines(STATUS_CACHE_UPDATE_SQL), [1]);
    assert.deepEqual(statusWriteLines(preEventStatusRewriteSql('escalated', '', 'id = 1')), [1]);
  });

  it('the scan passes writes that leave status alone', () => {
    assert.deepEqual(statusWriteLines("db.run('UPDATE tasks SET effort = ? WHERE id = ?', [a, b]);"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks SET commit_sha = ? WHERE id = ? AND status = 'running'`"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks SET last_status = 'x' WHERE id = 1`"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks_archive SET status = 'closed' WHERE id = 1`"), []);
  });
});

describe('taskStatusMove / taskStatusMoveSql', () => {
  const base = { event: 'bro_closed', cause: 'bro_close', role: 'bro', key: 'k' } as const;
  const write = {
    ...base,
    status: 'closed' as const,
    record: { kind: 'audit' as const, id: 9 },
    set: { commit_sha: "o'k", completed_at: sqlText('COALESCE(completed_at, ?)', 'T1'), checkpoint: null, attempts: 2 },
    where: sqlText('id = ?', 7),
  };

  it('records the move as one event insert, then sets the other columns on the tasks it moved', () => {
    const [insert, update] = taskStatusMove(write);
    assert.match(insert.sql, /^INSERT INTO task_events /);
    assert.match(insert.sql, /WHERE \(id = \?\) AND tasks\.status IS NOT 'closed'\nON CONFLICT\(idempotency_key\) DO NOTHING$/);
    assert.deepEqual(insert.params, [9, 7]);
    assert.match(update.sql, /^UPDATE tasks SET commit_sha = \?, completed_at = COALESCE\(completed_at, \?\), checkpoint = \?, attempts = \? WHERE tasks\.id IN/);
    assert.deepEqual(update.params, ["o'k", 'T1', null, 2]);
    assert.doesNotMatch(update.sql, /SET status/);
  });

  it('inlines quoted literals in the inline style, doubling a quote', () => {
    const sql = taskStatusMoveSql({
      ...base,
      status: 'closed',
      alias: 't',
      note: "it's",
      set: { commit_sha: "o'k", completed_at: null },
      where: "t.branch_id = 'b'",
    });
    assert.match(sql, /FROM tasks AS t\n WHERE \(t\.branch_id = 'b'\) AND t\.status IS NOT 'closed'/);
    assert.match(sql, /'it''s'/);
    assert.match(sql, /UPDATE tasks AS t SET commit_sha = 'o''k', completed_at = NULL WHERE t\.id IN/);
  });

  it('leaves the placeholders of a plain-text WHERE for the caller to bind', () => {
    const [insert] = taskStatusMove({ ...base, status: 'failed', where: 'id = ?' });
    assert.deepEqual(insert.params, []);
    assert.match(insert.sql, /WHERE \(id = \?\)/);
  });

  it('rejects a status outside the schema CHECK list, and a manual move with no note', () => {
    const waived = { ...base, status: 'waived' as TaskStatus, where: 'id = 1' };
    assert.throws(() => taskStatusMove(waived), /'waived' is not one of pending, running/);
    assert.throws(() => taskStatusMoveSql(waived), /'waived' is not one of/);
    assert.throws(() => taskStatusMove({ ...base, cause: 'manual', status: 'failed', where: 'id = 1' }), /manual move carries a note/);
  });

  it('holds the same status list as the schema CHECK', () => {
    const schema = readFileSync(join(SRC, 'schema.sql'), 'utf8');
    const check = /status\s+TEXT\s+NOT NULL DEFAULT 'pending'\s+CHECK \(status IN \(([^)]*)\)\)/.exec(schema);
    assert.ok(check, 'tasks.status CHECK not found in schema.sql');
    assert.deepEqual([...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...TASK_STATUSES]);
  });

  it('rejects status in set, a non-identifier column or alias, and bound params in the inline style', () => {
    const running = { event: 'spawned', cause: 'author_spawned', role: 'swe', key: 'k', status: 'running' } as const;
    assert.throws(() => taskStatusMove({ ...running, set: { status: 'closed' }, where: 'id = 1' }), /status is set by the event/);
    assert.throws(() => taskStatusMove({ ...running, set: { 'x = 1, y': 1 }, where: 'id = 1' }), /not a plain identifier/);
    assert.throws(() => taskStatusMoveSql({ ...running, alias: 't;', where: 'id = 1' }), /not a plain identifier/);
    assert.throws(() => taskStatusMoveSql({ ...running, where: sqlText('id = ?', 1) }), /cannot bind params/);
  });
});
