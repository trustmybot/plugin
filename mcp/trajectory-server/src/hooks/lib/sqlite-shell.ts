/**
 * One sqlite3 invocation as the shell hook libs make it (GH 1692): through
 * node:sqlite when this Node ships it unflagged, else through the sqlite3 CLI
 * with the exact args the .sh passes. The node path reproduces what the CLI
 * prints in list mode (`|`-separated, no header), its exit codes (arg mode: the
 * primary error code of the first failure; stdin mode: 1 on any error) and the
 * first stderr line of a stdin-mode error, so callers read either path alike.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { performance } from 'node:perf_hooks';

type SqliteModule = typeof import('node:sqlite');
type Database = InstanceType<SqliteModule['DatabaseSync']>;
type SqlValue = null | bigint | number | string | Uint8Array;

export interface SqliteCall {
  target: string;
  readonly: boolean;
  timeoutMs: number;
  /** Arg mode: the SQL is the CLI's last argument. */
  sql?: string;
  /** Stdin mode: the script piped into the CLI. */
  script?: string;
  bail?: boolean;
  /** The kill-after budget of _tmb_budget_run: exceeded → code 124. */
  killAfterMs?: number;
}

export interface SqliteResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SqliteBackend = 'node' | 'cli';

const KILLED_CODE = 124;
const NOT_FOUND_CODE = 127;
const MAX_BUFFER = 64 * 1024 * 1024;

let nodeSqlite: SqliteModule | null | undefined;

function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  const opt = rest[0];
  const type =
    typeof opt === 'string'
      ? opt
      : opt !== null && typeof opt === 'object' && typeof (opt as { type?: unknown }).type === 'string'
        ? (opt as { type: string }).type
        : warning instanceof Error
          ? warning.name
          : '';
  return type === 'ExperimentalWarning' && /sqlite/i.test(message);
}

/**
 * node:sqlite through process.getBuiltinModule (no flag needed, no throw on a
 * Node that lacks it), with only its ExperimentalWarning suppressed while it
 * loads. Null when this Node has no usable node:sqlite (setReturnArrays is
 * needed to read duplicate column names as the CLI prints them).
 */
export function loadNodeSqlite(): SqliteModule | null {
  if (nodeSqlite !== undefined) return nodeSqlite;
  const original = process.emitWarning;
  process.emitWarning = function filtered(this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = typeof get === 'function' ? (get.call(process, 'node:sqlite') as SqliteModule | undefined) : undefined;
    nodeSqlite =
      mod && typeof mod.DatabaseSync === 'function' && typeof mod.StatementSync?.prototype?.setReturnArrays === 'function'
        ? mod
        : null;
  } catch {
    nodeSqlite = null;
  } finally {
    process.emitWarning = original;
  }
  return nodeSqlite;
}

/** `cli` when TMB_HOOKS_SQLITE=cli or this Node has no usable node:sqlite. */
export function sqliteBackend(env: NodeJS.ProcessEnv = process.env): SqliteBackend {
  return env.TMB_HOOKS_SQLITE === 'cli' || loadNodeSqlite() === null ? 'cli' : 'node';
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(':')) {
    try {
      accessSync(`${dir === '' ? '.' : dir}/${command}`, constants.X_OK);
      return true;
    } catch {
      /* next dir */
    }
  }
  return false;
}

/** tmb_have_sqlite: a SQLite engine this process can read with. */
export function haveSqlite(env: NodeJS.ProcessEnv = process.env): boolean {
  return sqliteBackend(env) === 'node' || onPath('sqlite3', env);
}

export function sqliteRun(call: SqliteCall, env: NodeJS.ProcessEnv = process.env): SqliteResult {
  const sqlite = sqliteBackend(env) === 'node' ? loadNodeSqlite() : null;
  return sqlite ? runNode(sqlite, call) : runCli(call, env);
}

export function cliArgs(call: SqliteCall): string[] {
  const args: string[] = [];
  if (call.bail) args.push('-bail');
  if (call.readonly) args.push('-readonly');
  args.push('-cmd', `.timeout ${call.timeoutMs}`, call.target);
  if (call.sql !== undefined) args.push(call.sql);
  return args;
}

