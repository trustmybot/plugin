/**
 * `git -C <dir> <args>` for the hook gates (GH 1692): argv only, never a shell
 * string, stderr dropped as the .sh's `2>/dev/null` does. Under the router it
 * times out at the running gate's deadline (decision 922); outside it, as the
 * .sh runs git, with no timeout of its own.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { noteSpawn, spawnLimit, spawnOptions } from './deadline.js';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
export function gitRun(dir, args, env = process.env, input = '', stderr = 'ignore') {
    const limit = spawnLimit();
    const r = spawnSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env,
        input,
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ['pipe', 'pipe', stderr],
        ...spawnOptions(limit),
    });
    noteSpawn(limit, r);
    return { code: r.error ? -1 : (r.status ?? -1), stdout: r.stdout ?? '' };
}
/** `$(git -C <dir> <args> 2>/dev/null)`: stdout minus its trailing newlines, whatever the exit code. */
export function gitOut(dir, args, env = process.env, input = '') {
    return gitRun(dir, args, env, input).stdout.replace(/\n+$/, '');
}
/** `git -C <dir> <args>` succeeded; `stderr: 'inherit'` for a call the .sh leaves unsilenced. */
export function gitOk(dir, args, env = process.env, stderr = 'ignore') {
    return gitRun(dir, args, env, '', stderr).code === 0;
}
/** `[ -d <path> ]`. */
export function isDir(path) {
    if (path === '')
        return false;
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** The dir `(cd <path> && pwd)` prints: <path> made absolute with `.`, `..` and repeated slashes folded, or "" when it is no dir. */
export function cdPwd(path, pwd) {
    if (!isDir(path === '' ? '.' : path))
        return '';
    const abs = path.startsWith('/') ? path : `${pwd.replace(/\/$/, '')}/${path}`;
    const out = [];
    for (const part of abs.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..')
            out.pop();
        else
            out.push(part);
    }
    return `/${out.join('/')}`;
}
//# sourceMappingURL=git.js.map