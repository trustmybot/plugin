/**
 * The hooks' async twins of the sync base-ref resolvers under src/utils (GH 1692
 * R-async, decision 937), which stay sync for the MCP tools: the same answers over
 * gitSpawn, so a base-ref lookup on a gate's path never blocks the event loop. They
 * take the gate's env and no timeout of their own, since the gate's deadline
 * bounds them.
 */
import { gitOk, gitRun } from './git.js';
async function refResolves(repoPath, ref, env) {
    return await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', ref], env);
}
async function gitOutput(repoPath, args, env) {
    const r = await gitRun(repoPath, args, env);
    if (r.code !== 0)
        return null;
    return r.stdout.trim() || null;
}
/** A base passed as 'origin/<branch>' names <branch>, unless a local branch is literally called 'origin/<branch>'. */
export async function normalizeBase(repoPath, base, env) {
    if (!base.startsWith('origin/') || await refResolves(repoPath, `refs/heads/${base}`, env))
        return base;
    return base.slice('origin/'.length);
}
/** `origin/<base>` when it resolves, else the local `<base>`, else null. */
export async function resolveBaseRef(repoPath, rawBase, env) {
    const base = await normalizeBase(repoPath, rawBase, env);
    if (await refResolves(repoPath, `origin/${base}`, env))
        return `origin/${base}`;
    if (await refResolves(repoPath, `refs/heads/${base}`, env))
        return base;
    return null;
}
/** origin/HEAD, else the first of main/master/dev that exists locally, else the checked-out branch, else 'main'. */
export async function resolveRepoDefaultBranch(repoPath, env) {
    const originHead = await gitOutput(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env);
    if (originHead)
        return originHead.replace(/^origin\//, '');
    for (const candidate of ['main', 'master', 'dev']) {
        if (await refResolves(repoPath, `refs/heads/${candidate}`, env))
            return candidate;
    }
    return await gitOutput(repoPath, ['symbolic-ref', '--short', 'HEAD'], env) ?? 'main';
}
//# sourceMappingURL=git-refs.js.map