import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { spawnAsync } from './spawn-async.js';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';
const spawnGit = (args, options) => spawnSync('git', args, { ...options, cwd: options.cwd });
const spawnGitAsync = (args, options) => spawnAsync('git', args, { ...options, cwd: options.cwd });
let runner = spawnGit;
let asyncRunner = spawnGitAsync;
function gitOptions(dir, options) {
    return { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS, ...options, cwd: dir };
}
export function runGit(repoPath, args, options = {}) {
    const dir = resolve(repoPath);
    return runner(['-C', dir, ...args], gitOptions(dir, options));
}
// runGit for the server's long-running spawns (a network fetch, worktree add):
// the MCP server is one process for every lane, so these must not block it.
export function runGitAsync(repoPath, args, options = {}) {
    const dir = resolve(repoPath);
    return asyncRunner(['-C', dir, ...args], gitOptions(dir, options));
}
// A timed-out, signalled or unspawnable git leaves error set or status null:
// git gave no answer, which is not the same as a non-zero "no".
export function gitUnanswered(res) {
    return !!res.error || res.status === null;
}
function answeredAsync(syncRunner) {
    return (args, options) => new Promise((settle) => {
        const res = syncRunner(args, options);
        settle({
            status: gitUnanswered(res) ? null : res.status,
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            ...(res.error ? { error: res.error } : {}),
        });
    });
}
// A sync runner stands in for runGitAsync too, so one seam sees every git call.
export function __setGitRunnerForTests(next) {
    runner = next ?? spawnGit;
    asyncRunner = next ? answeredAsync(next) : spawnGitAsync;
}
export function __setGitAsyncRunnerForTests(next = spawnGitAsync) {
    asyncRunner = next;
}
//# sourceMappingURL=git-run.js.map