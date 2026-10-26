/**
 * TypeScript port of scripts/hooks/lib/query-task.sh (GH 1692): where the
 * trajectory DB lives, whether it reads, and the fail-closed read helpers the
 * gates use. Every function takes the `env` it resolves from (process.env in a
 * gate) and returns what the .sh's `$(...)` capture holds: its stdout without
 * trailing newlines.
 */
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { claudeProjectDir, homeDir, pluginName, posixBasename, posixDirname, shellPwd, TMB_DB_FILENAME, TMB_STATE_HOST_DIR } from './project-env.js';
import { jqAlternatives, jqCompact, jqContentStrings } from './jq.js';
import { agentRole } from './role.js';
import { haveSqlite, sqliteBackend, sqliteRun } from './sqlite-shell.js';

export { haveSqlite } from './sqlite-shell.js';

export const GATE_READ_ERROR = '__ERR__';
const DEFAULT_READ_TIMEOUT_MS = 1500;
const SQLITE_RO_TIMEOUT_MS = 500;
const CANTOPEN = 14;
const BUDGET_KILLED = 124;

export type DbState = 'unresolved' | 'ok' | 'error';

export function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function digitsOr(value: string | undefined, fallback: number): number {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.TMB_DB_WRITE_TIMEOUT_MS;
  return digitsOr(raw === '' ? undefined : raw, DEFAULT_READ_TIMEOUT_MS);
}

