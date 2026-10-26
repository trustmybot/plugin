// Untracked node_modules installs never reach a fresh git worktree (GH 1541,
// GH 1853): link the main checkout's install beside each tracked package.json.
// Shared by ensureTaskWorktree and skills/tmb_planning/scripts/integrate.sh,
// which runs `node dist/utils/worktree-deps.js <repoRoot> <worktreePath>`.
import { execFileSync } from 'node:child_process';
import { lstatSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function pathPresent(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function trackedPackageDirs(worktreePath) {
    const out = execFileSync('git', ['-C', worktreePath, 'ls-files', '-z', '--', 'package.json', '*/package.json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SUBPROCESS_TIMEOUT_MS,
    }).toString();
    return [...new Set(out.split('\0').filter(Boolean).map((p) => dirname(p)))];
}
export function linkWorktreeNodeModules(repoRoot, worktreePath) {
    const result = { linked: [], skipped: [] };
    let dirs;
    try {
        dirs = trackedPackageDirs(worktreePath);
    }
    catch (error) {
        result.skipped.push({ dir: '.', reason: `git ls-files failed: ${error.message}` });
        return result;
    }
    for (const dir of dirs) {
        const src = join(repoRoot, dir, 'node_modules');
        const dest = join(worktreePath, dir, 'node_modules');
        if (!isDirectory(src)) {
            result.skipped.push({ dir, reason: `no install at ${src}` });
            continue;
        }
        if (pathPresent(dest)) {
            result.skipped.push({ dir, reason: `${dest} already exists` });
            continue;
        }
        try {
            symlinkSync(src, dest);
            result.linked.push(dir);
        }
        catch (error) {
            result.skipped.push({ dir, reason: `could not link ${src}: ${error.message}` });
        }
    }
    return result;
}
// The basename check keeps the guard off inside esbuild bundles (dist/index.js,
// dist/hooks.js), where import.meta.url is the bundle's own entry point.
function isMainModule() {
    const entry = process.argv[1];
    const self = fileURLToPath(import.meta.url);
    return entry !== undefined && basename(self) === 'worktree-deps.js' && resolve(entry) === self;
}
if (isMainModule()) {
    const [repoRoot, worktreePath] = process.argv.slice(2);
    if (!repoRoot || !worktreePath) {
        process.stderr.write('usage: node worktree-deps.js <repoRoot> <worktreePath>\n');
    }
    else {
        for (const s of linkWorktreeNodeModules(repoRoot, worktreePath).skipped) {
            process.stderr.write(`worktree-deps: ${s.dir}: ${s.reason}\n`);
        }
    }
    process.exit(0);
}
//# sourceMappingURL=worktree-deps.js.map