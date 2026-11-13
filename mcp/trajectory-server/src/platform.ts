import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

export interface RuntimePaths {
  readonly stateDir: string | null;
  readonly trajectoryDb: string;
  readonly logDir: string;
}

export interface RuntimePluginMetadata {
  readonly root: string | null;
  readonly name: string;
  readonly version: string | null;
}

export interface ClaudeRuntimeContext {
  readonly host: 'claude';
  /**
   * Claude's invocation cwd. It is deliberately not described as a trusted
   * project root: the project is the directory holding the resolved DB, and
   * cwd only seeds the walk of findExistingClaudeDbUp when
   * `CLAUDE_PROJECT_DIR` is unset.
   */
  readonly cwd: string;
  readonly home: string;
  readonly plugin: RuntimePluginMetadata;
  readonly paths: RuntimePaths;
}

/**
 * Read Claude Code's plugin manifest using the same tolerant fallback rules as
 * the legacy resolver.
 */
export function readClaudePluginMetadata(
  env: NodeJS.ProcessEnv = process.env,
): RuntimePluginMetadata {
  const root = env['CLAUDE_PLUGIN_ROOT'] ?? null;
  if (!root) {
    return freezePlugin({ root: null, name: 'tmb', version: null });
  }

  try {
    const manifest = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown };
    const name =
      typeof manifest.name === 'string' && manifest.name.length > 0
        ? manifest.name
        : 'tmb';
    const version =
      typeof manifest.version === 'string' && manifest.version.length > 0
        ? manifest.version
        : null;
    return freezePlugin({ root, name, version });
  } catch {
    return freezePlugin({ root, name: 'tmb', version: null });
  }
}

export function resolveClaudePluginName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return readClaudePluginMetadata(env).name;
}

export function resolveClaudePluginVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readClaudePluginMetadata(env).version;
}

/**
 * Claude's session directory: `CLAUDE_PROJECT_DIR`, when the host sets it.
 * The DB walk starts here; the project root is the directory holding the DB
 * it resolves. Null otherwise (a bare `node dist/index.js`).
 */
export function resolveClaudeProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = env['CLAUDE_PROJECT_DIR'];
  return root && root.trim().length > 0 ? root : null;
}

/** Where the DB walk starts: `CLAUDE_PROJECT_DIR`, else `cwd`. */
export function resolveClaudeSessionDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return resolveClaudeProjectRoot(env) ?? cwd;
}

/**
 * The trajectory DB path for Claude: the found DB (findExistingClaudeDbUp),
 * else a fresh-init path under `CLAUDE_PROJECT_DIR` (or the invocation cwd
 * when it is unset). `TRAJECTORY_DB_PATH` is returned verbatim either way.
 */
export function resolveClaudeDbPath(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const pluginName = resolveClaudePluginName(env);
  return resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home });
}

function resolveClaudeDbPathForPlugin(
  pluginName: string,
  opts: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly home: string;
  },
): string {
  const { env, cwd, home } = opts;
  const override = env['TRAJECTORY_DB_PATH'];
  if (override && override.trim().length > 0) return override;

  const projectRoot = resolveClaudeProjectRoot(env);
  const found = findExistingClaudeDbUp(cwd, pluginName, { home, env, projectRoot });
  if (found) return found;
  return claudeDbLocation(projectRoot ?? cwd, pluginName);
}

/** Host state directory for Claude. */
const CLAUDE_STATE_HOST_DIR = '.claude';

function claudeDbLocation(root: string, pluginName: string): string {
  return join(root, CLAUDE_STATE_HOST_DIR, pluginName, 'trajectory.db');
}

/**
 * Server logs live beside the trajectory DB, inside the project — never under
 * the user's home. An in-memory DB has no project state dir, so its logs go to
 * the OS temp dir.
 */
function claudeLogDirFor(trajectoryDb: string, pluginName: string): string {
  if (trajectoryDb === ':memory:') return join(tmpdir(), `${pluginName}-memory-logs`);
  return join(dirname(trajectoryDb), 'logs');
}

export function resolveClaudeLogDir(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const pluginName = resolveClaudePluginName(env);
  return claudeLogDirFor(resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home }), pluginName);
}

