/**
 * The deterministic project walker behind scan_run (GH 1692). Walks the session dir for git repos, enumerates each repo's
 * tracked files, computes md5 + size + last_commit_sha per file, then
 * reconciles locally-present skills, plugins and MCP servers into the
 * cheatcodes table of the DB it is handed.
 *
 * Determinism rules:
 *   - Drift detection is md5-only. last_commit_sha is metadata, not an
 *     invalidation signal.
 *   - Repo discovery walks the filesystem (max depth 4), not git, since the
 *     session dir itself is not required to be a git repo.
 *   - Per-repo file enumeration is `git ls-files` (.gitignore-aware).
 *   - One `git log --format=%H --name-only` pass per repo builds the
 *     path→sha map; no per-file git subprocess.
 *
 * plugin_inventory.status: cli (`claude plugin list --json`), fixture
 * (TMB_SCAN_PLUGIN_JSON), unavailable (note says why) or skipped (no cheatcodes
 * table). mcp_inventory.status: home (~/.claude.json mcpServers), fixture
 * (TMB_SCAN_MCP_JSON), unavailable or skipped.
 *
 * Test flags (TMB_FORBID_LIVE_SYNC=1 or a set TMB_TEST_RUN_ID): `claude` is
 * never spawned and ~/.claude.json is never read; the fixtures stand in.
 * TMB_SCAN_DISCOVERY_TIMEOUT bounds `claude plugin list` (seconds, default 4).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { commandOnPath } from '../hooks/lib/host.js';
import { insertAudit } from './audit.js';
import { selectProjectInstalls } from './cheatcode-runtime.js';

export interface ScanFile {
  repo: string;
  path: string;
  content_md5: string;
  size_bytes?: number;
  last_commit_sha?: string;
}

export interface ScanRepo {
  name: string;
  path: string;
  file_count: number;
}

export interface Inventory {
  status: string;
  note: string;
}

export interface ScanOutput {
  session_dir: string;
  scanned_at: string;
  repos: ScanRepo[];
  files: ScanFile[];
  plugin_inventory?: Inventory;
  mcp_inventory?: Inventory;
}

export interface WalkOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface DiscoveredCheatcode {
  name: string;
  kind: 'skill' | 'mcp' | 'plugin';
  origin: 'marketplace' | 'external';
  source_url: string;
  status: 'active' | 'installed';
  description?: string;
  version?: string | null;
  file_path?: string | null;
  /** Plugin whose trust_tier the row inherits (a bundled MCP server's parent). */
  trust_parent?: string | null;
  from_node?: string;
}

/**
 * The one writer for a discovered resource, keyed on (name, kind). A new row is
 * inserted with a scan_discovered audit row; an existing row only gets a blank
 * description filled, its version set to a non-empty live version that differs
 * from the stored one, and a legacy 'mcp:<server>' source_url rewritten to the
 * bundled 'mcp:<plugin>/<server>' form, without an audit row. An empty or absent
 * live version never changes the stored one.
 */
