import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason } from '../utils/live-cli-guard.js';
import { classifyUrl } from '../utils/classify-url.js';

export interface BackendAvailability {
  gh: boolean;
  glab: boolean;
}

let _availabilityCache: BackendAvailability | null = null;

export function resetAvailabilityCache(): void {
  _availabilityCache = null;
}

export function detectAvailable(
  _spawnFn?: (cmd: string, args: string[]) => { status: number | null },
): BackendAvailability {
  if (_spawnFn === undefined && _availabilityCache !== null) {
    return _availabilityCache;
  }

  const check = (cmd: string, args: string[]): boolean => {
    try {
      if (_spawnFn) {
        const result = _spawnFn(cmd, args);
        return result.status === 0;
      }
      if (liveCliBlockReason()) return false;
      const result = spawnSync(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
      return result.status === 0;
    } catch {
      return false;
    }
  };

  const result = {
    gh: check('gh', ['auth', 'status']),
    glab: check('glab', ['auth', 'status']),
  };

  if (_spawnFn === undefined) {
    _availabilityCache = result;
  }
  return result;
}

export function detectPreferred(): 'gh' | 'glab' | null {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    const url = (result.stdout ?? '').trim();
    const provider = classifyUrl(url);
    if (provider === 'github') return 'gh';
    if (provider === 'gitlab') return 'glab';
    return null;
  } catch {
    return null;
  }
}

// Which providers the issue's repo actually has remotes for, derived from the
// repos.remotes row (#1043) — the same source issues.ts uses to pick the gh
// --repo / glab -R target. The 'auto' backend decision reads THIS, not a
// process.cwd() `git remote` probe, so sync works in a non-git-root / multi-repo
// workspace.
export interface RepoRemoteProviders {
  github: boolean;
  gitlab: boolean;
}

export function resolveBackend(
  configValue: string,
  repoRemotes?: RepoRemoteProviders | null,
  hasSpawnFn = false,
  availability?: BackendAvailability,
): 'gh' | 'glab' | 'both' | 'off' | null {
  if (
    !hasSpawnFn &&
    (process.env.TMB_DISABLE_REMOTE_SYNC === '1' ||
      process.env.TMB_DISABLE_REMOTE_SYNC?.toLowerCase() === 'true')
  ) {
    return null;
  }

  if (configValue === 'off') return 'off';
  if (configValue === 'gh') return 'gh';
  if (configValue === 'glab') return 'glab';
  if (configValue === 'both') return 'both';

  // 'auto' — derive the decision from the issue repo's configured remotes
  // (repos.remotes), gated only by a CLI-availability check that confirms the
  // chosen CLI is installed/authed. No process.cwd() git probe.
  const available = availability ?? detectAvailable();
  const ghUsable = (repoRemotes?.github ?? false) && available.gh;
  const glUsable = (repoRemotes?.gitlab ?? false) && available.glab;
  if (ghUsable && glUsable) return 'both';
  if (ghUsable) return 'gh';
  if (glUsable) return 'glab';
  return null;
}
