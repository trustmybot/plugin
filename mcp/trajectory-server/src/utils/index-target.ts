// The commit a repo's world model is indexed at (GH 2584): origin/<target
// branch> as of the last fetch, else HEAD when that ref is missing. Never
// fetches.
import type { TrajectoryDB } from '../db.js';
import { normalizeBase, resolveRepoDefaultBranch } from './git-refs.js';
import { resolveRefCommit } from './git-objects.js';

function configuredBranchOf(db: TrajectoryDB, repo: string): string | null {
  try {
    return db.get<{ target_branch: string | null }>(`SELECT target_branch FROM repos WHERE name = ?`, [repo])?.target_branch ?? null;
  } catch {
    return null;
  }
}

export function targetBranchFor(repoPath: string, configured: string | null): string {
  return normalizeBase(repoPath, configured || resolveRepoDefaultBranch(repoPath));
}

export function targetBranchOf(db: TrajectoryDB, repo: string, repoPath: string): string {
  return targetBranchFor(repoPath, configuredBranchOf(db, repo));
}

export interface IndexTarget {
  ref: string;
  commit: string;
}

// TMB_WM_INDEX_TARGET pins the target to one ref (a test that indexes its own
// checkout sets HEAD, so the index matches the dist/ it built). ref is the
// name the commit was resolved from: the pinned ref, origin/<branch> or HEAD.
export function resolveIndexTargetRef(db: TrajectoryDB, repo: string, repoPath: string): IndexTarget | null {
  return resolveIndexTarget(repoPath, () => configuredBranchOf(db, repo));
}

// resolveIndexTargetRef with the configured target branch read by the caller,
// for the hooks, which reach the DB through sqlite3 rather than TrajectoryDB.
export function resolveIndexTarget(repoPath: string, configured: () => string | null): IndexTarget | null {
  const pinned = process.env['TMB_WM_INDEX_TARGET'];
  if (pinned) {
    const commit = resolveRefCommit(repoPath, pinned);
    return commit ? { ref: pinned, commit } : null;
  }
  const branch = targetBranchFor(repoPath, configured());
  const remote = resolveRefCommit(repoPath, `refs/remotes/origin/${branch}`);
  if (remote) return { ref: `origin/${branch}`, commit: remote };
  const head = resolveRefCommit(repoPath, 'HEAD');
  return head ? { ref: 'HEAD', commit: head } : null;
}
