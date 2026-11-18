/**
 * `cli.js prepush-uninstall [--repo <path>]` (GH 3281 slice 2): removes TMB's
 * pre-push hook, the repo-local `hook.tmb` config section and the
 * `<git-common-dir>/tmb/` script, from the repo at <path>, or by default from
 * the project's repo and every registered repo. Idempotent: a repo with
 * nothing to remove is reported and exits 0. Exit 2 on a usage error, 1 when
 * --repo names no git repo or a removal fails.
 */
import { candidateDirs } from '../hooks/ensure-gitignore.js';
import { isDir } from '../hooks/lib/git.js';
import { gitCommonDir, uninstallPrepushHook } from '../hooks/lib/prepush-hook.js';
const USAGE = 'usage: cli.js prepush-uninstall [--repo <path>]\n';
function parseArgs(argv) {
    if (argv.length === 0)
        return { repo: null };
    if (argv.length === 2 && argv[0] === '--repo' && argv[1] !== '')
        return { repo: argv[1] };
    if (argv.length === 1 && argv[0].startsWith('--repo=') && argv[0].length > '--repo='.length)
        return { repo: argv[0].slice('--repo='.length) };
    return null;
}
export async function prepushUninstall(argv, env, io) {
    const args = parseArgs(argv);
    if (args === null) {
        io.err(USAGE);
        return 2;
    }
    const dirs = args.repo === null ? candidateDirs(env) : [args.repo];
    const seen = new Set();
    let code = 0;
    for (const dir of dirs) {
        const commonDir = isDir(dir) ? await gitCommonDir(dir, env) : '';
        if (commonDir === '') {
            if (args.repo !== null) {
                io.err(`prepush-uninstall: ${dir} is not a git repository\n`);
                code = 1;
            }
            continue;
        }
        if (seen.has(commonDir))
            continue;
        seen.add(commonDir);
        try {
            const removed = await uninstallPrepushHook(dir, commonDir, env);
            io.out(removed ? `removed TMB's pre-push hook from ${dir}\n` : `no TMB pre-push hook in ${dir}\n`);
        }
        catch (error) {
            io.err(`prepush-uninstall: ${dir}: ${error.message}\n`);
            code = 1;
        }
    }
    return code;
}
//# sourceMappingURL=prepush-uninstall.js.map