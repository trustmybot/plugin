import type { TrajectoryDB } from '../db.js';

export function resolveDefaultRepoPath(db: TrajectoryDB): string | undefined {
  return resolveDefaultRepo(db)?.path;
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
