/**
 * The one writer of tasks.status (GH 3224): every status move is built here
 * as one task_events insert, and the cache trigger moves tasks.status; the DB
 * refuses a status written any other way (task-events.ts). The statements
 * serve node:sqlite callers that bind values and the hooks and CLI that hand
 * inline SQL text to the sqlite3 CLI. Plain SQL text, in a module the hook
 * bundle can import without the tool layer.
 */
import type { TaskEventCause, TaskEventType, TaskRecordKind } from './task-events.js';

/** The tasks.status CHECK list of schema.sql (v77). */
export const TASK_STATUSES = ['pending', 'running', 'submitted', 'failed', 'closed', 'superseded', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type SqlValue = string | number | null;

/** SQL text used verbatim; its `?` placeholders bind `params`, in order. */
export interface SqlText {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export function sqlText(sql: string, ...params: SqlValue[]): SqlText {
  return { sql, params };
}

/**
 * One status move of every task `where` selects. SQL text in `where`,
 * `record.id`, `agentRunId` and `set` reads the moving task as `tasks`, or as
 * `alias` when one is given.
 */
export interface TaskStatusWrite {
  readonly status: TaskStatus;
  readonly event: TaskEventType;
  readonly cause: TaskEventCause;
  /** Who acted: an agent name, or `hook` / `system` for a writer with no agent. */
  readonly role: string;
  readonly agentRunId?: SqlValue | SqlText;
  /** Required with cause `manual`: why bro moved the task by hand. */
  readonly note?: string | null;
  /** The record the move rests on; a `manual` move may omit it. */
  readonly record?: { readonly kind: TaskRecordKind; readonly id: SqlValue | SqlText } | null;
  /**
   * The idempotency key of this write; each task's event takes `<key>:<task id>`,
   * so a retried write with the same key records nothing a second time.
   */
  readonly key: string;
  /** When the move happened; omitted, the time of the write. */
  readonly at?: string;
  /** The other columns the move sets on each moved task: a value, or SQL text such as `COALESCE(completed_at, ?)`. */
  readonly set?: Readonly<Record<string, SqlValue | SqlText>>;
  /** Plain text binds nothing here: a `?` in it is left for the caller to bind after the other params. */
  readonly where: string | SqlText;
  readonly alias?: string;
}

export interface BoundStatement {
  readonly sql: string;
  readonly params: SqlValue[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ISO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function isSqlText(value: SqlValue | SqlText): value is SqlText {
  return value !== null && typeof value === 'object';
}

function quoteLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`task status write: ${value} is not a SQL number`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function checkStatus(status: string): void {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`task status write: '${status}' is not one of ${TASK_STATUSES.join(', ')}`);
  }
}

function checkIdentifier(name: string, role: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`task status write: ${role} '${name}' is not a plain identifier`);
}

/** The text of the cache trigger's write: the one UPDATE of tasks.status, run only by the event insert. */
export const STATUS_CACHE_UPDATE_SQL = 'UPDATE tasks SET status = NEW.to_state WHERE id = NEW.task_id AND status IS NOT NEW.to_state';

function buildTaskStatusMove(write: TaskStatusWrite, style: 'bound' | 'inline'): BoundStatement[] {
  checkStatus(write.status);
  if (write.cause === 'manual' && (write.note ?? '').trim() === '') {
    throw new Error('task status write: a manual move carries a note');
  }
  const ref = write.alias ?? 'tasks';
  if (write.alias !== undefined) checkIdentifier(write.alias, 'alias');
  const target = write.alias === undefined ? 'tasks' : `tasks AS ${write.alias}`;

  const exprWith = (params: SqlValue[]) => (value: SqlValue | SqlText): string => {
    if (isSqlText(value)) {
      if (style === 'inline' && value.params.length > 0) {
        throw new Error('task status write: inline SQL text cannot bind params');
      }
      params.push(...value.params);
      return value.sql;
    }
    if (style === 'inline') return quoteLiteral(value);
    params.push(value);
    return '?';
  };

  const keyPrefix = `${write.key}:`;
  const eventParams: SqlValue[] = [];
  const expr = exprWith(eventParams);
  const columns = [
    `${ref}.id`,
    `(SELECT COALESCE(MAX(e.seq), 0) + 1 FROM task_events e WHERE e.task_id = ${ref}.id)`,
    quoteLiteral(write.event),
    `${ref}.status`,
    quoteLiteral(write.status),
    quoteLiteral(write.role),
    write.agentRunId === undefined ? 'NULL' : expr(write.agentRunId),
    quoteLiteral(write.cause),
    quoteLiteral(write.note ?? null),
    quoteLiteral(write.record?.kind ?? null),
    write.record ? expr(write.record.id) : 'NULL',
    `${quoteLiteral(keyPrefix)} || ${ref}.id`,
    write.at === undefined ? ISO_NOW : quoteLiteral(write.at),
    ISO_NOW,
  ];
  const where = typeof write.where === 'string' ? write.where : expr(write.where);
  const insert: BoundStatement = {
    sql: `INSERT INTO task_events (task_id, seq, event_type, from_state, to_state, role, agent_run_id, cause, note, record_kind, record_id, idempotency_key, occurred_at, recorded_at)
SELECT ${columns.join(', ')}
  FROM ${target}
 WHERE (${where}) AND ${ref}.status IS NOT ${quoteLiteral(write.status)}
ON CONFLICT(idempotency_key) DO NOTHING`,
    params: eventParams,
  };

  const entries = Object.entries(write.set ?? {});
  if (entries.length === 0) return [insert];
  const setParams: SqlValue[] = [];
  const setExpr = exprWith(setParams);
  const assignments = entries.map(([column, value]) => {
    checkIdentifier(column, 'column');
    if (column === 'status') throw new Error('task status write: status is set by the event, not set');
    return `${column} = ${setExpr(value)}`;
  });
  // The tasks whose newest event is this write's: the ones it moved, read
  // after the move so a predicate on the old status or a set column still
  // finds them. The key range lets the UNIQUE index find the events.
  const upper = `${write.key};`;
  const moved = `SELECT e.task_id FROM task_events e
                WHERE e.idempotency_key >= ${quoteLiteral(keyPrefix)} AND e.idempotency_key < ${quoteLiteral(upper)}
                  AND e.idempotency_key = ${quoteLiteral(keyPrefix)} || e.task_id
                  AND e.seq = (SELECT MAX(x.seq) FROM task_events x WHERE x.task_id = e.task_id)`;
  const update: BoundStatement = {
    sql: `UPDATE ${target} SET ${assignments.join(', ')} WHERE ${ref}.id IN (${moved})`,
    params: setParams,
  };
  return [insert, update];
}

/** The status move for db.run(sql, params), statement by statement: every value is bound as `?`. */
export function taskStatusMove(write: TaskStatusWrite): BoundStatement[] {
  return buildTaskStatusMove(write, 'bound');
}

/** The status move as text for the sqlite3 CLI: every value is a quoted literal, statements joined by `;`, no trailing `;`. */
export function taskStatusMoveSql(write: TaskStatusWrite): string {
  return buildTaskStatusMove(write, 'inline')
    .map((s) => s.sql)
    .join(';\n');
}

interface StatementRunner {
  run(sql: string, params?: unknown[]): { changes: number | bigint };
}

/** Runs the move on a node:sqlite handle; returns the number of tasks it moved. */
export function runTaskStatusMove(db: StatementRunner, write: TaskStatusWrite): number {
  const statements = taskStatusMove(write);
  let moved = 0;
  statements.forEach((s, i) => {
    const changes = Number(db.run(s.sql, s.params).changes);
    if (i === 0) moved = changes;
  });
  return moved;
}

/** The first event of a task just inserted at pending: provisioned, resting on the task row itself. */
export function taskProvisionedEvent(taskId: number, role: string, cause: TaskEventCause, at: string): BoundStatement {
  return {
    sql: `INSERT INTO task_events (task_id, seq, event_type, from_state, to_state, role, cause, record_kind, record_id, idempotency_key, occurred_at, recorded_at)
SELECT t.id, 1, 'provisioned', NULL, 'pending', ?, ?, 'task', t.id, 'provisioned:' || t.id, ?, ${ISO_NOW}
  FROM tasks t
 WHERE t.id = ? AND t.status = 'pending' AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id)`,
    params: [role, cause, at, taskId],
  };
}

/**
 * A status rewrite for a migration that runs before task_events exists, under
 * that schema version's own state names: no trigger guards tasks yet. The v77
 * backfill then records each task's resulting state.
 */
export function preEventStatusRewriteSql(status: string, extraSet: string, where: string): string {
  return `UPDATE tasks SET status = ${quoteLiteral(status)}${extraSet === '' ? '' : `, ${extraSet}`} WHERE ${where}`;
}
