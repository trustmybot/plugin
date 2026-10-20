import { execFileSync, spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';
function refResolves(repoPath, ref) {
    try {
        execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SUBPROCESS_TIMEOUT_MS,
        });
        return true;
    }
    catch {
        return false;
    }
}
// Resolve a base branch name to a concrete git ref, preferring the freshest
// remote-tracking ref. Returns `origin/<base>` when it resolves (remote-present
// repos — freshest-origin doctrine unchanged), else the local `<base>` when
// refs/heads/<base> resolves (remoteless repos: L6 sandboxes, fresh local
// projects, local-only stacked bases), else null when neither exists.
export function resolveBaseRef(repoPath, base) {
    if (refResolves(repoPath, `origin/${base}`))
        return `origin/${base}`;
    if (refResolves(repoPath, `refs/heads/${base}`))
        return base;
    return null;
}
export function branchRefExists(repoPath, branch) {
    return refResolves(repoPath, `refs/heads/${branch}`) || refResolves(repoPath, `refs/remotes/origin/${branch}`);
}
function gitOut(repoPath, args) {
    const res = spawnSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0)
        return null;
    const out = res.stdout.trim();
    return out.length > 0 ? out : null;
}
// Twin of the hooks' tmb_repo_default_branch: origin/HEAD, else the first of
// main/master/dev that exists locally, else the checked-out branch, else 'main'.
export function resolveRepoDefaultBranch(repoPath) {
    const originHead = gitOut(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (originHead)
        return originHead.replace(/^origin\//, '');
    for (const candidate of ['main', 'master', 'dev']) {
        if (refResolves(repoPath, `refs/heads/${candidate}`))
            return candidate;
    }
    return gitOut(repoPath, ['symbolic-ref', '--short', 'HEAD']) ?? 'main';
}
//# sourceMappingURL=git-refs.js.map