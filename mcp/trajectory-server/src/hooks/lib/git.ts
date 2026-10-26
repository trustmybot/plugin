/**
 * `git -C <dir> <args>` for the hook gates (GH 1692): argv only, never a shell
 * string, stderr dropped as the .sh's `2>/dev/null` does, and no timeout of
 * its own, as the .sh runs git with none (the hook's timeout bounds it).
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export interface GitRun {
  code: number;
  stdout: string;
}

export function gitRun(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, input = ''): GitRun {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return { code: r.error ? -1 : (r.status ?? -1), stdout: r.stdout ?? '' };
}

/** `$(git -C <dir> <args> 2>/dev/null)`: stdout minus its trailing newlines, whatever the exit code. */
export function gitOut(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, input = ''): string {
  return gitRun(dir, args, env, input).stdout.replace(/\n+$/, '');
}

export function gitOk(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return gitRun(dir, args, env).code === 0;
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
