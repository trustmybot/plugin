/**
 * TypeScript port of scripts/hooks/lib/db-write.sh (GH 1692): the single write
 * path from a hook into the trajectory DB and the audit-row builders on top of
 * it. Where the .sh prints one stderr line and exits non-zero, these return
 * `{ ok: false, code, error }` with that line as `error`.
 */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { sqlInt, sqlQuote, stripTrailingNewlines } from './db.js';
import { installRoot, posixBasename, posixDirname } from './project-env.js';
import { sqliteRun } from './sqlite-shell.js';

const WRITE_ATTEMPTS = 2;
const BACKOFF_MS = 200;
const DEFAULT_BUSY_MS = 1500;
const DEFAULT_RUN_BUDGET_MS = 3500;
const BUDGET_SPENT_CODE = 5;
const INVALID_CODE = 2;
const AUDIT_EVENTS_REL = 'scripts/hooks/lib/audit-events.txt';

export interface WriteResult {
  ok: boolean;
  code: number;
  /** What sqlite3 printed on stdout (it passes through to the hook's stdout). */
  stdout: string;
  /** The stderr line, without its newline; "" on success. */
  error: string;
}

export interface WriteOptions {
  /** The hook name the .sh derives from $0; defaults to this process's gate name. */
  caller?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AuditOptions extends WriteOptions {
  /** created_at; defaults to nowIso(). */
  now?: string;
  /** The audit-events.txt to check against; defaults to the install's own. */
  eventsFile?: string;
}

export interface AuditRow {
  issueId: string;
  branchId: string;
  fromNode: string;
  eventType: string;
  summary: string;
  contentJson: string;
  dedupePaths?: readonly string[];
}

export interface SqlResult {
  code: number;
  sql: string;
  error: string;
}

const spentMs = new WeakMap<object, number>();

function digitsOr(value: string | undefined, fallback: number): number {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}

function busyMs(env: NodeJS.ProcessEnv): number {
  return digitsOr(env.TMB_DB_WRITE_TIMEOUT_MS || undefined, DEFAULT_BUSY_MS);
}

function runBudgetMs(env: NodeJS.ProcessEnv): number {
  return digitsOr(env.TMB_DB_WRITE_RUN_BUDGET_MS || undefined, DEFAULT_RUN_BUDGET_MS);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultCaller(): string {
  const src = posixBasename(process.argv[2] ?? process.argv[1] ?? '');
  return src.endsWith('.sh') ? src.slice(0, -3) : src;
}

/** tmb_now_iso: UTC ISO-8601 with a zero millisecond field, the server's nowISO shape. */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

/** The time tmb_db_write calls under <env> have spent of the run budget. */
export function dbWriteSpentMs(env: NodeJS.ProcessEnv = process.env): number {
  return spentMs.get(env) ?? 0;
}

const BUSY_PATTERN = /database is locked|SQLITE_BUSY|database is busy/;

/**
 * tmb_db_write <db> <sql>: <sql> as one BEGIN IMMEDIATE transaction with
 * foreign keys on, two attempts on a busy DB, each bounded by what is left of
 * the run budget the writes under one env share.
 */
export function dbWrite(db: string, sql: string, opts: WriteOptions = {}): WriteResult {
  const env = opts.env ?? process.env;
  const caller = opts.caller ?? defaultCaller();
  if (db === '' || !isFile(db)) {
    return { ok: false, code: 1, stdout: '', error: `tmb_db_write: ${caller}: database not found: ${db || '<empty>'}` };
  }
  const script = `${stripTrailingNewlines(`PRAGMA foreign_keys = ON;\nBEGIN IMMEDIATE;\n${sql}\nCOMMIT;\n`)}\n`;
  const busy = busyMs(env);
  const budget = runBudgetMs(env);
  const start = performance.now();
  const left = () => budget - (spentMs.get(env) ?? 0) - (performance.now() - start);
  let code = BUDGET_SPENT_CODE;
  let err = '';
  let stdout = '';
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const remaining = left();
    if (remaining <= 0) {
      err = `run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=${budget})${err ? `; last error: ${err}` : ''}`;
      code = BUDGET_SPENT_CODE;
      break;
    }
    const waitMs = Math.min(busy, Math.ceil(remaining));
    const r = sqliteRun({ target: db, readonly: false, timeoutMs: waitMs, script, bail: true }, env);
    stdout += r.stdout;
    code = r.code;
    err = stripTrailingNewlines(r.stderr);
    if (code === 0) break;
    if (!BUSY_PATTERN.test(err)) break;
    if (attempt < WRITE_ATTEMPTS && left() > BACKOFF_MS) sleepMs(BACKOFF_MS);
  }
  spentMs.set(env, (spentMs.get(env) ?? 0) + (performance.now() - start));
  if (code === 0) return { ok: true, code: 0, stdout, error: '' };
  const detail = (err || `sqlite3 exited ${code}`).split('\n')[0];
  return { ok: false, code, stdout, error: `tmb_db_write: ${caller}: ${detail}` };
}

/** _tmb_from_node_valid: hook:<name> or system. */
export function fromNodeValid(fromNode: string): boolean {
  return fromNode === 'system' || /^hook:[a-z0-9-]+$/.test(fromNode);
}

/** _tmb_audit_writer: the audit-events.ts writer a from_node writes as. */
export function auditWriter(fromNode: string): string {
  if (fromNode.startsWith('hook:')) return 'hook';
  return fromNode === 'system' ? 'server' : '';
}

/** The audit-events.txt this install ships, read at runtime (never inlined). */
export function auditEventsFile(env: NodeJS.ProcessEnv = process.env): string {
  const here = posixDirname(fileURLToPath(import.meta.url));
  const root = installRoot(here) ?? env.CLAUDE_PLUGIN_ROOT ?? here;
  return `${root}/${AUDIT_EVENTS_REL}`;
}

function eventWriters(file: string, eventType: string): string | null {
  if (eventType === '') return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const trimmed = line.replace(/^\t+/, '').replace(/\t+$/, '');
    const tab = trimmed.indexOf('\t');
    const ev = tab < 0 ? trimmed : trimmed.slice(0, tab);
    if (ev === eventType) return tab < 0 ? '' : trimmed.slice(tab).replace(/^\t+/, '');
  }
  return null;
}

