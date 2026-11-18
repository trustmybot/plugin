/**
 * The one writer of tasks.status (GH 3224): every UPDATE of tasks that sets a
 * status is built here, for node:sqlite callers that bind values and for the
 * hooks and CLI that hand inline SQL text to the sqlite3 CLI. Plain SQL text,
 * in a module the hook bundle can import without the tool layer.
 */
/** The tasks.status CHECK list of schema.sql. */
export const TASK_STATUSES = ['pending', 'running', 'needs_validation', 'completed', 'closed', 'failed', 'escalated'];
export function sqlText(sql, ...params) {
    return { sql, params };
}
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function isSqlText(value) {
    return value !== null && typeof value === 'object';
}
function quoteLiteral(value) {
    if (value === null)
        return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error(`task status write: ${value} is not a SQL number`);
        return String(value);
    }
    return `'${value.replace(/'/g, "''")}'`;
}
function checkStatus(status) {
    if (!TASK_STATUSES.includes(status)) {
        throw new Error(`task status write: '${status}' is not one of ${TASK_STATUSES.join(', ')}`);
    }
}
function checkIdentifier(name, role) {
    if (!IDENTIFIER.test(name))
        throw new Error(`task status write: ${role} '${name}' is not a plain identifier`);
}
function buildTaskStatusUpdate(write, style) {
    checkStatus(write.status);
    const params = [];
    const expr = (value) => {
        if (isSqlText(value)) {
            if (style === 'inline' && value.params.length > 0) {
                throw new Error('task status write: inline SQL text cannot bind params');
            }
            params.push(...value.params);
            return value.sql;
        }
        if (style === 'inline')
            return quoteLiteral(value);
        params.push(value);
        return '?';
    };
    const assignments = [`status = ${quoteLiteral(write.status)}`];
    for (const [column, value] of Object.entries(write.set ?? {})) {
        checkIdentifier(column, 'column');
        if (column === 'status')
            throw new Error('task status write: status is set by the status field, not set');
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
export function taskStatusUpdate(write) {
    return buildTaskStatusUpdate(write, 'bound');
}
/** The status UPDATE as text for the sqlite3 CLI: every value is a quoted literal, no trailing `;`. */
export function taskStatusUpdateSql(write) {
    return buildTaskStatusUpdate(write, 'inline').sql;
}
//# sourceMappingURL=task-status.js.map