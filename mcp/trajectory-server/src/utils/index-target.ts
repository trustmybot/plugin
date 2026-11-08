// The commit a repo's world model is indexed at (GH 2584): origin/<target
// branch> as of the last fetch, else HEAD when that ref is missing. Never
// fetches.
import type { TrajectoryDB } from '../db.js';
import { normalizeBase, resolveRepoDefaultBranch } from './git-refs.js';
import { revParseCommit } from './git-objects.js';

export function targetBranchOf(db: TrajectoryDB, repo: string, repoPath: string): string {
  let configured: string | null = null;
  try {
    configured = db.get<{ target_branch: string | null }>(`SELECT target_branch FROM repos WHERE name = ?`, [repo])?.target_branch ?? null;
  } catch {
    configured = null;
  }
  return normalizeBase(repoPath, configured || resolveRepoDefaultBranch(repoPath));
}

export function resolveIndexTarget(db: TrajectoryDB, repo: string, repoPath: string): string | null {
  const branch = targetBranchOf(db, repo, repoPath);
  return revParseCommit(repoPath, `refs/remotes/origin/${branch}`) ?? revParseCommit(repoPath, 'HEAD');
}
