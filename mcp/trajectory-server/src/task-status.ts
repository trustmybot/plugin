/**
 * The one writer of tasks.status (GH 3224): every UPDATE of tasks that sets a
 * status is built here, for node:sqlite callers that bind values and for the
 * hooks and CLI that hand inline SQL text to the sqlite3 CLI. Plain SQL text,
 * in a module the hook bundle can import without the tool layer.
 */

/** The tasks.status CHECK list of schema.sql. */
export const TASK_STATUSES = ['pending', 'running', 'needs_validation', 'completed', 'closed', 'failed', 'escalated'] as const;
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

export interface TaskStatusWrite {
  readonly status: TaskStatus;
  /** The other columns to set, in order: a value, or SQL text such as `COALESCE(completed_at, ?)`. */
  readonly set?: Readonly<Record<string, SqlValue | SqlText>>;
  /** Plain text binds nothing here: a `?` in it is left for the caller to bind after `params`. */
  readonly where: string | SqlText;
  readonly alias?: string;
}

export interface BoundStatement {
  readonly sql: string;
  readonly params: SqlValue[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

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

function buildTaskStatusUpdate(write: TaskStatusWrite, style: 'bound' | 'inline'): BoundStatement {
  checkStatus(write.status);
  const params: SqlValue[] = [];
  const expr = (value: SqlValue | SqlText): string => {
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

  const assignments = [`status = ${quoteLiteral(write.status)}`];
  for (const [column, value] of Object.entries(write.set ?? {})) {
    checkIdentifier(column, 'column');
    if (column === 'status') throw new Error('task status write: status is set by the status field, not set');
    assignments.push(`${column} = ${expr(value)}`);
  }
  let target = 'tasks';
  if (write.alias !== undefined) {
    checkIdentifier(write.alias, 'alias');
    target = `tasks AS ${write.alias}`;
  }
  const where = typeof write.where === 'string' ? write.where : expr(write.where);
  return { sql: `UPDATE ${target} SET ${assignments.join(', ')} WHERE ${where}`, params };
}

/** The status UPDATE for db.run(sql, params): every value is bound as `?`. */
export function taskStatusUpdate(write: TaskStatusWrite): BoundStatement {
  return buildTaskStatusUpdate(write, 'bound');
}

/** The status UPDATE as text for the sqlite3 CLI: every value is a quoted literal, no trailing `;`. */
export function taskStatusUpdateSql(write: TaskStatusWrite): string {
  return buildTaskStatusUpdate(write, 'inline').sql;
}
