/**
 * `git -C <dir> <args>` for the hook gates (GH 1692): argv only, never a shell
 * string, stderr dropped as the .sh's `2>/dev/null` does. Under the router the
 * child is killed at the running gate's deadline (decisions 922 and 937);
 * outside it, as the .sh runs git, with no timeout of its own.
 *
 * Within one router call (runWithGitMemo, decision 937) the gates share git: a
 * read this file can prove read-only runs once and identical `fetch`es share one
 * run, for callers on the router's own env with stderr dropped and no timeout of
 * their own. Any other git counts as a writer and clears the reads, before it
 * starts and when it settles. A run the deadline cut is never shared: each waiter
 * keeps its own deadline, and one with time left runs git again.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { deadlineSignal, markDeadlineExpired, noteSpawn, spawnLimit } from './deadline.js';

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

function timedOut(args: readonly string[]): Error {
  return codedError(`git ${args[0] ?? ''} timed out`, 'ETIMEDOUT');
}

/**
 * The one spawn of git. Code -1 when it failed to start, was cut off or passed
 * GIT_MAX_BUFFER, with what it printed before that. Past the deadline it never
 * starts. A cut drops the output pipes, so a child's own child holding one open
 * cannot keep the run from settling.
 */
async function spawnGit(dir: string, args: readonly string[], options: GitSpawnOptions): Promise<GitBytes> {
  const { env = process.env, input = '', stderr = 'ignore', timeoutMs } = options;
  const limit = spawnLimit(timeoutMs);
  const signal = limit === null ? undefined : limit.byDeadline ? deadlineSignal() : AbortSignal.timeout(limit.timeout);
  if (signal?.aborted) {
    const error = timedOut(args);
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
      cut = timedOut(args);
      dropOutput();
    });
    child.on('close', (code, killedBy) => finish(code, killedBy));
    child.stdin?.end(input);
  });
}

interface MemoEntry {
  kind: 'read' | 'fetch';
  settled: boolean;
  run: Promise<GitBytes>;
}

interface GitMemo {
  env: NodeJS.ProcessEnv;
  entries: Map<string, MemoEntry>;
}

const memos = new AsyncLocalStorage<GitMemo>();

/** Runs <body> with one empty memo for the git it runs on <env>; outside it nothing is memoized. */
export async function runWithGitMemo<T>(env: NodeJS.ProcessEnv, body: () => Promise<T>): Promise<T> {
  return await memos.run({ env, entries: new Map() }, body);
}

const READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['rev-parse', 'show-ref', 'merge-base', 'cat-file', 'status']);
/** `log` and `rev-list` take the diff options, and `--output=<file>` writes that file; every prefix of it is refused too. */
const WALK_SUBCOMMANDS: ReadonlySet<string> = new Set(['log', 'rev-list']);
const WRITES_A_FILE = /^--ou/;
const SYMBOLIC_REF_READ_FLAGS: ReadonlySet<string> = new Set(['--short', '-q', '--quiet']);

/** Whether <args> is on the read-only allowlist: args[0] has to be the subcommand, so a leading `-c` is not admitted. */
export function isProvablyReadOnly(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  if (READ_SUBCOMMANDS.has(subcommand)) return true;
  if (WALK_SUBCOMMANDS.has(subcommand)) return !rest.some((arg) => WRITES_A_FILE.test(arg));
  if (subcommand === 'remote') return rest[0] === 'get-url';
  if (subcommand === 'worktree') return rest[0] === 'list';
  if (subcommand !== 'symbolic-ref') return false;
  const others = rest.filter((arg) => !SYMBOLIC_REF_READ_FLAGS.has(arg));
  return others.length === 1 && !others[0].startsWith('-');
}

/** `fetch`, bare or behind `-c http.*` pairs. */
function isFetch(args: readonly string[]): boolean {
  let at = 0;
  while (args[at] === '-c' && args[at + 1]?.startsWith('http.')) at += 2;
  return args[at] === 'fetch';
}

function isCut(r: GitBytes): boolean {
  return r.code === -1 && (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}

/** Drops every read, in flight or settled; with <settledFetches>, the fetches already done too. A fetch in flight stays, so its twins still join it. */
function forget(memo: GitMemo, settledFetches: boolean): void {
  for (const [key, entry] of memo.entries) {
    if (entry.kind === 'read' || (settledFetches && entry.settled)) memo.entries.delete(key);
  }
}

function startShared(memo: GitMemo, key: string, kind: MemoEntry['kind'], dir: string, args: readonly string[], options: GitSpawnOptions): Promise<GitBytes> {
  const conclude = (keep: boolean): void => {
    entry.settled = true;
    if (!keep && memo.entries.get(key) === entry) memo.entries.delete(key);
    if (kind === 'fetch') forget(memo, false);
  };
  const entry: MemoEntry = {
    kind,
    settled: false,
    run: spawnGit(dir, args, options).then(
      (r) => {
        conclude(kind === 'read' ? r.code !== -1 : r.code === 0);
        return r;
      },
      (failure: unknown) => {
        conclude(false);
        throw failure;
      },
    ),
  };
  memo.entries.set(key, entry);
  return entry.run;
}

const OWN_DEADLINE = Symbol('own-deadline');

async function untilOwnDeadline(run: Promise<GitBytes>, signal: AbortSignal | undefined): Promise<GitBytes | typeof OWN_DEADLINE> {
  if (signal === undefined) return await run;
  let onAbort = (): void => undefined;
  const aborted = new Promise<typeof OWN_DEADLINE>((resolve) => {
    onAbort = () => resolve(OWN_DEADLINE);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A run of the memo: the starter's, or a wait on it that the waiter's own deadline ends. A run cut by someone else's deadline is gone from the memo by then, so the next pass runs git again. */
async function sharedRun(memo: GitMemo, kind: MemoEntry['kind'], dir: string, args: readonly string[], options: GitSpawnOptions): Promise<GitBytes> {
  const key = JSON.stringify([dir, args, options.input ?? '']);
  const signal = deadlineSignal();
  for (;;) {
    const held = memo.entries.get(key);
    if (held === undefined) return await startShared(memo, key, kind, dir, args, options);
    const r = signal?.aborted ? OWN_DEADLINE : await untilOwnDeadline(held.run, signal);
    if (r === OWN_DEADLINE) {
      markDeadlineExpired();
      return { code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: timedOut(args) };
    }
    if (!isCut(r)) return r;
  }
}

/** Git through the running router call's memo, when there is one. Results are shared objects: callers only read them. */
export async function gitSpawn(dir: string, args: readonly string[], options: GitSpawnOptions = {}): Promise<GitBytes> {
  const memo = memos.getStore();
  if (memo === undefined) return await spawnGit(dir, args, options);
  const sharable = (options.env ?? process.env) === memo.env && (options.stderr ?? 'ignore') === 'ignore' && options.timeoutMs === undefined;
  if (isProvablyReadOnly(args)) return sharable ? await sharedRun(memo, 'read', dir, args, options) : await spawnGit(dir, args, options);
  if (sharable && isFetch(args)) return await sharedRun(memo, 'fetch', dir, args, options);
  forget(memo, true);
  try {
    return await spawnGit(dir, args, options);
  } finally {
    forget(memo, true);
  }
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
