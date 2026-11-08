// Shared helpers for the rows' setup-l5.ts scripts (GH 1692). run-l5.ts runs each as
// `node --experimental-strip-types --experimental-sqlite <row>/setup-l5.ts <project> <rowDir>`;
// the script pre-seeds the scratch project's files, git history and trajectory DB.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

export const PLUGIN_ROOT = dirname(dirname(dirname(import.meta.dirname)));

export interface SetupArgs {
  project: string;
  rowDir: string;
}

/** The project from argv[2] and the row dir the script lives in; exits 2 with a usage line when argv[2] is missing. */
export function setupArgs(rowDirname: string): SetupArgs {
  const project = process.argv[2];
  if (project === undefined || project === '') {
    process.stderr.write(`usage: setup-l5.ts <project> [rowDir]  (row: ${rowDirname})\n`);
    process.exit(2);
  }
  return { project, rowDir: rowDirname };
}

export function writeFile(project: string, relPath: string, content: string | Uint8Array): void {
  const path = join(project, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Runs git in <project> (stdout discarded); returns true on exit 0. */
export function git(project: string, args: readonly string[], opts: { quiet?: boolean } = {}): boolean {
  const r = spawnSync('git', args, { cwd: project, stdio: ['ignore', 'ignore', opts.quiet ? 'ignore' : 'inherit'] });
  return r.status === 0;
}

/** Runs git in <project> like git(), but throws when it exits non-zero. */
export function gitOrThrow(project: string, args: readonly string[]): void {
  if (!git(project, args)) throw new Error(`git ${args.join(' ')} failed in ${project}`);
}

export interface GitCommitOptions {
  tolerateFailure?: boolean;
}

/** git add <paths> + git commit -q -m <message>; throws on failure unless tolerateFailure (which also silences git). */
export function gitCommit(project: string, paths: readonly string[], message: string, opts: GitCommitOptions = {}): boolean {
  const quiet = opts.tolerateFailure === true;
  const ok = git(project, ['add', ...paths], { quiet }) && git(project, ['commit', '-q', '-m', message], { quiet });
  if (!ok && !quiet) throw new Error(`git commit failed in ${project}: ${message}`);
  return ok;
}

export function trajectoryDbPath(project: string): string {
  return join(project, '.claude', 'tmb', 'trajectory.db');
}

/** Opens <project>/.claude/tmb/trajectory.db with FK constraints off, runs <fn> on that one connection, closes it. */
export function withDb<T>(project: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(trajectoryDbPath(project), { enableForeignKeyConstraints: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Runs <statements> on the trajectory DB with FK constraints off; with params, one bound statement. */
export function sql(project: string, statements: string, params?: readonly SQLInputValue[]): void {
  withDb(project, (db) => {
    if (params === undefined) db.exec(statements);
    else db.prepare(statements).run(...params);
  });
}

/** The rows one bound SELECT returns from the trajectory DB. */
export function query(project: string, statement: string, params: readonly SQLInputValue[] = []): Record<string, SQLOutputValue>[] {
  return withDb(project, (db) => db.prepare(statement).all(...params));
}

/** Creates the trajectory DB from PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql unless it exists; true when it created it. */
export function ensureSchema(project: string): boolean {
  const path = trajectoryDbPath(project);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  sql(project, readFileSync(join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src', 'schema.sql'), 'utf8'));
  return true;
}

/**
 * Outside run-l5.ts, builds the scratch project it would have: when <project> is not its own git
 * top level (never an enclosing repo's), `git init -b main` with the L5 identity and a committed
 * `.gitignore` of `.claude/`; then a schema-only trajectory DB unless one exists. Throws on failure.
 */
export function ensureStandaloneProject(project: string): void {
  const top = spawnSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (top.status !== 0 || top.stdout.replace(/\n+$/, '') !== realpathSync(project)) {
    gitOrThrow(project, ['init', '-q', '-b', 'main']);
    gitOrThrow(project, ['config', 'user.email', 'l6@l6.test']);
    gitOrThrow(project, ['config', 'user.name', 'L5 Test']);
    writeFile(project, '.gitignore', '.claude/\n');
    gitCommit(project, ['.gitignore'], 'init');
  }
  ensureSchema(project);
}
