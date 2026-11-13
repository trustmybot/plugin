import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';
const spawnGit = (args, options) => spawnSync('git', args, { ...options, cwd: options.cwd });
let runner = spawnGit;
export function runGit(repoPath, args, options = {}) {
    const dir = resolve(repoPath);
    return runner(['-C', dir, ...args], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        ...options,
        cwd: dir,
    });
}
// A timed-out, signalled or unspawnable git leaves error set or status null:
// git gave no answer, which is not the same as a non-zero "no".
export function gitUnanswered(res) {
    return !!res.error || res.status === null;
}
export function __setGitRunnerForTests(next = spawnGit) {
    runner = next;
}
//# sourceMappingURL=git-run.js.map