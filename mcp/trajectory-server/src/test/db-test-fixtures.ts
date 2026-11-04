/**
 * Shared fixtures for the DB-path suites (GH 1692): a sandbox dir, a child env
 * with no inherited Claude Code or TMB state, a DB created through the
 * trajectory-server's own migration path (the TS form of
 * tests/l3-integration/hooks/fixtures/migrated-db.sh), and one-statement reads
 * and writes through node:sqlite.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { PLUGIN_ROOT } from './hooks-router-table.js';

export { PLUGIN_ROOT };
export const CLI_JS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
export const HOOKS_JS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
export const FAKE_UID_PRELOAD = `--import ${join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs')}`;
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export function sandboxDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `tmb-${name}.`)));
}

const INHERITED = /^(CLAUDE_|TMB_|TRAJECTORY_DB_PATH$|NODE_OPTIONS$|SQLITE_TRACE_LOG$)/;

/**
 * process.env without any CLAUDE_*, TMB_*, TRAJECTORY_DB_PATH or NODE_OPTIONS
 * value, plus <extra>; an undefined value in <extra> drops that key.
 */
export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!INHERITED.test(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** A current-schema WAL DB at <path>, created and closed by TrajectoryDB: no -wal or -shm beside it. */
export function migratedDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  resetEmbeddingModelForTests(() => new Promise(() => {}));
  try {
    new TrajectoryDB(path).close();
  } finally {
    resetEmbeddingModelForTests();
  }
}

export function sqlExec(db: string, sql: string): void {
  const d = new DatabaseSync(db, { timeout: 5000 });
  try {
    d.exec(sql);
  } finally {
    d.close();
  }
}

export function sqlRun(db: string, sql: string, ...params: string[]): void {
  const d = new DatabaseSync(db, { timeout: 5000 });
  try {
    d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}

/** The rows of <sql>, each row's columns joined by "|" and rows by "\n", as the sqlite3 CLI prints them. */
export function sqlRows(db: string, sql: string, opts: { readOnly?: boolean } = {}): string {
  const d = new DatabaseSync(db, { timeout: 5000, readOnly: opts.readOnly ?? false });
  try {
    const rows = d.prepare(sql).all() as Record<string, unknown>[];
    return rows.map((r) => Object.values(r).map(String).join('|')).join('\n');
  } finally {
    d.close();
  }
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runNode(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Run {
  const r: SpawnSyncReturns<string> = spawnSync(process.execPath, args, {
    cwd: opts.cwd,
    env: { ...opts.env, PWD: opts.cwd },
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
