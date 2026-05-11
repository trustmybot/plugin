import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';

export function resolveDefaultRepoPath(
  db: TrajectoryDB,
  dbPath: string,
): string | undefined {
  if (!dbPath) return undefined;
  const row = db.get<{ value_json: string }>(
    `SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'`,
  );
  if (!row?.value_json) return undefined;
  let defaultRepo: unknown;
  try {
    defaultRepo = JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
  if (typeof defaultRepo !== 'string' || defaultRepo.length === 0) return undefined;

  // Prefer the absolute path recorded in `repos.path` — that's the
  // authoritative location regardless of workspace layout. Falls back
  // to the legacy workspace-join only when the repo isn't in the table.
  const repoRow = db.get<{ path: string }>(
    `SELECT path FROM repos WHERE name = ?`,
    [defaultRepo],
  );
  if (repoRow?.path) return repoRow.path;

  // Legacy fallback: synthesize the path from the workspace root + repo
  // name. Works for workspace-pattern projects
  // (`<workspace>/<repo>/.claude/tmb/trajectory.db`) but mis-resolves
  // single-repo projects where trajectory.db lives at the project root
  // (synthesized path becomes `<root>/<basename(root)>` which doesn't
  // exist on disk — that mis-resolution is what motivated reading
  // `repos.path` first).
  const workspaceRoot = dirname(dirname(dirname(dbPath)));
  return join(workspaceRoot, defaultRepo);
}
