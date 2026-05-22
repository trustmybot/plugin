import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';

export function resolveDefaultRepoPath(
  db: TrajectoryDB,
  dbPath: string,
): string | undefined {
  return resolveDefaultRepo(db, dbPath)?.path;
}

export function resolveDefaultRepo(
  db: TrajectoryDB,
  dbPath: string,
): { name: string; path: string } | undefined {
  if (!dbPath) return undefined;
  const row = db.get<{ value_json: string }>(
    `SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'`,
  );

  // Single-repo fallback: when tmb_default_repo isn't set but the repos
  // table has exactly one entry, that entry IS the default. Covers L5
  // test scratch envs (no /scan ran) and single-repo projects before the
  // first /scan.
  const singleRepoFallback = (): { name: string; path: string } | undefined => {
    const repos = db.all<{ name: string; path: string }>(
      `SELECT name, path FROM repos`,
    );
    return repos.length === 1 ? { name: repos[0].name, path: repos[0].path } : undefined;
  };

  if (!row?.value_json) return singleRepoFallback();
  let defaultRepo: unknown;
  try {
    defaultRepo = JSON.parse(row.value_json);
  } catch {
    return singleRepoFallback();
  }
  if (typeof defaultRepo !== 'string' || defaultRepo.length === 0) return singleRepoFallback();

  // Prefer the absolute path recorded in `repos.path` — that's the
  // authoritative location regardless of workspace layout. Falls back
  // to the legacy workspace-join only when the repo isn't in the table.
  const repoRow = db.get<{ path: string }>(
    `SELECT path FROM repos WHERE name = ?`,
    [defaultRepo],
  );
  if (repoRow?.path) return { name: defaultRepo, path: repoRow.path };

  // Legacy fallback: synthesize the path from the workspace root + repo
  // name. Works for workspace-pattern projects
  // (`<workspace>/<repo>/.claude/<plugin-name>/trajectory.db`) but mis-resolves
  // single-repo projects where trajectory.db lives at the project root
  // (synthesized path becomes `<root>/<basename(root)>` which doesn't
  // exist on disk — that mis-resolution is what motivated reading
  // `repos.path` first).
  const workspaceRoot = dirname(dirname(dirname(dbPath)));
  return { name: defaultRepo, path: join(workspaceRoot, defaultRepo) };
}
