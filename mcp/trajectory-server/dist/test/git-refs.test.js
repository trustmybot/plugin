// resolveCutBase (GH 1713): the ref task_provision cuts from, against temp
// repos with a bare origin — local ahead, equal, behind, diverged, remoteless.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCutBase } from '../utils/git-refs.js';
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(repo, name) {
    writeFileSync(join(repo, name), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
}
// A clone of a bare origin with `dev` pushed at one seed commit.
function withRepo(fn, opts = {}) {
    const root = mkdtempSync(join(tmpdir(), 'git-refs-'));
    try {
        const repo = join(root, 'work');
        git(root, 'init', '-q', '-b', 'dev', repo);
        git(repo, 'config', 'user.email', 't@t.t');
        git(repo, 'config', 'user.name', 't');
        commit(repo, 'seed.txt');
        if (opts.remote !== false) {
            const origin = join(root, 'origin.git');
            git(root, 'init', '-q', '--bare', origin);
            git(repo, 'remote', 'add', 'origin', origin);
            git(repo, 'push', '-q', 'origin', 'dev');
        }
        fn(repo, root);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}
describe('resolveCutBase (GH 1713)', () => {
    it('local dev ahead of origin/dev: cuts from local dev', () => {
        withRepo((repo) => {
            commit(repo, 'unpushed.txt');
            assert.deepEqual(resolveCutBase(repo, 'dev'), { ref: 'dev' });
        });
    });
    it('local dev equal to origin/dev: cuts from origin/dev', () => {
        withRepo((repo) => {
            assert.deepEqual(resolveCutBase(repo, 'dev'), { ref: 'origin/dev' });
        });
    });
    it('local dev behind origin/dev: cuts from origin/dev', () => {
        withRepo((repo) => {
            const seed = git(repo, 'rev-parse', 'HEAD');
            commit(repo, 'pushed.txt');
            git(repo, 'push', '-q', 'origin', 'dev');
            git(repo, 'reset', '-q', '--hard', seed);
            assert.deepEqual(resolveCutBase(repo, 'dev'), { ref: 'origin/dev' });
        });
    });
    it('diverged: cuts from origin/dev and reports both SHAs with ahead and behind > 0', () => {
        withRepo((repo) => {
            const seed = git(repo, 'rev-parse', 'HEAD');
            const remoteSha = commit(repo, 'pushed.txt');
            git(repo, 'push', '-q', 'origin', 'dev');
            git(repo, 'reset', '-q', '--hard', seed);
            commit(repo, 'local-a.txt');
            const localSha = commit(repo, 'local-b.txt');
            const res = resolveCutBase(repo, 'dev');
            assert.equal(res?.ref, 'origin/dev');
            assert.deepEqual(res?.diverged, { local_sha: localSha, remote_sha: remoteSha, ahead: 2, behind: 1 });
        });
    });
    it('remoteless repo: cuts from local dev', () => {
        withRepo((repo) => {
            assert.deepEqual(resolveCutBase(repo, 'dev'), { ref: 'dev' });
        }, { remote: false });
    });
    it('only origin/dev exists: cuts from origin/dev; neither side: null', () => {
        withRepo((repo) => {
            git(repo, 'checkout', '-q', '-b', 'other');
            git(repo, 'branch', '-q', '-D', 'dev');
            assert.deepEqual(resolveCutBase(repo, 'dev'), { ref: 'origin/dev' });
            assert.equal(resolveCutBase(repo, 'nope'), null);
        });
    });
});
//# sourceMappingURL=git-refs.test.js.map