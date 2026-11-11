import { dirname, isAbsolute, resolve } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { projectRootFromDbPath } from '../tools/containment.js';
import { normalizeBase, resolveRepoDefaultBranch } from './git-refs.js';

// A repos.path as an absolute directory: a relative path resolves against the
// project root (the directory holding .claude/<plugin>/trajectory.db). A DB
// outside that layout resolves against its own directory; `:memory:` against
// the server's working directory.
export function repoRowPath(db: TrajectoryDB, path: string): string {
  if (isAbsolute(path)) return path;
  const base =
    db.dbPath === ':memory:' ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname(db.dbPath);
  return resolve(base, path);
}

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
    return row ? { name: row.name, path: repoRowPath(db, row.path) } : null;
  }

  const rows = db.all<{ name: string; path: string }>(`SELECT name, path FROM repos`);
  if (rows.length !== 1) return null;
  return { name: rows[0]!.name, path: repoRowPath(db, rows[0]!.path) };
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
    return repoRow?.path ? { name, path: repoRowPath(db, repoRow.path) } : undefined;
  }

  const repos = db.all<{ name: string; path: string }>(
    `SELECT name, path FROM repos`,
  );
  return repos.length === 1 ? { name: repos[0].name, path: repoRowPath(db, repos[0].path) } : undefined;
}

// Read a repo's target_branch (pr_target) from the repos table — the sole
// source of truth (#980). Falls back to the sole registered repo when repoValue
// is empty. Returns null when no row or a NULL/empty column.
export function readRepoTargetBranch(db: TrajectoryDB, repoValue: string | null): string | null {
  const name = repoValue && repoValue.length > 0 ? repoValue : resolveSoleRepo(db)?.name ?? null;
  if (!name) return null;
  const row = db.get<{ target_branch: string | null }>(
    `SELECT target_branch FROM repos WHERE name = ?`,
    [name],
  );
  const v = row?.target_branch;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// The base branch a new task is cut from: an explicit base, else the repo's
// target branch, else its default branch.
export function repoTargetBase(db: TrajectoryDB, repoPath: string, repoValue: string | null, explicitBase?: string): string {
  return normalizeBase(repoPath, explicitBase ?? readRepoTargetBranch(db, repoValue) ?? resolveRepoDefaultBranch(repoPath));
}