export function createClaudeRuntimeContext(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}): ClaudeRuntimeContext {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const plugin = readClaudePluginMetadata(env);
  const trajectoryDb = resolveClaudeDbPathForPlugin(plugin.name, { env, cwd, home });
  const stateDir = trajectoryDb === ':memory:' ? null : dirname(trajectoryDb);
  const paths = freezePaths({
    stateDir,
    trajectoryDb,
    logDir: claudeLogDirFor(trajectoryDb, plugin.name),
  });

  return Object.freeze({
    host: 'claude',
    cwd,
    home,
    plugin,
    paths,
  });
}

export type ClaudeDbProbe = 'current' | 'stale' | 'error';

/**
 * Classify a candidate DB: `current` when `tasks.prompt_bearing` exists,
 * `stale` for a legacy schema (no such column, or no tasks table), `error`
 * when the read itself fails (busy, corrupt, unreadable).
 */
export function probeClaudeDb(path: string): ClaudeDbProbe {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('tasks')")
      .all() as Array<{ name: string }>;
    return cols.some((c) => c.name === 'prompt_bearing') ? 'current' : 'stale';
  } catch {
    return 'error';
  } finally {
    try {
      db?.close();
    } catch {
      // closing a failed handle is best-effort
    }
  }
}

/** A file in a DB's state dir that makes that DB its own project (nearest one wins the walk). */
export const CLAUDE_STANDALONE_MARKER = 'standalone';

/** `<root>/.claude/<plugin>` — the state dir holding a project's trajectory DB. */
export function claudeStateDir(root: string, pluginName: string): string {
  return join(root, CLAUDE_STATE_HOST_DIR, pluginName);
}

export function isStandaloneClaudeDb(dbPath: string): boolean {
  return existsSync(join(dirname(dbPath), CLAUDE_STANDALONE_MARKER));
}

export interface ClaudeDbWalk {
  /** The DB the rule picks, or null when the walk found none. */
  readonly resolved: string | null;
  /** Every non-stale DB the walk passed, innermost first; `resolved` is the last. */
  readonly candidates: string[];
}

/**
 * Walk up from `start` to `/`, never entering `home` unless started there, no
 * `.git` stop. Every ancestor `.claude/<plugin>/trajectory.db` that is not a
 * stale schema is a candidate; a candidate whose state dir holds a
 * `standalone` marker ends the walk and wins, else the outermost wins.
 */
export function walkClaudeDbs(
  start: string,
  pluginName: string,
  opts?: { home?: string; probe?: (path: string) => ClaudeDbProbe },
): ClaudeDbWalk {
  const home = opts?.home ?? homedir();
  const probe = opts?.probe ?? probeClaudeDb;
  const found: string[] = [];
  for (let dir = start; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start !== home) break;
    const candidate = claudeDbLocation(dir, pluginName);
    if (!existsSync(candidate) || probe(candidate) === 'stale') continue;
    found.push(candidate);
    if (isStandaloneClaudeDb(candidate)) break;
  }
  return { resolved: found.length === 0 ? null : found[found.length - 1]!, candidates: found };
}

/** `<root>` for a DB at `<root>/.claude/<plugin>/<file>`; null for `:memory:` or any other shape. */
export function claudeProjectRootOfDb(dbPath: string): string | null {
  if (!dbPath || dbPath === ':memory:') return null;
  const hostDir = dirname(dirname(dbPath));
  return basename(hostDir) === CLAUDE_STATE_HOST_DIR ? dirname(hostDir) : null;
}

/** The physical path of an existing `path`, else `path` as given. */
export function canonicalExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `child` is `parent` or lies below it (both compared as given). */
export function isPathWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface OtherClaudeDb {
  readonly path: string;
  readonly issues: number | null;
  readonly tasks: number | null;
  /** 0 issues and 0 tasks — the only kind /onboard offers to remove. */
  readonly empty: boolean;
}

/** How deep below the project root a stray DB is looked for. */
export const STRAY_DB_MAX_DEPTH = 4;

