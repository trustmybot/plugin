// Shared helpers for the rows' setup-l5.ts scripts (GH 1692). run-l5.ts runs each as
// `node --experimental-strip-types --experimental-sqlite <row>/setup-l5.ts <project> <rowDir>`;
// the script pre-seeds the scratch project's files, git history and trajectory DB.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

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

/** Runs <statements> on <project>/.claude/tmb/trajectory.db with FK constraints off; with params, one bound statement. */
export function sql(project: string, statements: string, params?: readonly SQLInputValue[]): void {
  const db = new DatabaseSync(join(project, '.claude', 'tmb', 'trajectory.db'), { enableForeignKeyConstraints: false });
  try {
    if (params === undefined) db.exec(statements);
    else db.prepare(statements).run(...params);
  } finally {
    db.close();
  }
}
