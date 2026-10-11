import { DatabaseSync } from 'node:sqlite';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import {
  DATA_CONTRACTS,
  contractHolds,
  schemaTooOldReason,
  contractParamValues,
  type Contract,
  type ContractExpect,
  type ContractSeverity,
} from '../data-contracts.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

export const STATEMENT_TIMEOUT_MS_DEFAULT = 2000;

export interface DoctorViolation {
  id: string;
  severity: ContractSeverity;
  description: string;
  actual: number | null;
  expected: ContractExpect;
  sample: Array<Record<string, unknown>>;
}

export interface DoctorReport {
  healthy: boolean;
  checked_at: string;
  /** plugin_meta.schema_version of the checked DB (null when unreadable) and the version every contract needs. */
  schema: { stored: number | null; required: number; current: boolean };
  violations: DoctorViolation[];
  skipped: Array<{ id: string; reason: string }>;
}

/** A read-only view of the DB the contracts run against. */
export interface ContractReader {
  get(sql: string, params: Record<string, number>): Record<string, unknown> | undefined;
  all(sql: string, params: Record<string, number>): Array<Record<string, unknown>>;
}

const bind = (params: Record<string, number>): unknown[] => (Object.keys(params).length > 0 ? [params] : []);

export function trajectoryDbReader(db: TrajectoryDB): ContractReader {
  return {
    get: (sql, params) => db.get<Record<string, unknown>>(sql, bind(params)),
    all: (sql, params) => db.all<Record<string, unknown>>(sql, bind(params)),
  };
}

function sqliteReader(conn: DatabaseSync): ContractReader {
  return {
    get: (sql, params) => conn.prepare(sql).get(...(bind(params) as never[])) as Record<string, unknown> | undefined,
    all: (sql, params) => conn.prepare(sql).all(...(bind(params) as never[])) as Array<Record<string, unknown>>,
  };
}

export function statementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['TMB_DOCTOR_STATEMENT_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : STATEMENT_TIMEOUT_MS_DEFAULT;
}

function readSchemaVersion(reader: ContractReader): number | null {
  try {
    return firstNumber(reader.get('SELECT schema_version FROM plugin_meta LIMIT 1', {}));
  } catch {
    return null;
  }
}

