import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { spawnAsync, type SpawnResult } from './spawn-async.js';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';

export type GitRunOptions = SpawnSyncOptionsWithStringEncoding & { cwd: string };
export type GitRunner = (args: string[], options: GitRunOptions) => SpawnSyncReturns<string>;
// status is null when git gave no answer (timed out, signalled or never started).
export type GitAsyncResult = SpawnResult;
export type GitAsyncRunner = (args: string[], options: GitRunOptions) => Promise<GitAsyncResult>;

const spawnGit: GitRunner = (args, options) => spawnSync('git', args, { ...options, cwd: options.cwd });
const spawnGitAsync: GitAsyncRunner = (args, options) => spawnAsync('git', args, { ...options, cwd: options.cwd });
let runner: GitRunner = spawnGit;
let asyncRunner: GitAsyncRunner = spawnGitAsync;

function gitOptions(
  dir: string,
  options: Partial<Omit<SpawnSyncOptionsWithStringEncoding, 'cwd'>>,
): GitRunOptions {
  return { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS, ...options, cwd: dir };
}

export function runGit(
  repoPath: string,
  args: string[],
  options: Partial<Omit<SpawnSyncOptionsWithStringEncoding, 'cwd'>> = {},
): SpawnSyncReturns<string> {
  const dir = resolve(repoPath);
  return runner(['-C', dir, ...args], gitOptions(dir, options));
}

// runGit for the server's long-running spawns (a network fetch, worktree add):
// the MCP server is one process for every lane, so these must not block it.
export function runGitAsync(
  repoPath: string,
  args: string[],
  options: Partial<Omit<SpawnSyncOptionsWithStringEncoding, 'cwd'>> = {},
): Promise<GitAsyncResult> {
  const dir = resolve(repoPath);
  return asyncRunner(['-C', dir, ...args], gitOptions(dir, options));
}

// A timed-out, signalled or unspawnable git leaves error set or status null:
// git gave no answer, which is not the same as a non-zero "no".
export function gitUnanswered(res: SpawnSyncReturns<string>): boolean {
  return !!res.error || res.status === null;
}

function answeredAsync(syncRunner: GitRunner): GitAsyncRunner {
  return (args, options) =>
    new Promise((settle) => {
      const res = syncRunner(args, options);
      settle({
        status: gitUnanswered(res) ? null : res.status,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        ...(res.error ? { error: res.error } : {}),
      });
    });
}

// A sync runner stands in for runGitAsync too, so one seam sees every git call.
export function __setGitRunnerForTests(next?: GitRunner): void {
  runner = next ?? spawnGit;
  asyncRunner = next ? answeredAsync(next) : spawnGitAsync;
}

export function __setGitAsyncRunnerForTests(next: GitAsyncRunner = spawnGitAsync): void {
  asyncRunner = next;
}
