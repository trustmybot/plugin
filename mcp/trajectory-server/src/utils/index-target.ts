// The commit a repo's world model is indexed at (GH 2584): origin/<target
// branch> as of the last fetch, else HEAD when that ref is missing. Never
// fetches.
import type { TrajectoryDB } from '../db.js';
import { normalizeBase, resolveRepoDefaultBranch } from './git-refs.js';
import { resolveRefCommit } from './git-objects.js';

export function targetBranchOf(db: TrajectoryDB, repo: string, repoPath: string): string {
  let configured: string | null = null;
  try {
    configured = db.get<{ target_branch: string | null }>(`SELECT target_branch FROM repos WHERE name = ?`, [repo])?.target_branch ?? null;
  } catch {
    configured = null;
  }
  return normalizeBase(repoPath, configured || resolveRepoDefaultBranch(repoPath));
}

// TMB_WM_INDEX_TARGET pins the target to one ref (a test that indexes its own
// checkout sets HEAD, so the index matches the dist/ it built).
export function resolveIndexTarget(db: TrajectoryDB, repo: string, repoPath: string): string | null {
  const pinned = process.env['TMB_WM_INDEX_TARGET'];
  if (pinned) return resolveRefCommit(repoPath, pinned);
  const branch = targetBranchOf(db, repo, repoPath);
  return resolveRefCommit(repoPath, `refs/remotes/origin/${branch}`) ?? resolveRefCommit(repoPath, 'HEAD');
}
