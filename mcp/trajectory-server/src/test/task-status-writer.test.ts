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
import { sqlText, TASK_STATUSES, taskStatusUpdate, taskStatusUpdateSql, type TaskStatus } from '../task-status.js';

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
    assert.deepEqual(statusWriteLines(taskStatusUpdateSql({ status: 'failed', where: 'id = 1' })), [1]);
  });

  it('the scan passes writes that leave status alone', () => {
    assert.deepEqual(statusWriteLines("db.run('UPDATE tasks SET effort = ? WHERE id = ?', [a, b]);"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks SET commit_sha = ? WHERE id = ? AND status = 'running'`"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks SET last_status = 'x' WHERE id = 1`"), []);
    assert.deepEqual(statusWriteLines("`UPDATE tasks_archive SET status = 'closed' WHERE id = 1`"), []);
  });
});

describe('taskStatusUpdate / taskStatusUpdateSql', () => {
  const write = {
    status: 'closed' as const,
    set: { commit_sha: "o'k", completed_at: sqlText('COALESCE(completed_at, ?)', 'T1'), checkpoint: null, attempts: 2 },
    where: sqlText('id = ?', 7),
  };

  it('binds every value in the bound style, SET values before WHERE params', () => {
    assert.deepEqual(taskStatusUpdate(write), {
      sql: "UPDATE tasks SET status = 'closed', commit_sha = ?, completed_at = COALESCE(completed_at, ?), checkpoint = ?, attempts = ? WHERE id = ?",
      params: ["o'k", 'T1', null, 2, 7],
    });
  });

  it('inlines quoted literals in the inline style, doubling a quote', () => {
    const sql = taskStatusUpdateSql({
      status: 'escalated',
      alias: 't',
      set: { commit_sha: "o'k", completed_at: null, attempts: 2, updated_at: sqlText("strftime('%s')") },
      where: "t.branch_id = 'b' AND t.status = 'pending'",
    });
    assert.equal(
      sql,
      "UPDATE tasks AS t SET status = 'escalated', commit_sha = 'o''k', completed_at = NULL, attempts = 2, updated_at = strftime('%s') WHERE t.branch_id = 'b' AND t.status = 'pending'",
    );
  });

  it('leaves the placeholders of a plain-text WHERE for the caller to bind', () => {
    assert.deepEqual(taskStatusUpdate({ status: 'failed', set: { updated_at: 'T' }, where: 'id = ?' }), {
      sql: "UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?",
      params: ['T'],
    });
  });

  it('rejects a status outside the schema CHECK list', () => {
    const waived = { status: 'waived' as TaskStatus, where: 'id = 1' };
    assert.throws(() => taskStatusUpdate(waived), /'waived' is not one of pending, running/);
    assert.throws(() => taskStatusUpdateSql(waived), /'waived' is not one of/);
  });

  it('holds the same status list as the schema CHECK', () => {
    const schema = readFileSync(join(SRC, 'schema.sql'), 'utf8');
    const check = /status\s+TEXT\s+NOT NULL DEFAULT 'pending'\s+CHECK \(status IN \(([^)]*)\)\)/.exec(schema);
    assert.ok(check, 'tasks.status CHECK not found in schema.sql');
    assert.deepEqual([...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...TASK_STATUSES]);
  });

  it('rejects status in set, a non-identifier column or alias, and bound params in the inline style', () => {
    assert.throws(() => taskStatusUpdate({ status: 'running', set: { status: 'closed' }, where: 'id = 1' }), /status is set by the status field/);
    assert.throws(() => taskStatusUpdate({ status: 'running', set: { 'x = 1, y': 1 }, where: 'id = 1' }), /not a plain identifier/);
    assert.throws(() => taskStatusUpdateSql({ status: 'running', alias: 't;', where: 'id = 1' }), /not a plain identifier/);
    assert.throws(() => taskStatusUpdateSql({ status: 'running', where: sqlText('id = ?', 1) }), /cannot bind params/);
  });
});