export function upsertDiscoveredCheatcode(
  db: TrajectoryDB,
  r: DiscoveredCheatcode,
): { id: number; inserted: boolean } {
  const description = r.description ?? '';
  const version = r.version || null;
  return db.transaction(() => {
    const now = nowISO();
    const res = db.run(
      `INSERT INTO cheatcodes
         (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               (SELECT trust_tier FROM cheatcodes WHERE kind = 'plugin' AND name = ?),
               'project-local', ?, ?, ?, ?)
       ON CONFLICT (name, kind) DO NOTHING`,
      [
        r.name, r.kind, r.origin, description, r.source_url, r.file_path ?? null, version,
        r.trust_parent ?? null, r.status, now, now, now,
      ],
    );
    if (res.changes > 0) {
      insertAudit(db, {
        issue_id: -1,
        from_node: r.from_node ?? 'system',
        event_type: 'scan_discovered',
        summary: `${r.name} (${r.kind}): discovered`,
        content_json: JSON.stringify({ name: r.name, kind: r.kind, origin: r.origin, source: r.source_url }),
      });
      return { id: Number(res.lastInsertRowid), inserted: true };
    }
    db.run(
      `UPDATE cheatcodes
          SET description = CASE WHEN description = '' THEN ? ELSE description END,
              version = COALESCE(?, version),
              source_url = CASE WHEN kind = 'mcp' AND source_url = 'mcp:' || name AND ? LIKE 'mcp:%/%'
                                THEN ? ELSE source_url END,
              updated_at = ?
        WHERE name = ? AND kind = ?
          AND ((description = '' AND ? <> '')
               OR (? IS NOT NULL AND version IS NOT ?)
               OR (kind = 'mcp' AND source_url = 'mcp:' || name AND ? LIKE 'mcp:%/%'))`,
      [
        description, version, r.source_url, r.source_url, now, r.name, r.kind,
        description, version, version, r.source_url,
      ],
    );
    const row = db.get<{ id: number }>('SELECT id FROM cheatcodes WHERE name = ? AND kind = ?', [r.name, r.kind]);
    return { id: row!.id, inserted: false };
  });
}

const MAX_DEPTH = 4;
const PRUNED_TAIL = /\/(node_modules|dist|build|\.next|target|\.venv|venv)$/;
const FILE_WORKERS = 16;
const SHA_LINE = /^[0-9a-f]{40}$/;
const VALID_NAME = /^[A-Za-z0-9._-]+$/;
const DEFAULT_DISCOVERY_TIMEOUT_S = 4;
const NO_CHEATCODES_NOTE = 'no trajectory DB with a cheatcodes table';

class Deadline {
  private readonly at: number;
  constructor(timeoutMs: number) {
    this.at = Date.now() + timeoutMs;
  }
  left(): number {
    return this.at - Date.now();
  }
  check(): void {
    if (this.left() <= 0) throw new Error('scan timed out after 10 minutes');
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
}

/** Runs a command with stdin closed and stderr dropped; a run past `limitMs` is killed and rejects with `onTimeout`. */
function run(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; limitMs: number; onLine?: (line: string) => void; onTimeout: () => Error | null },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let pending = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!opts.onLine) {
        stdout += chunk;
        return;
      }
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        opts.onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      const e = opts.onTimeout();
      if (e) {
        settled = true;
        reject(e);
      }
    }, Math.max(0, opts.limitMs));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout: '' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.onLine && pending !== '') opts.onLine(pending);
      resolvePromise({ code, stdout });
    });
  });
}

function git(args: string[], env: NodeJS.ProcessEnv, deadline: Deadline, onLine?: (line: string) => void): Promise<RunResult> {
  deadline.check();
  return run('git', args, {
    env,
    limitMs: deadline.left(),
    onLine,
    onTimeout: () => new Error('scan timed out after 10 minutes'),
  });
}

/** `$(...)`: the output without its trailing newlines. */
function captured(text: string): string {
  return text.replace(/\n+$/, '');
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasTable(db: TrajectoryDB, name: string): boolean {
  return db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined;
}

function testMode(env: NodeJS.ProcessEnv): boolean {
  return env['TMB_FORBID_LIVE_SYNC'] === '1' || (env['TMB_TEST_RUN_ID'] ?? '') !== '';
}

/** Session-relative paths (`.`, `./a`, `./a/b`) of every entry named .git at depth 1..4, the build and worktree dirs pruned. */
function findGitParents(sessionDir: string): string[] {
  const parents: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (PRUNED_TAIL.test(childRel) || childRel.includes('/.claude/worktrees')) continue;
      if (e.name === '.git') parents.push(rel);
      if (e.isDirectory()) walk(join(abs, e.name), childRel, depth + 1);
    }
  };
  walk(sessionDir, '.', 0);
  return parents;
}

