import { DatabaseSync } from 'node:sqlite';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { embeddingStatus } from '../embeddings/model.js';
import { DATA_CONTRACTS, contractHolds, schemaTooOldReason, contractParamValues, } from '../data-contracts.js';
export const STATEMENT_TIMEOUT_MS_DEFAULT = 2000;
const bind = (params) => (Object.keys(params).length > 0 ? [params] : []);
export function trajectoryDbReader(db) {
    return {
        get: (sql, params) => db.get(sql, bind(params)),
        all: (sql, params) => db.all(sql, bind(params)),
    };
}
function sqliteReader(conn) {
    return {
        get: (sql, params) => conn.prepare(sql).get(...bind(params)),
        all: (sql, params) => conn.prepare(sql).all(...bind(params)),
    };
}
export function statementTimeoutMs(env = process.env) {
    const raw = Number(env['TMB_DOCTOR_STATEMENT_TIMEOUT_MS']);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : STATEMENT_TIMEOUT_MS_DEFAULT;
}
function readSchemaVersion(reader) {
    try {
        return firstNumber(reader.get('SELECT schema_version FROM plugin_meta LIMIT 1', {}));
    }
    catch {
        return null;
    }
}
function firstNumber(row) {
    if (row === undefined)
        return null;
    const value = Object.values(row)[0];
    if (typeof value === 'number')
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    return null;
}
/**
 * Runs each contract once. node:sqlite cannot interrupt a running statement, so
 * a contract whose statement outlives `statementTimeoutMs` is reported as
 * skipped (`timeout`) and its result is discarded; lock waits are bounded by
 * the reader's busy timeout. A contract whose `min_schema` is above the DB's
 * plugin_meta.schema_version is skipped as `schema vN < vM`; nothing migrates.
 * A file contract reads its own inputs; when they are unavailable it is
 * skipped with its reason and does not affect `healthy`. A DB contract whose
 * `skip_when` SELECT returns non-zero is skipped with that reason, likewise
 * without affecting `healthy`.
 * `healthy` is false when an error-severity contract fails or a DB contract
 * is skipped.
 */
export function runDataContracts(reader, contracts, opts = {}) {
    const timeoutMs = opts.statementTimeoutMs ?? statementTimeoutMs(opts.env);
    const now = opts.now ?? (() => performance.now());
    const stored = readSchemaVersion(reader);
    const required = Math.max(0, ...contracts.map((c) => c.min_schema ?? 0));
    const report = {
        healthy: true,
        checked_at: nowISO(),
        schema: { stored, required, current: stored === null || stored >= required },
        violations: [],
        skipped: [],
    };
    for (const contract of contracts) {
        if (contract.source === 'files') {
            const result = contract.check(opts.env ?? process.env, opts.dbPath === undefined ? {} : { dbPath: opts.dbPath });
            if ('skipped' in result) {
                report.skipped.push({ id: contract.id, reason: result.skipped });
                continue;
            }
            if (contractHolds(result.actual, contract.expect))
                continue;
            report.violations.push({
                id: contract.id,
                severity: contract.severity,
                description: contract.description,
                actual: result.actual,
                expected: contract.expect,
                sample: result.sample,
            });
            if (contract.severity === 'error')
                report.healthy = false;
            continue;
        }
        if (stored !== null && (contract.min_schema ?? 0) > stored) {
            report.skipped.push({ id: contract.id, reason: schemaTooOldReason(stored, contract.min_schema) });
            if (contract.severity === 'error')
                report.healthy = false;
            continue;
        }
        const params = contractParamValues(contract, opts.env);
        const started = now();
        let actual;
        try {
            if (contract.skip_when && firstNumber(reader.get(contract.skip_when.sql, params))) {
                report.skipped.push({ id: contract.id, reason: contract.skip_when.reason });
                continue;
            }
            actual = firstNumber(reader.get(contract.sql, params));
        }
        catch (e) {
            report.skipped.push({ id: contract.id, reason: `error: ${e.message}` });
            if (contract.severity === 'error')
                report.healthy = false;
            continue;
        }
        const elapsed = Math.round(now() - started);
        if (elapsed > timeoutMs) {
            report.skipped.push({ id: contract.id, reason: `timeout: ${elapsed}ms > ${timeoutMs}ms` });
            if (contract.severity === 'error')
                report.healthy = false;
            continue;
        }
        if (contractHolds(actual, contract.expect))
            continue;
        let sample = [];
        if (contract.sample_sql) {
            try {
                sample = reader.all(contract.sample_sql, params);
            }
            catch {
                sample = [];
            }
        }
        report.violations.push({
            id: contract.id,
            severity: contract.severity,
            description: contract.description,
            actual,
            expected: contract.expect,
            sample,
        });
        if (contract.severity === 'error')
            report.healthy = false;
    }
    return report;
}
// A separate read-only connection for a file DB: the checks cannot write, and
// their lock waits are bounded by the statement timeout. When it cannot open or
// read (a WAL DB with no -shm file opened read-only), the server's own
// connection runs the same read-only SELECTs.
function openReadOnly(dbPath, timeoutMs) {
    if (!dbPath || dbPath === ':memory:')
        return null;
    for (const readOnly of [true, false]) {
        let conn = null;
        try {
            conn = new DatabaseSync(dbPath, { readOnly });
            conn.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
            conn.exec('PRAGMA query_only = ON');
            conn.prepare('SELECT COUNT(*) FROM sqlite_master').get();
            return conn;
        }
        catch {
            conn?.close();
        }
    }
    return null;
}
/** The contracts named by `ids` (all when undefined), or an error naming the unknown ones. */
export function selectContracts(ids) {
    if (ids === undefined)
        return { contracts: DATA_CONTRACTS };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        return { error: 'ids must be an array of contract id strings' };
    }
    const known = DATA_CONTRACTS.map((c) => c.id);
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length > 0)
        return { error: `unknown contract id(s): ${unknown.join(', ')}`, known_ids: known };
    const wanted = new Set(ids);
    return { contracts: DATA_CONTRACTS.filter((c) => wanted.has(c.id)) };
}
/**
 * Runs the contracts against a DB file on a query-only connection, without
 * opening it as a TrajectoryDB: no schema is applied and nothing migrates, so
 * an older DB is reported as it is. Throws when the file cannot be opened.
 */
