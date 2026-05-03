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
  const workspaceRoot = dirname(dirname(dirname(dbPath)));
  return join(workspaceRoot, defaultRepo);
}