/** A linked worktree's git dir differs from its common dir; a main checkout's are the same. */
async function isLinkedWorktree(repo: string, env: NodeJS.ProcessEnv, deadline: Deadline): Promise<boolean> {
  const out = await git(['-C', repo, 'rev-parse', '--git-dir', '--git-common-dir'], env, deadline);
  if (out.code !== 0) return false;
  const [gitDir, commonDir] = captured(out.stdout).split('\n');
  if (!gitDir || !commonDir) return false;
  try {
    return realpathSync(resolve(repo, gitDir)) !== realpathSync(resolve(repo, commonDir));
  } catch {
    return false;
  }
}

/**
 * Why a discovered repo below the session dir is left out of the scan, or null
 * when it is scanned: dot_dir (a dot-prefixed path segment below the session
 * dir), git_ignored (the nearest enclosing repo up to the session dir ignores
 * it), linked_worktree (a `git worktree add` checkout of another repo) or
 * no_commits (no HEAD commit).
 */
async function skipReason(repo: string, sessionDir: string, env: NodeJS.ProcessEnv, deadline: Deadline): Promise<string | null> {
  const rel = repo.startsWith(`${sessionDir}/`) ? repo.slice(sessionDir.length + 1) : repo;
  if (`/${rel}`.includes('/.')) return 'dot_dir';
  let enclosing = dirname(repo);
  for (;;) {
    if (existsSync(join(enclosing, '.git'))) {
      if ((await git(['-C', enclosing, 'check-ignore', '-q', repo], env, deadline)).code === 0) return 'git_ignored';
      break;
    }
    if (enclosing === sessionDir || dirname(enclosing) === enclosing) break;
    enclosing = dirname(enclosing);
  }
  if (await isLinkedWorktree(repo, env, deadline)) return 'linked_worktree';
  const head = await git(['-C', repo, 'rev-parse', '--verify', '-q', 'HEAD'], env, deadline);
  return head.code === 0 ? null : 'no_commits';
}

/** One scan_skipped audit row per skipped path and reason; a re-scan that skips it again writes none. */
function auditSkip(db: TrajectoryDB, path: string, reason: string): void {
  try {
    if (!hasTable(db, 'audit')) return;
    const seen = db.get<{ one: number }>(
      `SELECT 1 AS one FROM audit
        WHERE event_type = 'scan_skipped' AND json_valid(content_json)
          AND json_extract(content_json, '$.path') IS ? AND json_extract(content_json, '$.reason') IS ?
        LIMIT 1`,
      [path, reason],
    );
    if (seen) return;
    insertAudit(db, {
      issue_id: -1,
      from_node: 'hook:scan',
      event_type: 'scan_skipped',
      summary: `${path}: skipped (${reason})`,
      content_json: JSON.stringify({ path, reason }),
    });
  } catch {
    /* best-effort: the skip still holds without its audit row */
  }
}

async function discoverRepos(db: TrajectoryDB, sessionDir: string, env: NodeJS.ProcessEnv, deadline: Deadline): Promise<string[]> {
  const found = new Set(findGitParents(sessionDir).map((rel) => (rel === '.' ? sessionDir : `${sessionDir}/${rel.slice(2)}`)));
  const repos: string[] = [];
  for (const repo of [...found].sort()) {
    if (repo !== sessionDir) {
      const reason = await skipReason(repo, sessionDir, env, deadline);
      if (reason) {
        auditSkip(db, repo, reason);
        continue;
      }
    }
    repos.push(repo);
  }
  return repos;
}

function md5Of(path: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const hash = createHash('md5');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolvePromise(''));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await lstat(path)).size;
  } catch {
    return 0;
  }
}

async function eachLimited<T>(items: T[], deadline: Deadline, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      deadline.check();
      await fn(items[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_WORKERS, items.length) }, worker));
}

