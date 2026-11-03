/**
 * What both MCP-down fallback subcommands share (GH 1692): the trajectory DB
 * they act on — the one the hooks resolve, else where it was expected — the
 * db-not-found reply, and the stdout/stderr sink a subcommand writes through.
 */
import { statSync } from 'node:fs';
import { dbLocation, dbResolve } from '../hooks/lib/db.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export function isFile(path: string): boolean {
  if (path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The resolved DB, else TRAJECTORY_DB_PATH, else CLAUDE_PROJECT_DIR's DB location, else "". */
export function fallbackDbPath(env: NodeJS.ProcessEnv): string {
  const resolved = dbResolve(env).path;
  if (resolved !== null) return resolved;
  if ((env.TRAJECTORY_DB_PATH ?? '') !== '') return env.TRAJECTORY_DB_PATH as string;
  if ((env.CLAUDE_PROJECT_DIR ?? '') !== '') return dbLocation(env.CLAUDE_PROJECT_DIR as string, env);
  return '';
}

export function dbNotFoundJson(db: string): string {
  return `{"error":"db-not-found","path":"${db || 'unresolved'}","hint":"Set CLAUDE_PROJECT_DIR to the project root (or TRAJECTORY_DB_PATH to the DB)."}\n`;
}

export function digitsOr(value: string | undefined, fallback: number): number {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}