function runCli(call: SqliteCall, env: NodeJS.ProcessEnv): SqliteResult {
  const r = spawnSync('sqlite3', cliArgs(call), {
    env,
    input: call.sql === undefined ? (call.script ?? '') : undefined,
    stdio: [call.sql === undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    ...(call.killAfterMs !== undefined ? { timeout: call.killAfterMs, killSignal: 'SIGKILL' as const } : {}),
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const errno = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === 'ENOENT') return { code: NOT_FOUND_CODE, stdout: '', stderr: 'sqlite3: command not found\n' };
  if (errno === 'ETIMEDOUT' || r.signal === 'SIGKILL') return { code: KILLED_CODE, stdout: '', stderr: '' };
  if (r.error) return { code: 1, stdout, stderr: stderr || `${r.error.message}\n` };
  return { code: r.status ?? 1, stdout, stderr };
}

// ── node:sqlite emulation of the sqlite3 shell ──────────────────────────────

type TokenKind = 'semi' | 'ws' | 'other' | 'explain' | 'create' | 'temp' | 'trigger' | 'end';
const TOKEN_COLUMN: Record<TokenKind, number> = {
  semi: 0,
  ws: 1,
  other: 2,
  explain: 3,
  create: 4,
  temp: 5,
  trigger: 6,
  end: 7,
};
const COMPLETE_TRANS: readonly (readonly number[])[] = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5],
];

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  param?: string;
}

interface Scan {
  tokens: Token[];
  unterminated: boolean;
}

function isIdChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function keywordKind(word: string): TokenKind {
  switch (word.toLowerCase()) {
    case 'create':
      return 'create';
    case 'trigger':
      return 'trigger';
    case 'temp':
    case 'temporary':
      return 'temp';
    case 'end':
      return 'end';
    case 'explain':
      return 'explain';
    default:
      return 'other';
  }
}

/** The token stream sqlite3_complete walks, plus the named parameters it holds. */
function scanSql(sql: string): Scan {
  const tokens: Token[] = [];
  let unterminated = false;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i];
    if (ch === ';') {
      tokens.push({ kind: 'semi', start, end: ++i });
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r') {
      tokens.push({ kind: 'ws', start, end: ++i });
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close < 0) {
        unterminated = true;
        i = sql.length;
      } else {
        i = close + 2;
      }
      tokens.push({ kind: 'ws', start, end: i });
    } else if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      tokens.push({ kind: 'ws', start, end: i });
    } else if (ch === '[' || ch === '`' || ch === '"' || ch === "'") {
      const close = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
      if (close < 0) {
        unterminated = true;
        i = sql.length;
      } else {
        i = close + 1;
      }
      tokens.push({ kind: 'other', start, end: i });
    } else if ((ch === ':' || ch === '@') && isIdChar(sql[i + 1])) {
      i += 1;
      while (isIdChar(sql[i])) i += 1;
      tokens.push({ kind: 'other', start, end: i, param: sql.slice(start, i) });
    } else if (isIdChar(ch)) {
      while (isIdChar(sql[i])) i += 1;
      const word = sql.slice(start, i);
      tokens.push(
        word.startsWith('$') && word.length > 1
          ? { kind: 'other', start, end: i, param: word }
          : { kind: keywordKind(word), start, end: i },
      );
    } else {
      tokens.push({ kind: 'other', start, end: ++i });
    }
  }
  return { tokens, unterminated };
}

/** sqlite3_complete: the text ends a whole statement (triggers included). */
export function sqlComplete(sql: string): boolean {
  const { tokens, unterminated } = scanSql(sql);
  if (unterminated) return false;
  let state = 0;
  for (const t of tokens) state = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
  return state === 1;
}

interface Statement {
  text: string;
  params: string[];
}

/** The statements sqlite3_prepare's tail loop would run from <sql>, in order. */
export function splitStatements(sql: string): Statement[] {
  const { tokens } = scanSql(sql);
  const out: Statement[] = [];
  let state = 0;
  let begin = 0;
  let dark = false;
  let params = new Set<string>();
  const flush = (end: number) => {
    if (dark) out.push({ text: sql.slice(begin, end), params: [...params] });
    begin = end;
    dark = false;
    params = new Set();
  };
  for (const t of tokens) {
    const next = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
    if (t.kind !== 'ws' && t.kind !== 'semi') dark = true;
    if (t.param) params.add(t.param);
    state = next;
    if (t.kind === 'semi' && next === 1) flush(t.end);
  }
  flush(sql.length);
  return out;
}

