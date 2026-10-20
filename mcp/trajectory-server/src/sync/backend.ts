import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason } from '../utils/live-cli-guard.js';
import { classifyUrl } from '../utils/classify-url.js';
import type { TrajectoryDB } from '../db.js';

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

// Which CLI the repo at `repoPath` (the issue's repos.path, else the project
// root) points its origin at. A null path keeps the in-memory test behaviour.
export function detectPreferred(repoPath: string | null): 'gh' | 'glab' | null {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      ...(repoPath === null ? {} : { cwd: repoPath }),
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
// repo's repo_remotes rows (#1043) — the same source issues.ts uses to pick the gh
// --repo / glab -R target. The 'auto' backend decision reads THIS, not a
// process.cwd() `git remote` probe, so sync works in a non-git-root / multi-repo
// workspace.
export interface RepoRemoteProviders {
  github: boolean;
  gitlab: boolean;
}

function remoteSyncEnvDisabled(): boolean {
  const v = process.env.TMB_DISABLE_REMOTE_SYNC;
  return v === '1' || v?.toLowerCase() === 'true';
}

export function resolveBackend(
  configValue: string,
  repoRemotes?: RepoRemoteProviders | null,
  hasSpawnFn = false,
  availability?: BackendAvailability,
): 'gh' | 'glab' | 'both' | 'off' | null {
  if (!hasSpawnFn && remoteSyncEnvDisabled()) {
    return null;
  }

  if (configValue === 'off') return 'off';
  if (configValue === 'gh') return 'gh';
  if (configValue === 'glab') return 'glab';
  if (configValue === 'both') return 'both';

  // 'auto' — derive the decision from the issue repo's configured remotes
  // (repo_remotes), gated only by a CLI-availability check that confirms the
  // chosen CLI is installed/authed. No process.cwd() git probe.
  const available = availability ?? detectAvailable();
  const ghUsable = (repoRemotes?.github ?? false) && available.gh;
  const glUsable = (repoRemotes?.gitlab ?? false) && available.glab;
  if (ghUsable && glUsable) return 'both';
  if (ghUsable) return 'gh';
  if (glUsable) return 'glab';
  return null;
}

// resolveBackend for a tool that may carry an injected spawn: the spawn also
// answers the 'auto' gh/glab availability probe, as remoteSyncGate does.
export function resolveBackendFor(
  configValue: string,
  repoRemotes: RepoRemoteProviders | null,
  spawnFn?: (cmd: string, args: string[]) => { status: number | null },
): 'gh' | 'glab' | 'both' | 'off' | null {
  const availability = configValue === 'auto' && spawnFn ? detectAvailable(spawnFn) : undefined;
  return resolveBackend(configValue, repoRemotes, spawnFn !== undefined, availability);
}

export type RemoteSyncGateReason = 'issue_sync_off' | 'env_disabled' | 'no_backend';

export interface RemoteSyncGate {
  enabled: boolean;
  reason?: RemoteSyncGateReason;
}

function readIssueSyncConfig(db: TrajectoryDB): string {
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  if (!row) return 'off';
  try {
    return String(JSON.parse(row.value_json));
  } catch {
    return 'off';
  }
}

// The one kill-switch every server-side remote write consults. The env var wins
// over everything, including an injected spawn: a disabled workspace reaches no
// remote. `repoRemotes` is the issue repo's configured providers; `spawnFn`,
// when injected, also answers the gh/glab availability probe of 'auto'.
export function remoteSyncGate(
  db: TrajectoryDB,
  opts: {
    repoRemotes?: RepoRemoteProviders | null;
    spawnFn?: (cmd: string, args: string[]) => { status: number | null };
  } = {},
): RemoteSyncGate {
  if (remoteSyncEnvDisabled()) return { enabled: false, reason: 'env_disabled' };
  const config = readIssueSyncConfig(db);
  if (config === 'off') return { enabled: false, reason: 'issue_sync_off' };
  const explicit = config === 'gh' || config === 'glab' || config === 'both';
  const availability = explicit ? undefined : detectAvailable(opts.spawnFn);
  const backend = resolveBackend(config, opts.repoRemotes ?? null, true, availability);
  if (backend === null || backend === 'off') return { enabled: false, reason: 'no_backend' };
  return { enabled: true };
}
