import type { TrajectoryDB } from '../db.js';

export function resolveDefaultRepoPath(db: TrajectoryDB): string | undefined {
  return resolveDefaultRepo(db)?.path;
}

export interface RepoRemote {
  name?: string;
  provider: string;
  url: string;
}

export interface ResolvedRepoSync {
  name: string;
  path: string;
  remotes: RepoRemote[];
}

// Issue-scoped repo resolution for the sync path (#155/#146). Resolve the repo
// an issue belongs to, returning its on-disk path AND the per-repo remotes
// drained into repos.remotes. The sync caller uses `path` as the explicit cwd
// and `remotes` to pick the gh --repo / glab -R target — never process.cwd().
//
// Resolution order:
//   1. An explicit repo name (the issue's repo column) → that repos row.
//   2. The single-repo fallback when exactly one repos row exists.
// Returns null when no repo resolves (multi-repo with no selector, or no repos
// row at all) so the caller raises a named, actionable error.
export function resolveRepoForSync(
  db: TrajectoryDB,
  repoName?: string | null,
): ResolvedRepoSync | null {
  const decodeRemotes = (raw: string | null): RepoRemote[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as RepoRemote[];
    } catch {
      // malformed remotes blob — treat as none
    }
    return [];
  };

  if (repoName) {
    const row = db.get<{ name: string; path: string; remotes: string | null }>(
      `SELECT name, path, remotes FROM repos WHERE name = ?`,
      [repoName],
    );
    if (!row) return null;
    return { name: row.name, path: row.path, remotes: decodeRemotes(row.remotes) };
  }

  const rows = db.all<{ name: string; path: string; remotes: string | null }>(
    `SELECT name, path, remotes FROM repos`,
  );
  if (rows.length !== 1) return null;
  const sole = rows[0]!;
  return { name: sole.name, path: sole.path, remotes: decodeRemotes(sole.remotes) };
}

// Path-keyed repo resolution. There is no name-keyed global default — callers
// needing a specific repo pass `tasks.repo` (resolved via `repos.path`). The
// only implicit resolution is the single-repo fallback: when exactly one repo
// is registered, that repo IS the default. Multi-repo with no explicit selector
// returns undefined and the caller decides.
export function resolveDefaultRepo(
  db: TrajectoryDB,
  name?: string,
): { name: string; path: string } | undefined {
  if (name) {
    const repoRow = db.get<{ path: string }>(
      `SELECT path FROM repos WHERE name = ?`,
      [name],
    );
    return repoRow?.path ? { name, path: repoRow.path } : undefined;
  }

  const repos = db.all<{ name: string; path: string }>(
    `SELECT name, path FROM repos`,
  );
  return repos.length === 1 ? { name: repos[0].name, path: repos[0].path } : undefined;
}
