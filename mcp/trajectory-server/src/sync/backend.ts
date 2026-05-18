import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';

export interface BackendAvailability {
  gh: boolean;
  glab: boolean;
}

export function detectAvailable(): BackendAvailability {
  const check = (cmd: string, args: string[]): boolean => {
    try {
      const result = spawnSync(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
      return result.status === 0;
    } catch {
      return false;
    }
  };

  return {
    gh: check('gh', ['auth', 'status']),
    glab: check('glab', ['auth', 'status']),
  };
}

export function detectPreferred(): 'gh' | 'glab' | null {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    const url = (result.stdout ?? '').trim();
    if (url.includes('github.com')) return 'gh';
    if (url.includes('gitlab.com')) return 'glab';
    return null;
  } catch {
    return null;
  }
}

export function resolveBackend(
  configValue: string,
  hasSpawnFn = false,
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

  // 'auto' — detect at runtime
  const available = detectAvailable();
  if (!available.gh && !available.glab) return null;

  const preferred = detectPreferred();
  if (preferred === 'gh' && available.gh) return 'gh';
  if (preferred === 'glab' && available.glab) return 'glab';

  // No origin preference — use whichever is available (gh preferred)
  if (available.gh) return 'gh';
  if (available.glab) return 'glab';
  return null;
}
