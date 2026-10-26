import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_DB, SERVER_DIST, WORK_DIR } from './paths.ts';

export const SNAPSHOT = join(WORK_DIR, 'snapshot.db');

function sqlite3(args: string[]): void {
  const r = spawnSync('sqlite3', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 ${args.join(' ')}: ${r.stderr}`);
}

/** The live DB is only ever opened with `sqlite3 -readonly`; every experiment reads a frozen copy. */
export function ensureSnapshot(): string {
  if (existsSync(SNAPSHOT)) return SNAPSHOT;
  mkdirSync(WORK_DIR, { recursive: true });
  sqlite3(['-readonly', LIVE_DB, `.backup '${SNAPSHOT}'`]);
  sqlite3([SNAPSHOT, 'pragma journal_mode=delete;']);
  return SNAPSHOT;
}

/** A throwaway copy for anything that might write (the MCP server opens its DB read-write). */
export function scratchCopy(name: string): string {
  const dst = join(WORK_DIR, `${name}.db`);
  copyFileSync(ensureSnapshot(), dst);
  return dst;
}

export function query<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
  const db = new DatabaseSync(ensureSnapshot(), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

let handlers: Record<string, Handler> | null = null;

export async function loadToolHandlers(): Promise<Record<string, Handler>> {
  if (handlers) return handlers;
  const dbPath = scratchCopy('tools');
  const { TrajectoryDB } = await import(join(SERVER_DIST, 'db.js'));
  const { GraphHolder, WorldModelGraph } = await import(join(SERVER_DIST, 'graph.js'));
  const tools = await import(join(SERVER_DIST, 'tools', 'index.js'));
  const db = new TrajectoryDB(dbPath, undefined, { migrate: false });
  tools.registerTools(null, db, dbPath, GraphHolder.fixed(new WorldModelGraph(db)));
  handlers = tools.toolHandlers as Record<string, Handler>;
  return handlers;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const h = (await loadToolHandlers())[name];
  if (!h) throw new Error(`no tool ${name}`);
  const r = await h({ agent: 'bro', ...args });
  if (r.isError) throw new Error(`${name} error: ${r.content[0]?.text}`);
  return r.content.map((c) => c.text ?? '').join('\n');
}
