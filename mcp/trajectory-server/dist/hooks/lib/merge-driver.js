/**
 * The tmb-regen git merge driver, installed into one repo's own config
 * (.git/config, shared by its worktrees), never --global (GH 1692). The
 * WorktreeCreate gate calls installMergeDriver in-process; maintainers run
 * `node mcp/trajectory-server/dist/hooks.js install-merge-driver [repo-dir]`
 * (default: the main checkout of the plugin holding the bundle, never the cwd).
 *
 * .gitattributes routes the generated artefacts (mcp/trajectory-server/dist/**,
 * scripts/hooks/lib/audit-events.txt, scripts/hooks/lib/data-contracts.json)
 * to merge=tmb-regen. On a merge, rebase or cherry-pick that touches them on
 * both sides, the driver keeps ours (%A already holds it, so the result is %A
 * unchanged), exits 0 and names the file on stderr; one regen-generated.ts run
 * then rebuilds every artefact from the merged sources. Idempotent.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installRoot, posixDirname } from './project-env.js';
export const MERGE_DRIVER_CLI = 'install-merge-driver';
export const MERGE_DRIVER_NAME = 'TMB generated artefact: keep ours, regenerate after the merge';
export const MERGE_DRIVER_COMMAND = `sh -c 'echo "tmb-regen: kept ours for $1 — run: node --experimental-strip-types scripts/maintenance/regen-generated.ts" >&2' tmb-regen %P`;
function git(repo, args, env) {
    const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: !r.error && r.status === 0, stdout: (r.stdout ?? '').replace(/\n+$/, '') };
}
/** Writes merge.tmb-regen.{name,driver} into <repo>'s local config; the config file's path, or null when <repo> is no git repository or a write fails. */
export function installMergeDriver(repo, env = process.env) {
    if (!git(repo, ['rev-parse', '--git-dir'], env).ok)
        return null;
    if (!git(repo, ['config', '--local', 'merge.tmb-regen.name', MERGE_DRIVER_NAME], env).ok)
        return null;
    if (!git(repo, ['config', '--local', 'merge.tmb-regen.driver', MERGE_DRIVER_COMMAND], env).ok)
        return null;
    const absolute = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    const common = absolute.ok ? absolute.stdout : git(repo, ['rev-parse', '--git-common-dir'], env).stdout;
    return `${common}/config`;
}
/** `install-merge-driver [repo-dir]`: the exit code; one stdout line on success, one stderr line on failure. */
export function mergeDriverCli(args, env, out, err) {
    let repo = args[0] ?? '';
    if (repo === '') {
        const self = installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? posixDirname(fileURLToPath(import.meta.url));
        const common = git(self, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
        if (!common.ok || common.stdout === '') {
            err(`install-merge-driver: ${self} is not in a git repository; pass the repo dir\n`);
            return 1;
        }
        repo = posixDirname(common.stdout);
    }
    if (!git(repo, ['rev-parse', '--git-dir'], env).ok) {
        err(`install-merge-driver: ${repo} is not a git repository\n`);
        return 1;
    }
    const config = installMergeDriver(repo, env);
    if (config === null)
        return 1;
    out(`install-merge-driver: merge.tmb-regen installed in ${config}\n`);
    return 0;
}
//# sourceMappingURL=merge-driver.js.map