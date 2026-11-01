/**
 * `git -C <dir> <args>` for the hook gates (GH 1692): argv only, never a shell
 * string, stderr dropped as the .sh's `2>/dev/null` does. Under the router the
 * child is killed at the running gate's deadline (decisions 922 and 937);
 * outside it, as the .sh runs git, with no timeout of its own.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { deadlineSignal, noteSpawn, spawnLimit } from './deadline.js';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export interface GitRun {
  code: number;
  stdout: string;
}

export interface GitSpawnOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  stderr?: 'ignore' | 'inherit' | 'pipe';
  /** A limit of the caller's own; the deadline still wins when it is sooner. */
  timeoutMs?: number;
}

export interface GitBytes {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  /** Why the child failed to start or was cut off. */
  error?: Error;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A stream's bytes up to GIT_MAX_BUFFER; `over` turns true past it, where the output is truncated and the run fails. */
function collector(): { add(chunk: Buffer): void; bytes(): Buffer; over(): boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add(chunk) {
      if (size <= GIT_MAX_BUFFER) chunks.push(chunk.subarray(0, GIT_MAX_BUFFER - size + 1));
      size += chunk.length;
    },
    bytes: () => Buffer.concat(chunks).subarray(0, GIT_MAX_BUFFER),
    over: () => size > GIT_MAX_BUFFER,
  };
}

/**
 * The one spawn of git. Code -1 when it failed to start, was cut off or passed
 * GIT_MAX_BUFFER, with what it printed before that. Past the deadline it never
 * starts. A cut drops the output pipes, so a child's own child holding one open
 * cannot keep the run from settling.
 */
export async function gitSpawn(dir: string, args: readonly string[], options: GitSpawnOptions = {}): Promise<GitBytes> {
  const { env = process.env, input = '', stderr = 'ignore', timeoutMs } = options;
  const limit = spawnLimit(timeoutMs);
  const signal = limit === null ? undefined : limit.byDeadline ? deadlineSignal() : AbortSignal.timeout(limit.timeout);
  const timedOut = (): Error => codedError(`git ${args[0] ?? ''} timed out`, 'ETIMEDOUT');
  if (signal?.aborted) {
    const error = timedOut();
    noteSpawn(limit, { error, signal: null });
    return { code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
  }
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, ...args], { env, stdio: ['pipe', 'pipe', stderr], signal });
    const out = collector();
    const err = collector();
    let cut: Error | undefined;
    let done = false;
    const dropOutput = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (code: number | null, killedBy: NodeJS.Signals | null, failure?: Error): void => {
      if (done) return;
      done = true;
      const overflow = out.over() || err.over() ? codedError(`git ${args[0] ?? ''} passed its output limit`, 'ENOBUFS') : undefined;
      const error = failure ?? cut ?? overflow;
      noteSpawn(limit, { error, signal: killedBy });
      resolve({ code: error || code === null ? -1 : code, stdout: out.bytes(), stderr: err.bytes(), error });
    };
    const take = (into: ReturnType<typeof collector>, chunk: Buffer): void => {
      into.add(chunk);
      if (!into.over()) return;
      dropOutput();
      child.kill();
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => undefined);
    child.stdout?.on('data', (chunk: Buffer) => take(out, chunk));
    child.stderr?.on('data', (chunk: Buffer) => take(err, chunk));
    child.on('error', (failure) => {
      if (failure.name !== 'AbortError') {
        finish(null, null, failure);
        return;
      }
      cut = timedOut();
      dropOutput();
    });
    child.on('close', (code, killedBy) => finish(code, killedBy));
    child.stdin?.end(input);
  });
}

export async function gitRun(
  dir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  input = '',
  stderr: 'ignore' | 'inherit' = 'ignore',
): Promise<GitRun> {
  const r = await gitSpawn(dir, args, { env, input, stderr });
  return { code: r.code, stdout: r.stdout.toString('utf8') };
}

/** `$(git -C <dir> <args> 2>/dev/null)`: stdout minus its trailing newlines, whatever the exit code. */
export async function gitOut(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, input = ''): Promise<string> {
  return (await gitRun(dir, args, env, input)).stdout.replace(/\n+$/, '');
}

/** `git -C <dir> <args>` succeeded; `stderr: 'inherit'` for a call the .sh leaves unsilenced. */
export async function gitOk(
  dir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  stderr: 'ignore' | 'inherit' = 'ignore',
): Promise<boolean> {
  return (await gitRun(dir, args, env, '', stderr)).code === 0;
}

/** `[ -d <path> ]`. */
export function isDir(path: string): boolean {
  if (path === '') return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The dir `(cd <path> && pwd)` prints: <path> made absolute with `.`, `..` and repeated slashes folded, or "" when it is no dir. */
export function cdPwd(path: string, pwd: string): string {
  if (!isDir(path === '' ? '.' : path)) return '';
  const abs = path.startsWith('/') ? path : `${pwd.replace(/\/$/, '')}/${path}`;
  const out: string[] = [];
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
