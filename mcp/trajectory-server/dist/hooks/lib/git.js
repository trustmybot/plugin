/**
 * `git -C <dir> <args>` for the hook gates (GH 1692): argv only, never a shell
 * string, stderr dropped as the .sh's `2>/dev/null` does. Under the router the
 * child is killed at the running gate's deadline (decisions 922 and 937);
 * outside it, as the .sh runs git, with no timeout of its own.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { deadlineSignal, noteSpawn, spawnLimit } from './deadline.js';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
function codedError(message, code) {
    return Object.assign(new Error(message), { code });
}
/** A stream's bytes up to GIT_MAX_BUFFER; `over` turns true past it, where the output is truncated and the run fails. */
function collector() {
    const chunks = [];
    let size = 0;
    return {
        add(chunk) {
            if (size <= GIT_MAX_BUFFER)
                chunks.push(chunk.subarray(0, GIT_MAX_BUFFER - size + 1));
            size += chunk.length;
        },
        bytes: () => Buffer.concat(chunks).subarray(0, GIT_MAX_BUFFER),
        over: () => size > GIT_MAX_BUFFER,
    };
}
/**
 * The one spawn of git. Code -1 when it failed to start, was cut off or passed
 * GIT_MAX_BUFFER, with what it printed before that. Past the deadline it never
 * starts. A cut drops the output pipes, so a child's own child holding one open
 * cannot keep the run from settling.
 */
export async function gitSpawn(dir, args, options = {}) {
    const { env = process.env, input = '', stderr = 'ignore', timeoutMs } = options;
    const limit = spawnLimit(timeoutMs);
    const signal = limit === null ? undefined : limit.byDeadline ? deadlineSignal() : AbortSignal.timeout(limit.timeout);
    const timedOut = () => codedError(`git ${args[0] ?? ''} timed out`, 'ETIMEDOUT');
    if (signal?.aborted) {
        const error = timedOut();
        noteSpawn(limit, { error, signal: null });
        return { code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
    }
    return new Promise((resolve) => {
        const child = spawn('git', ['-C', dir, ...args], { env, stdio: ['pipe', 'pipe', stderr], signal });
        const out = collector();
        const err = collector();
        let cut;
        let done = false;
        const dropOutput = () => {
            child.stdout?.destroy();
            child.stderr?.destroy();
        };
        const finish = (code, killedBy, failure) => {
            if (done)
                return;
            done = true;
            const overflow = out.over() || err.over() ? codedError(`git ${args[0] ?? ''} passed its output limit`, 'ENOBUFS') : undefined;
            const error = failure ?? cut ?? overflow;
            noteSpawn(limit, { error, signal: killedBy });
            resolve({ code: error || code === null ? -1 : code, stdout: out.bytes(), stderr: err.bytes(), error });
        };
        const take = (into, chunk) => {
            into.add(chunk);
            if (!into.over())
                return;
            dropOutput();
            child.kill();
        };
        for (const stream of [child.stdin, child.stdout, child.stderr])
            stream?.on('error', () => undefined);
        child.stdout?.on('data', (chunk) => take(out, chunk));
        child.stderr?.on('data', (chunk) => take(err, chunk));
        child.on('error', (failure) => {
            if (failure.name !== 'AbortError') {
                finish(null, null, failure);
                return;
            }
            cut = timedOut();
            dropOutput();
        });
        child.on('close', (code, killedBy) => finish(code, killedBy));
        child.stdin?.end(input);
    });
}
export async function gitRun(dir, args, env = process.env, input = '', stderr = 'ignore') {
    const r = await gitSpawn(dir, args, { env, input, stderr });
    return { code: r.code, stdout: r.stdout.toString('utf8') };
}
/** `$(git -C <dir> <args> 2>/dev/null)`: stdout minus its trailing newlines, whatever the exit code. */
export async function gitOut(dir, args, env = process.env, input = '') {
    return (await gitRun(dir, args, env, input)).stdout.replace(/\n+$/, '');
}
/** `git -C <dir> <args>` succeeded; `stderr: 'inherit'` for a call the .sh leaves unsilenced. */
export async function gitOk(dir, args, env = process.env, stderr = 'ignore') {
    return (await gitRun(dir, args, env, '', stderr)).code === 0;
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