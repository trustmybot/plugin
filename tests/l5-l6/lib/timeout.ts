// TypeScript port of timeout-shim.sh (GH 1692): run a command with a time limit. A command
// past its limit is killed with SIGKILL and reports 124, GNU timeout's convention; otherwise
// the command's own exit code comes back (127 when it cannot be found, 128 + n when signal n
// ended it).

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { constants } from 'node:os';

export const TIMEOUT_STATUS = 124;

export interface TimedRun {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type TimedRunOptions = Omit<SpawnSyncOptions, 'timeout' | 'killSignal' | 'encoding'>;

function text(out: string | Buffer | null | undefined): string {
  if (out === null || out === undefined) return '';
  return typeof out === 'string' ? out : out.toString('utf8');
}

/** _l5_timeout <secs> <cmd> <args...>: 0 secs runs without a limit, as GNU timeout does. */
export function runWithTimeout(secs: number, cmd: string, args: readonly string[] = [], opts: TimedRunOptions = {}): TimedRun {
  const r = spawnSync(cmd, args, {
    maxBuffer: 1024 * 1024 * 1024,
    ...opts,
    encoding: 'utf8',
    timeout: secs * 1000,
    killSignal: 'SIGKILL',
  });
  const out = { stdout: text(r.stdout), stderr: text(r.stderr) };
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return { ...out, status: TIMEOUT_STATUS, timedOut: true };
  if (code === 'ENOENT') return { ...out, status: 127, timedOut: false };
  if (r.error) return { ...out, status: 126, timedOut: false };
  if (r.status !== null) return { ...out, status: r.status, timedOut: false };
  const signo = r.signal ? (constants.signals as Record<string, number>)[r.signal] ?? 0 : 0;
  return { ...out, status: 128 + signo, timedOut: false };
}