async function walkRepo(repoRoot: string, env: NodeJS.ProcessEnv, deadline: Deadline): Promise<{ repo: ScanRepo; files: ScanFile[] }> {
  const name = basename(repoRoot);
  const empty = { repo: { name, path: repoRoot, file_count: 0 }, files: [] };
  const listed = captured((await git(['-C', repoRoot, '-c', 'core.quotePath=false', 'ls-files'], env, deadline)).stdout);
  if (listed === '') return empty;
  const relPaths = listed.split('\n');

  const shaByPath = new Map<string, string>();
  let current = '';
  await git(['-C', repoRoot, '-c', 'core.quotePath=false', 'log', '--format=%H', '--name-only', '--no-renames'], env, deadline, (line) => {
    if (SHA_LINE.test(line)) current = line;
    else if (line !== '' && !shaByPath.has(line)) shaByPath.set(line, current);
  });

  const present: string[] = [];
  await eachLimited(relPaths.map((rel, i) => ({ rel, i })), deadline, async ({ rel, i }) => {
    if (await isFile(`${repoRoot}/${rel}`)) present[i] = `${repoRoot}/${rel}`;
  });
  const existing = present.filter((abs) => abs !== undefined);
  if (existing.length === 0) return empty;

  const md5ByAbs = new Map<string, string>();
  const sizeByAbs = new Map<string, number>();
  await eachLimited([...new Set(existing)], deadline, async (abs) => {
    const [md5, size] = await Promise.all([md5Of(abs), sizeOf(abs)]);
    md5ByAbs.set(abs, md5);
    sizeByAbs.set(abs, size);
  });

  const files = relPaths
    .filter((rel) => rel !== '')
    .map((rel) => {
      const abs = `${repoRoot}/${rel}`;
      return {
        repo: name,
        path: rel,
        size_bytes: sizeByAbs.get(abs) ?? 0,
        content_md5: md5ByAbs.get(abs) ?? '',
        last_commit_sha: shaByPath.get(rel) ?? '',
      };
    });
  return { repo: { name, path: repoRoot, file_count: existing.length }, files };
}

/** A JSON scalar as jq's `join` renders it; null, false and anything else as "". */
function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || v === true) return String(v);
  return '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function register(db: TrajectoryDB, r: DiscoveredCheatcode): void {
  if (!VALID_NAME.test(r.name)) return;
  try {
    upsertDiscoveredCheatcode(db, {
      ...r,
      source_url: r.source_url || 'scan_discovered',
      version: r.version || null,
      file_path: r.file_path || null,
      trust_parent: r.trust_parent || null,
      from_node: 'hook:scan',
    });
  } catch {
    /* best-effort: one failed registration never fails the scan */
  }
}

