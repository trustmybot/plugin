import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';

export type GitRunner = (args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;

const spawnGit: GitRunner = (args, options) => spawnSync('git', args, options);
let runner: GitRunner = spawnGit;

export function runGit(
  repoPath: string,
  args: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
): SpawnSyncReturns<string> {
  return runner(['-C', repoPath, ...args], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS, ...options });
}

// A timed-out, signalled or unspawnable git leaves error set or status null:
// git gave no answer, which is not the same as a non-zero "no".
export function gitUnanswered(res: SpawnSyncReturns<string>): boolean {
  return !!res.error || res.status === null;
}

export function __setGitRunnerForTests(next: GitRunner = spawnGit): void {
  runner = next;
}
