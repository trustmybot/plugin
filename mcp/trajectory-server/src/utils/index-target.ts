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

export interface IndexTarget {
  ref: string;
  commit: string;
}

// TMB_WM_INDEX_TARGET pins the target to one ref (a test that indexes its own
// checkout sets HEAD, so the index matches the dist/ it built). ref is the
// name the commit was resolved from: the pinned ref, origin/<branch> or HEAD.
export function resolveIndexTargetRef(db: TrajectoryDB, repo: string, repoPath: string): IndexTarget | null {
  const pinned = process.env['TMB_WM_INDEX_TARGET'];
  if (pinned) {
    const commit = resolveRefCommit(repoPath, pinned);
    return commit ? { ref: pinned, commit } : null;
  }
  const branch = targetBranchOf(db, repo, repoPath);
  const remote = resolveRefCommit(repoPath, `refs/remotes/origin/${branch}`);
  if (remote) return { ref: `origin/${branch}`, commit: remote };
  const head = resolveRefCommit(repoPath, 'HEAD');
  return head ? { ref: 'HEAD', commit: head } : null;
}