function countRows(conn: DatabaseSync, table: 'issues' | 'tasks'): number | null {
  try {
    const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id > 0`).get() as { n: number | bigint } | undefined;
    return row === undefined ? null : Number(row.n);
  } catch {
    return null;
  }
}

/**
 * Issue and task counts of a trajectory DB, read-only, leaving out the
 * schema-seeded system issue (id -1); null for a count the read could not take.
 */
export function claudeDbCounts(path: string): { issues: number | null; tasks: number | null } {
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(path, { readOnly: true });
    return { issues: countRows(conn, 'issues'), tasks: countRows(conn, 'tasks') };
  } catch {
    return { issues: null, tasks: null };
  } finally {
    try {
      conn?.close();
    } catch {
      // closing a failed handle is best-effort
    }
  }
}

function claudeDbsBelow(
  root: string,
  pluginName: string,
  maxDepth: number,
  probe: (path: string) => ClaudeDbProbe,
): string[] {
  const found: string[] = [];
  let level = [root];
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const child = join(dir, entry.name);
        const candidate = claudeDbLocation(child, pluginName);
        if (existsSync(candidate) && isStandaloneClaudeDb(candidate)) continue;
        next.push(child);
        if (existsSync(candidate) && probe(candidate) !== 'stale') found.push(candidate);
      }
    }
    level = next;
  }
  return found;
}

/**
 * Every trajectory DB other than `dbPath` that a session in `sessionDir` sits
 * among: the non-stale DBs the walk-up from `sessionDir` passes (only when
 * `sessionDir` is inside the project, the walk that found `dbPath`), and the
 * DBs below the project root up to STRAY_DB_MAX_DEPTH levels, not counting a
 * `standalone` project or anything under it. Null when `dbPath` is not a project DB
 * (`<root>/.claude/<plugin>/<file>`).
 */
export function otherClaudeDbs(
  dbPath: string,
  opts: {
    sessionDir: string;
    home?: string;
    probe?: (path: string) => ClaudeDbProbe;
  },
): OtherClaudeDb[] | null {
  const root = claudeProjectRootOfDb(dbPath);
  if (root === null) return null;
  const pluginName = basename(dirname(dbPath));
  const probe = opts.probe ?? probeClaudeDb;
  const seen = new Set<string>([canonicalExisting(dbPath)]);
  const paths: string[] = [];
  const add = (path: string): void => {
    const key = canonicalExisting(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  if (isPathWithin(canonicalExisting(root), canonicalExisting(opts.sessionDir))) {
    walkClaudeDbs(opts.sessionDir, pluginName, { home: opts.home, probe }).candidates.forEach(add);
  }
  claudeDbsBelow(root, pluginName, STRAY_DB_MAX_DEPTH, probe).forEach(add);
  return paths.map((path) => {
    const { issues, tasks } = claudeDbCounts(path);
    return { path, issues, tasks, empty: issues === 0 && tasks === 0 };
  });
}

/**
 * The one trajectory-DB location rule, shared with the hooks' `dbPath`
 * (src/hooks/lib/db.ts) and documented in
 * docs/architecture/MEMORY.md#where-the-trajectory-db-lives. Returns the existing DB, or null
 * when unresolved:
 *
 * 1. `TRAJECTORY_DB_PATH`, if set (must exist).
 * 2. Walk up from the project root (`CLAUDE_PROJECT_DIR` for Claude), else
 *    from `startDir` (walkClaudeDbs): the nearest `standalone` DB, else the
 *    outermost DB.
 * 3. Otherwise unresolved.
 *
 * Unresolved means the project is not onboarded and every hook gate allows.
 * A DB that resolves but cannot be read is an error: deny-capable gates deny.
 */
export function findExistingClaudeDbUp(
  startDir: string,
  pluginName: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    projectRoot?: string | null;
    probe?: (path: string) => ClaudeDbProbe;
  },
): string | null {
  const env = opts?.env ?? process.env;

  const override = env['TRAJECTORY_DB_PATH'];
  if (override && override.trim().length > 0) {
    return existsSync(override) ? override : null;
  }

  const projectRoot =
    opts?.projectRoot !== undefined ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}

function freezePlugin<T extends RuntimePluginMetadata>(plugin: T): Readonly<T> {
  return Object.freeze(plugin);
}

function freezePaths<T extends RuntimePaths>(paths: T): Readonly<T> {
  return Object.freeze(paths);
}
