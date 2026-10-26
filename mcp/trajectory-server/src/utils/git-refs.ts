import { execFileSync, spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';

function refResolves(repoPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// A base passed as 'origin/<branch>' names <branch>, unless a local branch is
// literally called 'origin/<branch>' (GH 1855).
export function normalizeBase(repoPath: string, base: string): string {
  if (!base.startsWith('origin/') || refResolves(repoPath, `refs/heads/${base}`)) return base;
  return base.slice('origin/'.length);
}

// Resolve a base branch name to a concrete git ref, preferring the freshest
// remote-tracking ref. Returns `origin/<base>` when it resolves (remote-present
// repos — freshest-origin doctrine unchanged), else the local `<base>` when
// refs/heads/<base> resolves (remoteless repos: L6 sandboxes, fresh local
// projects, local-only stacked bases), else null when neither exists.
export function resolveBaseRef(repoPath: string, rawBase: string): string | null {
  const base = normalizeBase(repoPath, rawBase);
  if (refResolves(repoPath, `origin/${base}`)) return `origin/${base}`;
  if (refResolves(repoPath, `refs/heads/${base}`)) return base;
  return null;
}

export interface CutBase {
  ref: string;
  diverged?: { local_sha: string; remote_sha: string; ahead: number; behind: number };
}

// The ref a task branch is cut from, with `git pull --ff-only` semantics:
// local `<base>` when it is a strict descendant of `origin/<base>` (unpushed
// work the task stacks on), else `origin/<base>`. When the two have diverged
// the cut stays on origin and `diverged` carries both SHAs and the distance
// (`ahead`/`behind` of local relative to origin). Only one side existing
// returns that side; neither returns null.
export function resolveCutBase(repoPath: string, rawBase: string): CutBase | null {
  const base = normalizeBase(repoPath, rawBase);
  const remoteRef = `origin/${base}`;
  const remoteSha = gitOut(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}^{commit}`]);
  const localSha = gitOut(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`]);
  if (!remoteSha) return localSha ? { ref: base } : null;
  if (!localSha || localSha === remoteSha) return { ref: remoteRef };
  const counts = gitOut(repoPath, ['rev-list', '--left-right', '--count', `${remoteSha}...${localSha}`]);
  const [behind, ahead] = (counts ?? '').split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ref: remoteRef };
  if (behind === 0 && ahead! > 0) return { ref: base };
  if (ahead === 0) return { ref: remoteRef };
  return { ref: remoteRef, diverged: { local_sha: localSha, remote_sha: remoteSha, ahead: ahead!, behind: behind! } };
}

export function branchRefExists(repoPath: string, branch: string): boolean {
  return refResolves(repoPath, `refs/heads/${branch}`) || refResolves(repoPath, `refs/remotes/origin/${branch}`);
}

function gitOut(repoPath: string, args: string[]): string | null {
  const res = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

// Twin of the hooks' tmb_repo_default_branch: origin/HEAD, else the first of
// main/master/dev that exists locally, else the checked-out branch, else 'main'.
export function resolveRepoDefaultBranch(repoPath: string): string {
  const originHead = gitOut(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) return originHead.replace(/^origin\//, '');
  for (const candidate of ['main', 'master', 'dev']) {
    if (refResolves(repoPath, `refs/heads/${candidate}`)) return candidate;
  }
  return gitOut(repoPath, ['symbolic-ref', '--short', 'HEAD']) ?? 'main';
}