function readable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * tmb_audit_writer_check <label> <event_type> <writer>: code 2 and the error
 * when the event list is unreadable, the event is not in it, or <writer> may
 * not write it.
 */
export function auditWriterCheck(
  label: string,
  eventType: string,
  writer: string,
  opts: { eventsFile?: string; env?: NodeJS.ProcessEnv } = {},
): { code: 0 | 2; error: string } {
  const file = opts.eventsFile ?? auditEventsFile(opts.env);
  if (!readable(file)) {
    return {
      code: 2,
      error: `${label}: audit event list missing or unreadable: ${file} (run npm run build in mcp/trajectory-server)`,
    };
  }
  const writers = eventWriters(file, eventType);
  if (writers === null) {
    return {
      code: 2,
      error: `${label}: unknown event_type '${eventType}' (not in ${file}; add it to mcp/trajectory-server/src/audit-events.ts and rebuild)`,
    };
  }
  if (`,${writers},`.includes(`,${writer},`)) return { code: 0, error: '' };
  return {
    code: 2,
    error: `${label}: audit_event_not_writable_by_role: '${writer}' may not write '${eventType}' (writers: ${writers})`,
  };
}

const DEDUPE_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/**
 * tmb_audit_dedupe_guard <event_type> <content_json> <json_path>...: the SQL
 * condition that no audit row of <event_type> already matches <content_json>
 * at every path.
 */
export function dedupeGuard(
  eventType: string,
  contentJson: string,
  paths: readonly string[],
  opts: { caller?: string } = {},
): SqlResult {
  const caller = opts.caller ?? defaultCaller();
  if (paths.length === 0) {
    return { code: INVALID_CODE, sql: '', error: `tmb_audit_append: ${caller}: dedupe guard needs at least one json path` };
  }
  const safeContent = sqlQuote(contentJson || '{}');
  let cond = '';
  for (const path of paths) {
    if (!DEDUPE_PATH.test(path)) {
      return { code: INVALID_CODE, sql: '', error: `tmb_audit_append: ${caller}: invalid dedupe json path '${path}'` };
    }
    cond += ` AND json_extract(d.content_json, '${path}') IS json_extract('${safeContent}', '${path}')`;
  }
  return {
    code: 0,
    sql: `NOT EXISTS (SELECT 1 FROM audit d WHERE d.event_type = '${sqlQuote(eventType)}' AND json_valid(d.content_json)${cond})`,
    error: '',
  };
}

/**
 * tmb_audit_sql: one validated INSERT INTO audit statement (without the
 * trailing newline the .sh prints), conditional on <guardSql> when given.
 */
export function auditSql(row: AuditRow, guardSql = '', opts: AuditOptions = {}): SqlResult {
  const caller = opts.caller ?? defaultCaller();
  const label = `tmb_audit_append: ${caller}`;
  if (!fromNodeValid(row.fromNode)) {
    return { code: INVALID_CODE, sql: '', error: `${label}: invalid from_node '${row.fromNode}' (want hook:<name> or system)` };
  }
  const check = auditWriterCheck(label, row.eventType, auditWriter(row.fromNode), opts);
  if (check.code !== 0) return { code: INVALID_CODE, sql: '', error: check.error };
  const issue = row.issueId === '-1' ? '-1' : sqlInt(row.issueId);
  if (issue === '') return { code: INVALID_CODE, sql: '', error: `${label}: invalid issue_id '${row.issueId}'` };
  const branch = row.branchId === '' ? 'NULL' : `'${sqlQuote(row.branchId)}'`;
  const where = guardSql === '' ? '' : ` WHERE ${guardSql}`;
  const sql =
    'INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at) ' +
    `SELECT ${issue}, ${branch}, '${sqlQuote(row.fromNode)}', '${sqlQuote(row.eventType)}', ` +
    `'${sqlQuote(row.summary)}', '${sqlQuote(row.contentJson || '{}')}', ` +
    `(SELECT repo FROM issues WHERE id = ${issue}), '${opts.now ?? nowIso()}'${where};`;
  return { code: 0, sql, error: '' };
}

/**
 * tmb_audit_append <db> <row>: the only way a hook inserts an audit row; with
 * dedupe paths, no row when one of the event already matches at every path.
 */
export function auditAppend(db: string, row: AuditRow, opts: AuditOptions = {}): WriteResult {
  const caller = opts.caller ?? defaultCaller();
  let guard = '';
  if (row.dedupePaths && row.dedupePaths.length > 0) {
    const g = dedupeGuard(row.eventType, row.contentJson, row.dedupePaths, { caller });
    if (g.code !== 0) return { ok: false, code: INVALID_CODE, stdout: '', error: g.error };
    guard = g.sql;
  }
  const s = auditSql(row, guard, { ...opts, caller });
  if (s.code !== 0) return { ok: false, code: INVALID_CODE, stdout: '', error: s.error };
  return dbWrite(db, s.sql, { caller, env: opts.env });
}
