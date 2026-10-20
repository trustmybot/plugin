import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRepoDefaultBranch } from '../tools/repos.js';
function git(dir, ...args) {
    const res = spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}
function makeRepo(initialBranch) {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-defbranch-'));
    git(dir, 'init', '-b', initialBranch);
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'commit', '--allow-empty', '-m', 'init');
    return dir;
}
describe('resolveRepoDefaultBranch', () => {
    it('returns the branch origin/HEAD points at', () => {
        const origin = makeRepo('trunk');
        const clone = mkdtempSync(join(tmpdir(), 'tmb-defbranch-clone-'));
        try {
            const res = spawnSync('git', ['clone', origin, clone], { stdio: 'pipe' });
            assert.equal(res.status, 0);
            git(clone, 'checkout', '-b', 'feature');
            assert.equal(resolveRepoDefaultBranch(clone), 'trunk');
        }
        finally {
            rmSync(origin, { recursive: true, force: true });
            rmSync(clone, { recursive: true, force: true });
        }
    });
    it('returns master for a remoteless repo whose only candidate is master', () => {
        const dir = makeRepo('master');
        try {
            assert.equal(resolveRepoDefaultBranch(dir), 'master');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('falls back to the checked-out branch when no conventional branch exists', () => {
        const dir = makeRepo('trunk');
        try {
            assert.equal(resolveRepoDefaultBranch(dir), 'trunk');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('returns main for a directory that is not a git repo', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-defbranch-nogit-'));
        try {
            assert.equal(resolveRepoDefaultBranch(dir), 'main');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=repo-default-branch.test.js.map