export function checkTrajectoryDbFile(dbPath, contracts = DATA_CONTRACTS, opts = {}) {
    const timeoutMs = statementTimeoutMs(opts.env);
    const conn = openReadOnly(dbPath, timeoutMs);
    if (!conn)
        throw new Error(`cannot open ${dbPath} read-only`);
    try {
        return runDataContracts(sqliteReader(conn), contracts, { statementTimeoutMs: timeoutMs, env: opts.env, dbPath });
    }
    finally {
        conn.close();
    }
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }) }], isError: true };
}
export function trajectoryDoctorTools(db) {
    const definitions = [
        {
            name: 'trajectory_doctor',
            description: 'Check the trajectory DB against its data contracts (read-only). Returns {healthy, violations, skipped, embeddings}; record:true logs one trajectory_doctor_run audit row.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    record: { type: 'boolean', description: 'Write one trajectory_doctor_run audit row with the report. Default false.' },
                    ids: { type: 'array', items: { type: 'string' }, description: 'Run only these contract ids.' },
                },
                required: ['agent'],
            },
        },
    ];
    const handler = async (args) => {
        const record = args['record'] === true;
        const selected = selectContracts(args['ids']);
        if ('error' in selected) {
            const { error, ...extra } = selected;
            return err(error, extra);
        }
        const contracts = selected.contracts;
        const timeoutMs = statementTimeoutMs();
        const ro = openReadOnly(db.dbPath, timeoutMs);
        let report;
        try {
            report = runDataContracts(ro ? sqliteReader(ro) : trajectoryDbReader(db), contracts, {
                statementTimeoutMs: timeoutMs,
                dbPath: db.dbPath,
            });
        }
        finally {
            ro?.close();
        }
        report.embeddings = embeddingStatus();
        if (!record)
            return ok(report);
        const auditId = insertAudit(db, {
            issue_id: -1,
            from_node: 'bro',
            event_type: 'trajectory_doctor_run',
            summary: report.healthy
                ? `trajectory_doctor: healthy (${report.violations.length} warn violation(s), ${report.skipped.length} skipped)`
                : `trajectory_doctor: unhealthy — ${report.violations.length} violation(s), ${report.skipped.length} skipped`,
            content_json: JSON.stringify(report),
        });
        return ok({ ...report, audit_id: auditId });
    };
    return {
        definitions,
        handlers: {
            trajectory_doctor: requireRoles('trajectory_doctor', ['bro'], async (args) => {
                try {
                    return await handler(args);
                }
                catch (e) {
                    return err(e.message);
                }
            }),
        },
    };
}
//# sourceMappingURL=trajectory-doctor.js.map