function firstNumber(row: Record<string, unknown> | undefined): number | null {
  if (row === undefined) return null;
  const value = Object.values(row)[0];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

/**
 * Runs each contract once. node:sqlite cannot interrupt a running statement, so
 * a contract whose statement outlives `statementTimeoutMs` is reported as
 * skipped (`timeout`) and its result is discarded; lock waits are bounded by
 * the reader's busy timeout. A contract whose `min_schema` is above the DB's
 * plugin_meta.schema_version is skipped as `schema vN < vM`; nothing migrates.
 * `healthy` is false when an error-severity contract fails or is skipped.
 */
export function runDataContracts(
  reader: ContractReader,
  contracts: readonly Contract[],
  opts: { statementTimeoutMs?: number; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): DoctorReport {
  const timeoutMs = opts.statementTimeoutMs ?? statementTimeoutMs(opts.env);
  const now = opts.now ?? (() => performance.now());
  const stored = readSchemaVersion(reader);
  const required = Math.max(0, ...contracts.map((c) => c.min_schema ?? 0));
  const report: DoctorReport = {
    healthy: true,
    checked_at: nowISO(),
    schema: { stored, required, current: stored === null || stored >= required },
    violations: [],
    skipped: [],
  };

  for (const contract of contracts) {
    if (stored !== null && (contract.min_schema ?? 0) > stored) {
      report.skipped.push({ id: contract.id, reason: schemaTooOldReason(stored, contract.min_schema!) });
      if (contract.severity === 'error') report.healthy = false;
      continue;
    }
    const params = contractParamValues(contract, opts.env);
    const started = now();
    let actual: number | null;
    try {
      actual = firstNumber(reader.get(contract.sql, params));
    } catch (e) {
      report.skipped.push({ id: contract.id, reason: `error: ${(e as Error).message}` });
      if (contract.severity === 'error') report.healthy = false;
      continue;
    }
    const elapsed = Math.round(now() - started);
    if (elapsed > timeoutMs) {
      report.skipped.push({ id: contract.id, reason: `timeout: ${elapsed}ms > ${timeoutMs}ms` });
      if (contract.severity === 'error') report.healthy = false;
      continue;
    }
    if (contractHolds(actual, contract.expect)) continue;

    let sample: Array<Record<string, unknown>> = [];
    if (contract.sample_sql) {
      try {
        sample = reader.all(contract.sample_sql, params);
      } catch {
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
    if (contract.severity === 'error') report.healthy = false;
  }
  return report;
}

// A separate read-only connection for a file DB: the checks cannot write, and
// their lock waits are bounded by the statement timeout. When it cannot open or
// read (a WAL DB with no -shm file opened read-only), the server's own
// connection runs the same read-only SELECTs.
function openReadOnly(dbPath: string, timeoutMs: number): DatabaseSync | null {
  if (!dbPath || dbPath === ':memory:') return null;
  for (const readOnly of [true, false]) {
    let conn: DatabaseSync | null = null;
    try {
      conn = new DatabaseSync(dbPath, { readOnly });
      conn.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
      conn.exec('PRAGMA query_only = ON');
      conn.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      return conn;
    } catch {
      conn?.close();
    }
  }
  return null;
}

/** The contracts named by `ids` (all when undefined), or an error naming the unknown ones. */
export function selectContracts(ids: unknown): { contracts: readonly Contract[] } | { error: string; known_ids?: string[] } {
  if (ids === undefined) return { contracts: DATA_CONTRACTS };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return { error: 'ids must be an array of contract id strings' };
  }
  const known = DATA_CONTRACTS.map((c) => c.id);
  const unknown = (ids as string[]).filter((id) => !known.includes(id));
  if (unknown.length > 0) return { error: `unknown contract id(s): ${unknown.join(', ')}`, known_ids: known };
  const wanted = new Set(ids as string[]);
  return { contracts: DATA_CONTRACTS.filter((c) => wanted.has(c.id)) };
}

/**
 * Runs the contracts against a DB file on a query-only connection, without
 * opening it as a TrajectoryDB: no schema is applied and nothing migrates, so
 * an older DB is reported as it is. Throws when the file cannot be opened.
 */
export function checkTrajectoryDbFile(
  dbPath: string,
  contracts: readonly Contract[] = DATA_CONTRACTS,
  opts: { env?: NodeJS.ProcessEnv } = {},
): DoctorReport {
  const timeoutMs = statementTimeoutMs(opts.env);
  const conn = openReadOnly(dbPath, timeoutMs);
  if (!conn) throw new Error(`cannot open ${dbPath} read-only`);
  try {
    return runDataContracts(sqliteReader(conn), contracts, { statementTimeoutMs: timeoutMs, env: opts.env });
  } finally {
    conn.close();
  }
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }) }], isError: true };
}

export function trajectoryDoctorTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'trajectory_doctor',
      description:
        'Check the trajectory DB against its data contracts (read-only). Returns {healthy, violations, skipped}; record:true logs one trajectory_doctor_run audit row.',
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

  const handler: Fn = async (args) => {
    const record = args['record'] === true;
    const selected = selectContracts(args['ids']);
    if ('error' in selected) {
      const { error, ...extra } = selected;
      return err(error, extra);
    }
    const contracts = selected.contracts;

    const timeoutMs = statementTimeoutMs();
    const ro = openReadOnly(db.dbPath, timeoutMs);
    let report: DoctorReport;
    try {
      report = runDataContracts(ro ? sqliteReader(ro) : trajectoryDbReader(db), contracts, { statementTimeoutMs: timeoutMs });
    } finally {
      ro?.close();
    }

    if (!record) return ok(report);
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
        } catch (e) {
          return err((e as Error).message);
        }
      }),
    },
  };
}
