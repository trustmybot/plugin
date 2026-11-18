import { normalizeBase, resolveRepoDefaultBranch } from './git-refs.js';
import { resolveRefCommit } from './git-objects.js';
function configuredBranchOf(db, repo) {
    try {
        return db.get(`SELECT target_branch FROM repos WHERE name = ?`, [repo])?.target_branch ?? null;
    }
    catch {
        return null;
    }
}
export function targetBranchFor(repoPath, configured) {
    return normalizeBase(repoPath, configured || resolveRepoDefaultBranch(repoPath));
}
export function targetBranchOf(db, repo, repoPath) {
    return targetBranchFor(repoPath, configuredBranchOf(db, repo));
}
// TMB_WM_INDEX_TARGET pins the target to one ref (a test that indexes its own
// checkout sets HEAD, so the index matches the dist/ it built). ref is the
// name the commit was resolved from: the pinned ref, origin/<branch> or HEAD.
export function resolveIndexTargetRef(db, repo, repoPath) {
    return resolveIndexTarget(repoPath, () => configuredBranchOf(db, repo));
}
// resolveIndexTargetRef with the configured target branch read by the caller,
// for the hooks, which reach the DB through sqlite3 rather than TrajectoryDB.
export function resolveIndexTarget(repoPath, configured) {
    const pinned = process.env['TMB_WM_INDEX_TARGET'];
    if (pinned) {
        const commit = resolveRefCommit(repoPath, pinned);
        return commit ? { ref: pinned, commit } : null;
    }
    const branch = targetBranchFor(repoPath, configured());
    const remote = resolveRefCommit(repoPath, `refs/remotes/origin/${branch}`);
    if (remote)
        return { ref: `origin/${branch}`, commit: remote };
    const head = resolveRefCommit(repoPath, 'HEAD');
    return head ? { ref: 'HEAD', commit: head } : null;
}
//# sourceMappingURL=index-target.js.map