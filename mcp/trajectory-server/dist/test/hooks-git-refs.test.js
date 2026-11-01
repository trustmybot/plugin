/**
 * The hooks' async base-ref helpers (GH 1692 R-async A2a): they answer as the
 * sync twins in utils/git-refs.ts on a table of fixture repos, nothing under
 * src/hooks imports the sync module, and attribution-footer's forge call takes
 * the gate's deadline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributionFooter } from '../hooks/attribution-footer.js';
import { ALLOW } from '../hooks/gate.js';
import { runWithDeadline } from '../hooks/lib/deadline.js';
import { runWithGitMemo } from '../hooks/lib/git.js';
import * as asyncRefs from '../hooks/lib/git-refs.js';
import * as syncRefs from '../utils/git-refs.js';
const HOOKS_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'hooks');
const CUT_MS = 2_000;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function newRepo(root, branch) {
    const repo = join(root, 'work');
    git(root, 'init', '-q', '-b', branch, repo);
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
    return repo;
}
function withOrigin(root, repo, ...branches) {
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', ...branches);
}
const FIXTURES = [
    {
        name: 'origin ref present',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'branch', 'release');
            withOrigin(root, repo, 'release');
            return repo;
        },
        base: { raw: 'release', normalized: 'release', ref: 'origin/release' },
        defaultBranch: 'feature',
    },
    {
        name: 'origin ref present, base given as origin/<x>',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'branch', 'release');
            withOrigin(root, repo, 'release');
            return repo;
        },
        base: { raw: 'origin/release', normalized: 'release', ref: 'origin/release' },
        defaultBranch: 'feature',
    },
    {
        name: 'local only',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'branch', 'stacked');
            return repo;
        },
        base: { raw: 'stacked', normalized: 'stacked', ref: 'stacked' },
        defaultBranch: 'feature',
    },
    {
        name: 'neither',
        build: (root) => newRepo(root, 'feature'),
        base: { raw: 'no-such-branch', normalized: 'no-such-branch', ref: null },
        defaultBranch: 'feature',
    },
    {
        name: 'neither, base given as origin/<x>',
        build: (root) => newRepo(root, 'feature'),
        base: { raw: 'origin/no-such-branch', normalized: 'no-such-branch', ref: null },
        defaultBranch: 'feature',
    },
    {
        name: 'a local branch literally called origin/<x>',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'branch', 'origin/literal');
            return repo;
        },
        base: { raw: 'origin/literal', normalized: 'origin/literal', ref: 'origin/literal' },
        defaultBranch: 'feature',
    },
    {
        name: 'origin/HEAD set',
        build: (root) => {
            const repo = newRepo(root, 'main');
            git(repo, 'branch', 'trunk');
            withOrigin(root, repo, 'trunk');
            git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
            return repo;
        },
        base: { raw: 'trunk', normalized: 'trunk', ref: 'origin/trunk' },
        defaultBranch: 'trunk',
    },
    {
        name: 'no origin/HEAD, main exists',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            for (const branch of ['main', 'master', 'dev'])
                git(repo, 'branch', branch);
            return repo;
        },
        base: { raw: 'main', normalized: 'main', ref: 'main' },
        defaultBranch: 'main',
    },
    {
        name: 'no origin/HEAD, master exists',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            for (const branch of ['master', 'dev'])
                git(repo, 'branch', branch);
            return repo;
        },
        base: { raw: 'master', normalized: 'master', ref: 'master' },
        defaultBranch: 'master',
    },
    {
        name: 'no origin/HEAD, dev exists',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'branch', 'dev');
            return repo;
        },
        base: { raw: 'dev', normalized: 'dev', ref: 'dev' },
        defaultBranch: 'dev',
    },
    {
        name: 'detached',
        build: (root) => {
            const repo = newRepo(root, 'feature');
            git(repo, 'checkout', '-q', '--detach');
            return repo;
        },
        base: { raw: 'feature', normalized: 'feature', ref: 'feature' },
        defaultBranch: 'main',
    },
];
describe('async base-ref helpers agree with the sync twins', () => {
    for (const fixture of FIXTURES) {
        it(fixture.name, async () => {
            const root = mkdtempSync(join(tmpdir(), 'tmb-hook-refs-'));
            try {
                const repo = fixture.build(root);
                const { raw, normalized, ref } = fixture.base;
                const env = process.env;
                const answers = async () => [
                    await asyncRefs.normalizeBase(repo, raw, env),
                    await asyncRefs.resolveBaseRef(repo, raw, env),
                    await asyncRefs.resolveRepoDefaultBranch(repo, env),
                ];
                const expected = [normalized, ref, fixture.defaultBranch];
                assert.deepEqual([syncRefs.normalizeBase(repo, raw), syncRefs.resolveBaseRef(repo, raw), syncRefs.resolveRepoDefaultBranch(repo)], expected);
                assert.deepEqual(await answers(), expected);
                assert.deepEqual(await runWithGitMemo(env, answers), expected);
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
describe('the hooks import graph', () => {
    it('nothing under src/hooks imports utils/git-refs', () => {
        const importers = readdirSync(HOOKS_SRC, { recursive: true, encoding: 'utf8' })
            .filter((file) => file.endsWith('.ts'))
            .filter((file) => readFileSync(join(HOOKS_SRC, file), 'utf8').includes('utils/git-refs'));
        assert.deepEqual(importers, []);
    });
});
describe('attribution-footer under a deadline', () => {
    it("a hung gh is killed at the gate's deadline, which marks the scope expired, and nothing is written", async () => {
        const root = mkdtempSync(join(tmpdir(), 'tmb-footer-deadline-'));
        try {
            const bin = join(root, 'bin');
            mkdirSync(bin);
            const log = join(root, 'gh.log');
            writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\nexec sleep 30\n`);
            chmodSync(join(bin, 'gh'), 0o755);
            const payload = JSON.stringify({
                tool_name: 'Bash',
                cwd: root,
                tool_input: { command: 'gh pr create --fill' },
                tool_response: 'https://github.com/o/r/pull/7',
            });
            const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
            const { value, expired } = await runWithDeadline(performance.now() + CUT_MS, () => attributionFooter(payload, env));
            assert.deepEqual(value, ALLOW);
            assert.equal(expired, true);
            const calls = readFileSync(log, 'utf8').trim().split('\n');
            assert.deepEqual(calls, ['pr view 7 --json body -q .body']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=hooks-git-refs.test.js.map