/** sqlite's `%!.15g`, the CLI's text for a REAL. */
export function formatReal(x: number): string {
  if (x === 0) return '0.0';
  if (Number.isNaN(x)) return '';
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  const [mantissa, expText] = x.toExponential(14).split('e');
  const exp = Number(expText);
  const trim = (digits: string): string => {
    if (!digits.includes('.')) return `${digits}.0`;
    const t = digits.replace(/0+$/, '');
    return t.endsWith('.') ? `${t}0` : t;
  };
  if (exp < -4 || exp >= 15) {
    return `${trim(mantissa)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return trim(x.toFixed(14 - exp));
}

function cutAtNul(text: string): string {
  const nul = text.indexOf('\0');
  return nul < 0 ? text : text.slice(0, nul);
}

/** One value as list mode prints it. */
export function listValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return formatReal(v);
  if (typeof v === 'string') return cutAtNul(v);
  if (v instanceof Uint8Array) return cutAtNul(Buffer.from(v).toString('utf8'));
  return String(v);
}

interface SqliteFailure {
  code: number;
  message: string;
}

function failure(e: unknown): SqliteFailure {
  const err = e as { errcode?: unknown; message?: unknown } | null;
  const ext = err && typeof err.errcode === 'number' ? err.errcode : 1;
  return {
    code: ext & 0xff || 1,
    message: err && typeof err.message === 'string' ? err.message : String(e),
  };
}

function withCode(f: SqliteFailure): string {
  return f.code > 1 ? `${f.message} (${f.code})` : f.message;
}

class Killed extends Error {}

class ShellSession {
  readonly db: Database;
  private readonly deadline: number;
  private readonly parameters = new Map<string, SqlValue>();
  private busyMs: number;
  stdout = '';
  stderr = '';

  constructor(db: Database, timeoutMs: number, killAfterMs: number | undefined) {
    this.db = db;
    this.busyMs = timeoutMs;
    this.deadline = killAfterMs === undefined ? Infinity : performance.now() + killAfterMs;
    this.applyTimeout(timeoutMs);
  }

  private applyTimeout(ms: number): void {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
  }

  private checkDeadline(): void {
    if (performance.now() >= this.deadline) throw new Killed();
  }

  setTimeout(ms: number): void {
    this.busyMs = ms;
    this.applyTimeout(ms);
  }

  private beforeStatement(): void {
    this.checkDeadline();
    if (this.deadline !== Infinity) {
      this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance.now())));
    }
  }

  /** Runs one statement; null on success, else where and why it failed. */
  run(stmt: Statement): { phase: 'prepare' | 'step'; failure: SqliteFailure } | null {
    this.beforeStatement();
    let prepared: ReturnType<Database['prepare']>;
    try {
      prepared = this.db.prepare(stmt.text);
    } catch (e) {
      this.checkDeadline();
      return { phase: 'prepare', failure: failure(e) };
    }
    try {
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const bound: Record<string, SqlValue> = {};
      for (const name of stmt.params) {
        if (this.parameters.has(name)) bound[name] = this.parameters.get(name) ?? null;
      }
      const rows = Object.keys(bound).length > 0 ? prepared.iterate(bound as never) : prepared.iterate();
      for (const row of rows as Iterable<unknown>) {
        const values = Array.isArray(row) ? row : Object.values(row as object);
        this.stdout += `${values.map(listValue).join('|')}\n`;
      }
    } catch (e) {
      this.checkDeadline();
      return { phase: 'step', failure: failure(e) };
    }
    this.checkDeadline();
    return null;
  }

  evalParameter(value: string): SqlValue {
    try {
      const prepared = this.db.prepare(`SELECT ${value}`);
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const rows = prepared.all() as unknown as SqlValue[][];
      if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
    } catch {
      /* stored as text */
    }
    return value;
  }

  setParameter(name: string, value: string): void {
    this.parameters.set(name, this.evalParameter(value));
  }

  clearParameters(): void {
    this.parameters.clear();
  }
}

function openSession(sqlite: SqliteModule, call: SqliteCall): ShellSession | SqliteFailure {
  try {
    const db = new sqlite.DatabaseSync(call.target, { readOnly: call.readonly });
    return new ShellSession(db, call.timeoutMs, call.killAfterMs);
  } catch (e) {
    return failure(e);
  }
}

function closeSession(session: ShellSession): void {
  try {
    session.db.close();
  } catch {
    /* already closed */
  }
}

function runNode(sqlite: SqliteModule, call: SqliteCall): SqliteResult {
  const opened = openSession(sqlite, call);
  if (!(opened instanceof ShellSession)) {
    return {
      code: call.sql !== undefined ? opened.code : 1,
      stdout: '',
      stderr: `Error: unable to open database "${call.target}": ${opened.message}\n`,
    };
  }
  try {
    const code = call.sql !== undefined ? runArgMode(opened, call.sql) : runStdinMode(opened, call.script ?? '', !!call.bail);
    return { code, stdout: opened.stdout, stderr: opened.stderr };
  } catch (e) {
    if (e instanceof Killed) return { code: KILLED_CODE, stdout: '', stderr: '' };
    throw e;
  } finally {
    closeSession(opened);
  }
}

function runArgMode(session: ShellSession, sql: string): number {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      session.stderr += `Error: ${failed.phase === 'prepare' ? 'in prepare' : 'stepping'}, ${withCode(failed.failure)}\n`;
      return failed.failure.code;
    }
  }
  return 0;
}

interface QuickScan {
  wait: string;
  dark: boolean;
  semi: boolean;
}

const QSS_START: QuickScan = { wait: '', dark: false, semi: false };

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r';
}

/** The CLI's quickscan: string/comment state, dark text, a trailing `;`. */
function quickscan(line: string, prev: QuickScan): QuickScan {
  const q = { ...prev };
  let i = 0;
  for (;;) {
    if (q.wait === '') {
      let jumped = false;
      while (i < line.length) {
        const ch = line[i++];
        if (isSpace(ch)) continue;
        if (ch === '-' && line[i] === '-') return q;
        if (ch === ';') {
          q.semi = true;
          continue;
        }
        if (ch === '/' && line[i] === '*') {
          i += 1;
          q.wait = '*';
          jumped = true;
          break;
        }
        if (ch === '[' || ch === '`' || ch === "'" || ch === '"') {
          q.wait = ch === '[' ? ']' : ch;
          q.dark = true;
          q.semi = false;
          jumped = true;
          break;
        }
        q.semi = false;
        q.dark = true;
      }
      if (!jumped) return q;
    } else {
      let jumped = false;
      while (i < line.length) {
        const ch = line[i++];
        if (ch !== q.wait) continue;
        if (q.wait === '*') {
          if (line[i] !== '/') continue;
          i += 1;
        } else if (q.wait !== ']' && line[i] === q.wait) {
          i += 1;
          continue;
        }
        q.wait = '';
        jumped = true;
        break;
      }
      if (!jumped) return q;
    }
  }
}

