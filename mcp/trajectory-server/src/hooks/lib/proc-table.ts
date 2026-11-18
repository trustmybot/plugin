/**
 * Async process probes for the SessionStart gates (GH 3232): a child's stdout
 * without blocking the event loop, and one `ps -A` process-table snapshot per
 * env object, so the gates of one router call (which share the env) walk
 * ancestry and read elapsed times from a single ps run. Inside a router
 * deadline scope a child is killed at the gate's deadline, as lib/git.ts does.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { deadlineSignal, noteSpawn, spawnLimit } from './deadline.js';

export interface ProcRow {
  ppid: string;
  /** ps etime, `[DD-][HH:]MM:SS`. */
  etime: string;
  command: string;
}

export type ProcTable = ReadonlyMap<string, ProcRow>;

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,etime=,command='] as const;
const ROW = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s?(.*)$/;

function cutError(cmd: string): Error {
  return Object.assign(new Error(`${cmd} timed out`), { code: 'ETIMEDOUT' });
}

/** <cmd> <args>'s stdout, stdin and stderr ignored; "" when it fails to start or is cut off. */
export async function captureStdout(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const limit = spawnLimit();
  const signal = limit === null ? undefined : deadlineSignal();
  if (signal?.aborted) {
    noteSpawn(limit, { error: cutError(cmd), signal: null });
    return '';
  }
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let failure: Error | undefined;
    let done = false;
    const finish = (killedBy: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      noteSpawn(limit, { error: failure, signal: killedBy });
      resolve(failure || killedBy !== null ? '' : Buffer.concat(chunks).toString('utf8'));
    };
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'ignore'], signal });
    } catch (err) {
      // Some exec failures (EPERM from a sandbox, for one) throw here rather than emit 'error'.
      failure = err instanceof Error ? err : new Error(String(err));
      finish(null);
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdout.on('error', () => undefined);
    child.on('error', (err) => {
      failure = err.name === 'AbortError' ? cutError(cmd) : err;
      child.stdout.destroy();
      if (err.name !== 'AbortError') finish(null);
    });
    child.on('close', (_code, killedBy) => finish(killedBy));
  });
}

/** A pid as ps prints it: decimal digits without leading zeros; anything else as given. */
function pidKey(pid: string): string {
  const trimmed = pid.trim();
  return /^[0-9]+$/.test(trimmed) ? BigInt(trimmed).toString() : pid;
}

/** The rows of `ps -A -o pid=,ppid=,etime=,command=` output, by pid. */
export function parseProcessTable(text: string): ProcTable {
  const table = new Map<string, ProcRow>();
  for (const line of text.split('\n')) {
    const m = ROW.exec(line);
    if (m !== null) table.set(pidKey(m[1]), { ppid: pidKey(m[2]), etime: m[3], command: m[4] });
  }
  return table;
}

/** <pid>'s row, or undefined when the snapshot does not hold it. */
export function procRow(table: ProcTable, pid: string): ProcRow | undefined {
  return table.get(pidKey(pid));
}

const snapshots = new WeakMap<NodeJS.ProcessEnv, Promise<ProcTable>>();

/**
 * The process table, taken once per <env> and shared by every caller on it. An
 * empty snapshot (ps missing, failing or cut off) is not kept, so a later
 * caller with time left takes its own.
 */
export function processTable(env: NodeJS.ProcessEnv): Promise<ProcTable> {
  if (!snapshots.has(env)) snapshots.set(env, takeSnapshot(env));
  return snapshots.get(env)!;
}

/** Only takeSnapshot drops an entry, so while its snapshot is pending the entry for <env> is that snapshot. */
function takeSnapshot(env: NodeJS.ProcessEnv): Promise<ProcTable> {
  return captureStdout('ps', PS_ARGS, env).then((text) => {
    const table = parseProcessTable(text);
    if (table.size === 0) snapshots.delete(env);
    return table;
  });
}