/** tmb_db_location <root>: where <root>'s trajectory DB lives, existing or not. */
export function dbLocation(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${root}/${TMB_STATE_HOST_DIR}/${pluginName(env)}/${TMB_DB_FILENAME}`;
}

/** _tmb_db_wal_cold: a WAL DB (header bytes 18-19 = 2) with no -shm beside it. */
export function walCold(db: string): boolean {
  if (existsSync(`${db}-shm`)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(db, 'r');
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 18);
    return [...buf.subarray(0, n)].join('') === '22';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sqliteOnce(ro: boolean, ms: number, target: string, sql: string, env: NodeJS.ProcessEnv): { code: number; out: string } {
  const r = sqliteRun({ target, readonly: ro, timeoutMs: ms, sql }, env);
  return { code: r.code, out: stripTrailingNewlines(r.stdout) };
}

/**
 * tmb_gate_read <db> <sql>: the query output, or __ERR__ when the read fails,
 * so a deny-capable gate tells "no rows" from "DB unavailable".
 */
export function gateRead(db: string, sql: string, env: NodeJS.ProcessEnv = process.env): string {
  const ms = readTimeoutMs(env);
  if (db === '' || !isFile(db)) return GATE_READ_ERROR;
  const ro = !walCold(db);
  let r = sqliteOnce(ro, ms, db, sql, env);
  if (r.code === CANTOPEN && ro) r = sqliteOnce(false, ms, db, sql, env);
  return r.code === 0 ? r.out : GATE_READ_ERROR;
}

/**
 * tmb_db_read_budget <db> <budget_ms> <<< script: the script's output and
 * sqlite3's exit code, 124 once the budget is spent.
 */
export function dbReadBudget(
  db: string,
  budgetMs: string,
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: number; out: string } {
  if (db === '' || !isFile(db)) return { code: 1, out: '' };
  let ms = digitsOr(budgetMs, DEFAULT_READ_TIMEOUT_MS);
  if (ms <= 0) ms = 1;
  const input = `${stripTrailingNewlines(script)}\n`;
  const run = (ro: boolean): { code: number; out: string } => {
    const r = sqliteRun({ target: db, readonly: ro, timeoutMs: ms, script: input, killAfterMs: ms }, env);
    return { code: r.code === 127 ? 1 : r.code, out: stripTrailingNewlines(r.stdout) };
  };
  let r: { code: number; out: string };
  if (walCold(db)) {
    r = run(false);
  } else {
    r = run(true);
    if (r.code !== 0 && r.code !== BUDGET_KILLED && walCold(db)) r = run(false);
  }
  return r;
}

/** _tmb_db_immutable_uri <db>: the absolute file: URI that opens <db> immutable. */
export function immutableUri(db: string, env: NodeJS.ProcessEnv = process.env): string {
  let p = db.startsWith('/') ? db : `${shellPwd(env).replace(/\/$/, '')}/${db}`;
  p = p.replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23');
  return `file:${p}?immutable=1`;
}

/**
 * _tmb_db_read_ro <db> <sql>: a read that never writes the DB, through an
 * immutable URI when the DB is a cold WAL; __ERR__ when it fails. node:sqlite
 * opens a cold WAL read-only where the CLI cannot, creating -shm and -wal
 * beside it, so that path goes to the immutable URI first.
 */
export function dbReadRo(db: string, sql: string, env: NodeJS.ProcessEnv = process.env): string {
  const ms = readTimeoutMs(env);
  if (db === '' || !isFile(db)) return GATE_READ_ERROR;
  let r: { code: number; out: string };
  if (sqliteBackend(env) === 'node' && walCold(db)) {
    r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  } else {
    r = sqliteOnce(true, ms, db, sql, env);
    if (r.code !== 0 && walCold(db)) r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  }
  return r.code === 0 ? r.out : GATE_READ_ERROR;
}

/** _tmb_db_probe <db>: 0 current schema, 1 stale or missing, 2 the read failed. */
export function dbProbe(db: string, env: NodeJS.ProcessEnv = process.env): 0 | 1 | 2 {
  if (db === '' || !isFile(db)) return 1;
  if (!haveSqlite(env)) return 0;
  const cols = dbReadRo(db, "SELECT name FROM pragma_table_info('tasks');", env);
  if (cols === GATE_READ_ERROR) return 2;
  return cols.includes('prompt_bearing') ? 0 : 1;
}

/** tmb_db_schema_current <db>: 0 when <db> carries the current schema. */
export function dbSchemaCurrent(db: string, env: NodeJS.ProcessEnv = process.env): 0 | 1 | 2 {
  return dbProbe(db, env);
}

/** tmb_test_flag: the active test flag, or null. */
export function testFlag(env: NodeJS.ProcessEnv = process.env): 'TMB_FORBID_LIVE_SYNC' | 'TMB_TEST_RUN_ID' | null {
  if (env.TMB_FORBID_LIVE_SYNC === '1') return 'TMB_FORBID_LIVE_SYNC';
  if ((env.TMB_TEST_RUN_ID ?? '') !== '') return 'TMB_TEST_RUN_ID';
  return null;
}

export interface DbResolution {
  path: string | null;
  /** The stderr line the .sh prints, or "". */
  warning: string;
}

/**
 * _tmb_db_resolve: TRAJECTORY_DB_PATH, else the walk up from
 * CLAUDE_PROJECT_DIR (else the cwd) — never entering $HOME unless started
 * there — where a `standalone` marker ends the walk and otherwise the outermost
 * non-stale DB wins. Under a test flag only CLAUDE_PROJECT_DIR's own DB.
 */
export function dbResolve(env: NodeJS.ProcessEnv = process.env): DbResolution {
  const explicit = env.TRAJECTORY_DB_PATH ?? '';
  if (explicit !== '') return { path: isFile(explicit) ? explicit : null, warning: '' };
  const flag = testFlag(env);
  if (flag) {
    const project = claudeProjectDir(env);
    if (project !== '') {
      const candidate = dbLocation(project, env);
      return { path: isFile(candidate) ? candidate : null, warning: '' };
    }
    return {
      path: null,
      warning: `tmb: trajectory DB unresolved: ${flag} is set and neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is (walk-up discovery disabled)`,
    };
  }
  const start = claudeProjectDir(env) || shellPwd(env);
  const home = homeDir(env);
  let outermost = '';
  let dir = start;
  while (dir !== '' && dir !== '/') {
    if (dir === home && start !== home) break;
    const candidate = dbLocation(dir, env);
    if (isFile(candidate) && dbProbe(candidate, env) !== 1) {
      outermost = candidate;
      if (existsSync(`${posixDirname(candidate)}/standalone`)) break;
    }
    const parent = posixDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: outermost === '' ? null : outermost, warning: '' };
}

const dbPathCache = new WeakMap<object, string>();

/**
 * tmb_db_path: the resolved trajectory DB, or null; memoized per env object
 * (per process for process.env). `onWarning` receives the stderr line.
 */
export function dbPath(env: NodeJS.ProcessEnv = process.env, onWarning?: (line: string) => void): string | null {
  const cached = dbPathCache.get(env);
  if (cached !== undefined) return cached;
  const r = dbResolve(env);
  if (r.warning !== '' && onWarning) onWarning(r.warning);
  if (r.path !== null) dbPathCache.set(env, r.path);
  return r.path;
}

/** Forgets the memoized DB path of <env>. */
export function resetDbPathCache(env: NodeJS.ProcessEnv = process.env): void {
  dbPathCache.delete(env);
}

/** tmb_realdir <dir>: the physical path of an existing dir, else <dir> as given. */
export function realdir(dir: string): string {
  if (dir === '') return '';
  try {
    if (statSync(dir).isDirectory()) {
      accessSync(dir, constants.X_OK);
      return realpathSync.native(dir);
    }
  } catch {
    /* as given */
  }
  return stripTrailingNewlines(dir);
}

/** tmb_db_project_root <db>: <project> for <project>/.claude/<plugin>/<file>, else "". */
export function dbProjectRoot(db: string): string {
  if (db === '') return '';
  const host = posixDirname(posixDirname(db));
  return posixBasename(host) === TMB_STATE_HOST_DIR ? posixDirname(host) : '';
}

/** tmb_repo_path_abs <db> <repos.path>: a repos.path as an absolute dir. */
export function repoPathAbs(db: string, path: string): string {
  if (path.startsWith('/')) return path;
  const root = dbProjectRoot(db);
  return `${root || posixDirname(db)}/${path}`;
}

/** tmb_project_root: the project holding the resolved DB, else CLAUDE_PROJECT_DIR, else "". */
export function projectRoot(env: NodeJS.ProcessEnv = process.env): string {
  const db = dbPath(env);
  const root = db !== null ? dbProjectRoot(db) : '';
  return root || claudeProjectDir(env);
}

/** tmb_state_dir: the dir holding the resolved DB, or null. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const db = dbPath(env);
  return db === null ? null : posixDirname(db);
}

/** tmb_db_state: unresolved (gates allow), ok, or error (deny-capable gates deny). */
export function dbState(env: NodeJS.ProcessEnv = process.env): DbState {
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return 'unresolved';
  return gateRead(db, 'SELECT count(*) FROM sqlite_master;', env) === GATE_READ_ERROR ? 'error' : 'ok';
}

/** tmb_db_unavailable_reason <hook>: the deny reason of a DB read error. */
export function dbUnavailableReason(hook = '', env: NodeJS.ProcessEnv = process.env): string {
  const db = dbPath(env) ?? '<unresolved>';
  return `BLOCKED: trajectory DB unavailable — ${hook || 'hook'} could not read ${db} (read error: busy, corrupt, or unreadable), so it refuses to fail open. Check the trajectory DB and retry.`;
}

/** tmb_deny_db_unavailable <hook>: the PreToolUse deny JSON for a DB read error. */
export function denyDbUnavailable(hook = '', env: NodeJS.ProcessEnv = process.env): string {
  return jqCompact({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: stripTrailingNewlines(dbUnavailableReason(hook || 'hook', env)),
    },
  });
}

/** tmb_sqlite_ro <db> <sql>: tmb_gate_read with a 500 ms busy wait; "" on error. */
export function sqliteRo(db: string, sql: string, env: NodeJS.ProcessEnv = process.env): string {
  const out = gateRead(db, sql, { ...env, TMB_DB_WRITE_TIMEOUT_MS: String(SQLITE_RO_TIMEOUT_MS) });
  return out === GATE_READ_ERROR ? '' : out;
}

/** tmb_swe_context <agent_type>: "yes" for swe, else "no". */
export function sweContext(agentType = ''): 'yes' | 'no' {
  return agentType === 'swe' ? 'yes' : 'no';
}

/** tmb_sql_int <value>: <value> when it is a decimal integer, else "". */
export function sqlInt(value = ''): string {
  return /^[0-9]+$/.test(value) ? value : '';
}

/**
 * tmb_sql_quote <value>: <value> with every single quote doubled, minus the
 * trailing newlines the .sh's `$(...)` capture drops.
 */
export function sqlQuote(value = ''): string {
  return stripTrailingNewlines(value.replace(/'/g, "''"));
}

/** tmb_sql_like_escape <value>: `\`, `%` and `_` escaped with `\` for LIKE … ESCAPE '\', then quoted as tmb_sql_quote does. */
export function sqlLikeEscape(value = ''): string {
  return stripTrailingNewlines(value.replace(/[\\%_]/g, '\\$&').replace(/'/g, "''"));
}

const TASK_STATUS_LIST = /^[a-z_', ]*$/;

/**
 * tmb_task_by_slug <db> <slug> [id|branch_id] [<status_list>]: <col> of the
 * newest task whose branch_id ends in /<slug>, "" when none. When several
 * match, `onWarning` gets the .sh's stderr line naming them.
 */
export function taskBySlug(
  db: string,
  slug: string,
  col: string = 'id',
  statuses = '',
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (line: string) => void,
): string {
  if (db === '' || slug === '') return '';
  if (col !== 'id' && col !== 'branch_id') return '';
  if (!TASK_STATUS_LIST.test(statuses)) return '';
  let where = `branch_id LIKE '%/${sqlLikeEscape(slug)}' ESCAPE '\\'`;
  if (statuses !== '') where += ` AND status IN (${statuses})`;
  const rows = sqliteRo(db, `SELECT id || '|' || branch_id FROM tasks WHERE ${where} ORDER BY id DESC;`, env);
  if (rows === '') return '';
  const lines = rows.split('\n');
  const count = lines.filter((l) => l !== '').length;
  if (count > 1 && onWarning) {
    const branches = lines.map((l) => l.split('|')[1] ?? l).join(',');
    onWarning(`tmb: worktree slug "${slug}" matches ${count} tasks (${branches}); using the newest`);
  }
  const first = lines[0];
  const bar = first.indexOf('|');
  if (col === 'id') return bar < 0 ? first : first.slice(0, bar);
  return bar < 0 ? first : first.slice(bar + 1);
}

/** tmb_branch_slug <branch_id>: the branch minus its first `<type>/`. */
export function branchSlug(branch = ''): string {
  const slash = branch.indexOf('/');
  return slash < 0 ? branch : branch.slice(slash + 1);
}

/**
 * tmb_caller_run <input_json> <db>: `<task_id>|<root_dir>` of the newest swe
 * agent_runs row bound to the payload's agent_id; "" for another role or no
 * row; __ERR__ when the read fails.
 */
export function callerRun(input: string, db: string, env: NodeJS.ProcessEnv = process.env): string {
  if (agentRole(input) !== 'swe') return '';
  const agentId = jqAlternatives(input, [['agent_id']]);
  if (agentId === '') return '';
  return gateRead(
    db,
    `SELECT COALESCE(task_id, '') || '|' || COALESCE(root_dir, '') FROM agent_runs
                        WHERE agent_type = 'swe' AND spawn_id = '${sqlQuote(agentId)}'
                        ORDER BY id DESC LIMIT 1;`,
    env,
  );
}

/** tmb_task_id_from_transcript <path>: the first task_id=<N> in its message content, or "". */
export function taskIdFromTranscript(transcript = ''): string {
  if (transcript === '' || !isFile(transcript)) return '';
  let text: string;
  try {
    text = readFileSync(transcript, 'utf8');
  } catch {
    return '';
  }
  for (const line of jqContentStrings(text)) {
    const m = /task_id=([0-9]+)/.exec(line);
    if (m) return sqlInt(m[1]);
  }
  return '';
}
