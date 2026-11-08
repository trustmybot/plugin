import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';

export type GitRunOptions = SpawnSyncOptionsWithStringEncoding & { cwd: string };
export type GitRunner = (args: string[], options: GitRunOptions) => SpawnSyncReturns<string>;

const spawnGit: GitRunner = (args, options) => spawnSync('git', args, { ...options, cwd: options.cwd });
let runner: GitRunner = spawnGit;

export function runGit(
  repoPath: string,
  args: string[],
  options: Partial<Omit<SpawnSyncOptionsWithStringEncoding, 'cwd'>> = {},
): SpawnSyncReturns<string> {
  const dir = resolve(repoPath);
  return runner(['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
    ...options,
    cwd: dir,
  });
}

// A timed-out, signalled or unspawnable git leaves error set or status null:
// git gave no answer, which is not the same as a non-zero "no".
export function gitUnanswered(res: SpawnSyncReturns<string>): boolean {
  return !!res.error || res.status === null;
}

export function __setGitRunnerForTests(next: GitRunner = spawnGit): void {
  runner = next;
}