function registerSkills(db: TrajectoryDB, sessionDir: string): void {
  const skillsDir = join(sessionDir, '.claude', 'skills');
  let entries;
  try {
    if (lstatSync(skillsDir).isSymbolicLink()) return;
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = entries
    .filter((e) => {
      if (!e.isDirectory()) return false;
      try {
        lstatSync(join(skillsDir, e.name, 'SKILL.md'));
        return true;
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort((a, b) => (`${a}/SKILL.md` < `${b}/SKILL.md` ? -1 : 1));
  for (const name of names) {
    register(db, {
      kind: 'skill', name, file_path: `.claude/skills/${name}/SKILL.md`, origin: 'external',
      source_url: `skill:${name}`, status: 'active',
    });
  }
}

async function pluginList(sessionDir: string, env: NodeJS.ProcessEnv, deadline: Deadline): Promise<{ list: unknown[] | null; inventory: Inventory }> {
  let raw = '';
  let source = '';
  let note = '';
  if (testMode(env)) {
    const fixture = env['TMB_SCAN_PLUGIN_JSON'] ?? '';
    if (fixture !== '' && isReadable(fixture)) {
      try {
        raw = readFileSync(fixture, 'utf8');
      } catch {
        raw = '';
      }
      source = 'fixture';
    } else {
      note = 'TMB_FORBID_LIVE_SYNC=1 or TMB_TEST_RUN_ID set and no readable TMB_SCAN_PLUGIN_JSON: claude plugin list skipped';
    }
  } else if (commandOnPath('claude', env)) {
    const seconds = Number(env['TMB_SCAN_DISCOVERY_TIMEOUT'] ?? DEFAULT_DISCOVERY_TIMEOUT_S);
    const limitS = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DISCOVERY_TIMEOUT_S;
    deadline.check();
    raw = (await run('claude', ['plugin', 'list', '--json'], {
      env, cwd: sessionDir, limitMs: Math.min(limitS * 1000, deadline.left()), onTimeout: () => null,
    })).stdout;
    source = 'cli';
  } else {
    note = 'claude CLI not on PATH';
  }
  const parsed = source ? parseJson(raw) : undefined;
  if (source && !Array.isArray(parsed)) {
    return { list: null, inventory: { status: 'unavailable', note: `${source} plugin list is not a JSON array` } };
  }
  if (!source) return { list: null, inventory: { status: 'unavailable', note } };
  return { list: parsed as unknown[], inventory: { status: source, note: '' } };
}

function manifestDescription(installPath: string): string {
  const manifest = join(installPath, '.claude-plugin', 'plugin.json');
  try {
    if (!statSync(manifest).isFile()) return '';
    const parsed = parseJson(readFileSync(manifest, 'utf8'));
    return isObject(parsed) ? captured(scalar(parsed['description'])) : '';
  } catch {
    return '';
  }
}

/**
 * One plugin row per listed id, plus one row per MCP server it bundles. Version,
 * enabled and mcpServers come from the install in effect for `projectRoot`
 * (selectProjectInstalls); an id with no such install registers as 'installed'
 * with no version and no bundled servers.
 */
function registerPlugins(db: TrajectoryDB, list: unknown[], projectRoot: string): void {
  const firstListed = new Map<string, Record<string, unknown>>();
  for (const p of list.filter(isObject)) {
    const id = typeof p['id'] === 'string' ? p['id'] : '';
    if (!firstListed.has(id)) firstListed.set(id, p);
  }
  const entries = [...selectProjectInstalls(list, projectRoot)].map(([id, selected]) => ({
    id,
    name: id.split('@')[0] ?? '',
    p: selected ?? firstListed.get(id) ?? {},
    selected,
    version: selected ? scalar(selected['version']) : '',
  }));
  for (const { p, id, name, selected, version } of entries) {
    if (name === '') continue;
    const listed = typeof p['description'] === 'string' ? p['description'].replace(/[\t\n\r]/g, ' ') : '';
    const installPath = scalar(p['installPath']);
    const description = listed === '' && installPath !== '' ? manifestDescription(installPath) : listed;
    register(db, {
      kind: 'plugin', name, origin: 'marketplace', source_url: id,
      status: selected?.['enabled'] === true ? 'active' : 'installed', description, version,
    });
  }
  for (const { selected, name: plugin, version } of entries) {
    const servers = selected?.['mcpServers'];
    if (!isObject(servers) || !VALID_NAME.test(plugin)) continue;
    for (const server of Object.keys(servers).sort()) {
      if (server === '') continue;
      register(db, {
        kind: 'mcp', name: server, origin: 'marketplace', source_url: `mcp:${plugin}/${server}`, status: 'active',
        description: `${server} MCP server bundled by ${plugin}`, version, trust_parent: plugin,
      });
    }
  }
}

function mcpServers(env: NodeJS.ProcessEnv): { servers: Record<string, unknown> | null; inventory: Inventory } {
  let servers: unknown;
  let source = '';
  let note = '';
  if (testMode(env)) {
    const fixture = env['TMB_SCAN_MCP_JSON'] ?? '';
    if (fixture !== '' && isReadable(fixture)) {
      try {
        servers = parseJson(readFileSync(fixture, 'utf8'));
      } catch {
        servers = undefined;
      }
      source = 'fixture';
    } else {
      note = 'TMB_FORBID_LIVE_SYNC/TMB_TEST_RUN_ID set and no readable TMB_SCAN_MCP_JSON: ~/.claude.json skipped';
    }
  } else {
    const home = join(env['HOME'] ?? homedir(), '.claude.json');
    let homeIsFile = false;
    try {
      homeIsFile = statSync(home).isFile();
    } catch {
      homeIsFile = false;
    }
    if (homeIsFile) {
      try {
        const parsed = parseJson(readFileSync(home, 'utf8'));
        const value = isObject(parsed) ? parsed['mcpServers'] : undefined;
        servers = isObject(parsed) ? (value === null || value === undefined || value === false ? {} : value) : undefined;
      } catch {
        servers = undefined;
      }
      source = 'home';
    } else {
      note = 'no ~/.claude.json';
    }
  }
  if (source && !isObject(servers)) {
    return { servers: null, inventory: { status: 'unavailable', note: `${source} mcpServers is not a JSON object` } };
  }
  if (!source) return { servers: null, inventory: { status: 'unavailable', note } };
  return { servers: servers as Record<string, unknown>, inventory: { status: source, note: '' } };
}

/**
 * Reconciles locally-present resources into cheatcodes: project-local skills,
 * the plugins `claude plugin list --json` reports (and the MCP servers each
 * bundles), and the mcpServers of ~/.claude.json. Ingest is JSON-only (#150)
 * and every name passes ^[A-Za-z0-9._-]+$ before insert. Never fails the scan.
 */
async function discoverResources(
  db: TrajectoryDB,
  sessionDir: string,
  env: NodeJS.ProcessEnv,
  deadline: Deadline,
): Promise<{ plugin: Inventory; mcp: Inventory }> {
  const skipped = { status: 'skipped', note: NO_CHEATCODES_NOTE };
  const result = { plugin: skipped, mcp: skipped };
  try {
    if (!hasTable(db, 'cheatcodes')) return result;
    registerSkills(db, sessionDir);
    const plugins = await pluginList(sessionDir, env, deadline);
    result.plugin = plugins.inventory;
    if (plugins.list) registerPlugins(db, plugins.list, sessionDir);
    const mcp = mcpServers(env);
    result.mcp = mcp.inventory;
    for (const key of Object.keys(mcp.servers ?? {}).sort()) {
      if (key !== '') register(db, { kind: 'mcp', name: key, origin: 'external', source_url: `mcp:${key}`, status: 'active' });
    }
  } catch (e) {
    if ((e as Error).message === 'scan timed out after 10 minutes') throw e;
  }
  return result;
}

/** The scan: repos and files under `sessionDir`, resources reconciled into `db`. Rejects past `timeoutMs`. */
export async function walkProject(db: TrajectoryDB, sessionDir: string, opts: WalkOptions): Promise<ScanOutput> {
  const env = opts.env ?? process.env;
  const deadline = new Deadline(opts.timeoutMs);
  const root = resolve(sessionDir);
  if (!isDir(root)) throw new Error('session_dir does not exist');
  deadline.check();

  const repos: ScanRepo[] = [];
  const files: ScanFile[] = [];
  for (const repoRoot of await discoverRepos(db, root, env, deadline)) {
    if (!isDir(repoRoot)) continue;
    const walked = await walkRepo(repoRoot, env, deadline);
    repos.push(walked.repo);
    files.push(...walked.files);
  }

  const inventory = await discoverResources(db, root, env, deadline);
  return {
    session_dir: root,
    scanned_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    repos,
    files,
    plugin_inventory: inventory.plugin,
    mcp_inventory: inventory.mcp,
  };
}
