import type { TrajectoryDB } from '../db.js';

export function resolveSoleRepoPath(db: TrajectoryDB): string | undefined {
  return resolveSoleRepo(db)?.path;
}

export interface ResolvedRepoSync {
  name: string;
  path: string;
}

// Issue-scoped repo resolution for the sync path (#155/#146). Resolve the repo
// an issue belongs to, returning its name and on-disk path. The sync caller
// uses `path` as the explicit cwd and reads the repo's remotes through
// repoRemotes(db, name) to pick the gh --repo / glab -R target — never
// process.cwd().
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
  if (repoName) {
    const row = db.get<{ name: string; path: string }>(`SELECT name, path FROM repos WHERE name = ?`, [repoName]);
    return row ? { name: row.name, path: row.path } : null;
  }

  const rows = db.all<{ name: string; path: string }>(`SELECT name, path FROM repos`);
  if (rows.length !== 1) return null;
  return { name: rows[0]!.name, path: rows[0]!.path };
}

// Path-keyed repo resolution. There is no name-keyed global default — callers
// needing a specific repo pass `tasks.repo` (resolved via `repos.path`). The
// only implicit resolution is the sole-repo fallback: when exactly one repo
// is registered, that repo resolves implicitly. Multi-repo with no explicit
// selector returns undefined and the caller decides.
export function resolveSoleRepo(
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