function plainWhite(q: QuickScan): boolean {
  return q.wait === '' && !q.dark;
}

function semiTerminated(q: QuickScan): boolean {
  return q.wait === '' && q.semi;
}

function inputLines(script: string): string[] {
  if (script === '') return [];
  const lines = script.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function metaArgs(line: string): string[] {
  return line.slice(1).trim().split(/\s+/).filter((a) => a !== '');
}

function integerValue(text: string): number {
  const m = /^\s*([+-]?\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** The meta commands hook scripts send; 1 (an error) for any other. */
function runMeta(session: ShellSession, line: string): number {
  const args = metaArgs(line);
  const cmd = args[0] ?? '';
  if (cmd === 'timeout') {
    session.setTimeout(args.length >= 2 ? integerValue(args[1]) : 0);
    return 0;
  }
  if (cmd === 'parameter' || cmd === 'param') {
    const sub = args[1] ?? '';
    if ((sub === 'clear' || sub === 'init') && args.length === 2) {
      if (sub === 'clear') session.clearParameters();
      return 0;
    }
    if (sub === 'set' && args.length === 4) {
      session.setParameter(args[2], args[3]);
      return 0;
    }
  }
  session.stderr += `Error: unknown command or invalid arguments:  "${cmd}". Enter ".help" for help\n`;
  return 1;
}

function runChunk(session: ShellSession, sql: string, startLine: number): number {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      const type = failed.phase === 'prepare' ? 'Parse error' : 'Runtime error';
      session.stderr += `${type} near line ${startLine}: ${withCode(failed.failure)}\n`;
      return 1;
    }
  }
  return 0;
}

function runStdinMode(session: ShellSession, script: string, bail: boolean): number {
  let errors = 0;
  let qss = QSS_START;
  let sql = '';
  let startLine = 0;
  let lineNo = 0;
  for (const line of inputLines(script)) {
    if (errors > 0 && bail) break;
    lineNo += 1;
    qss = quickscan(line, qss);
    if (plainWhite(qss) && sql === '') {
      qss = QSS_START;
      continue;
    }
    if ((line[0] === '.' || line[0] === '#') && sql === '') {
      if (line[0] === '.') errors += runMeta(session, line);
      qss = QSS_START;
      continue;
    }
    if (sql === '') {
      sql = line.replace(/^[ \t\n\v\f\r]+/, '');
      startLine = lineNo;
    } else {
      sql += `\n${line}`;
    }
    if (sql !== '' && semiTerminated(qss) && sqlComplete(sql)) {
      errors += runChunk(session, sql, startLine);
      sql = '';
      qss = QSS_START;
    } else if (sql !== '' && plainWhite(qss)) {
      sql = '';
      qss = QSS_START;
    }
  }
  if (sql !== '') errors += runChunk(session, sql, startLine);
  return errors > 0 ? 1 : 0;
}
