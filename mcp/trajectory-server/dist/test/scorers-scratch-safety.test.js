// Failed fixture setup must never write or commit in the caller's checkout.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createScorerFixtures, fixtureOperations } from './lib/scorer-fixture.js';
import { scoreAll } from './lib/l5-scorers.js';
function runFixture(failure) {
    const owned = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scorers-safety-')));
    const outer = join(owned, 'caller');
    const scratch = join(owned, 'scratch');
    mkdirSync(outer);
    mkdirSync(scratch);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(owned, 'global-config') };
    writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    const git = (...args) => fixtureOperations.git(outer, args, env);
    const calls = [];
    try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'fixture@example.test');
        git('config', 'user.name', 'Fixture');
        writeFileSync(join(outer, 'README.md'), 'Caller checkout must stay unchanged.\n');
        writeFileSync(join(outer, 'staged.txt'), 'original\n');
        git('add', '.');
        git('commit', '-qm', 'caller sentinel');
        writeFileSync(join(outer, 'staged.txt'), 'staged change must survive\n');
        git('add', 'staged.txt');
        const snapshot = () => ({ readme: readFileSync(join(outer, 'README.md'), 'utf8'),
            head: git('rev-parse', 'HEAD'), index: git('write-tree'), status: git('status', '--porcelain=v1', '--untracked-files=all') });
        const before = snapshot();
        writeFileSync(join(scratch, 'keep.txt'), 'unowned sibling\n');
        let allocation = 0;
        const ops = {
            allocate(prefix) {
                const stage = ['root', 'project', 'flow'][allocation++] ?? 'later';
                calls.push(stage);
                if (failure === 'empty-root' && stage === 'root')
                    return '';
                if (failure === stage)
                    throw new Error(`forced ${stage} allocation failure`);
                return fixtureOperations.allocate(prefix);
            },
            git(project, args, isolatedEnv) {
                calls.push(`git-${args[0]}`);
                if (failure === `git-${args[0]}`)
                    throw new Error(`forced git ${args[0]} failure`);
                return fixtureOperations.git(project, args, isolatedEnv);
            },
            initializeDatabase(path) {
                calls.push('sqlite');
                if (failure === 'sqlite')
                    throw new Error('forced schema initialization failure');
                fixtureOperations.initializeDatabase(path);
            },
        };
        const attempt = () => {
            const fixtures = createScorerFixtures(scratch, ops);
            try {
                const fixture = fixtures.create();
                calls.push('scoring');
                assert.equal(scoreAll({ ...fixture, flow: 'test', runId: 'safe', stdout: () => { }, stderr: () => { } }), 0);
            }
            finally {
                fixtures.cleanup();
            }
        };
        if (failure === 'none')
            attempt();
        else
            assert.throws(attempt);
        assert.deepEqual(snapshot(), before, 'preserve caller README, HEAD and staged index');
        assert.equal(readFileSync(join(scratch, 'keep.txt'), 'utf8'), 'unowned sibling\n');
        assert.deepEqual(readdirSync(scratch), ['keep.txt'], 'remove only the owned root and its fixtures');
        return calls;
    }
    finally {
        rmSync(owned, { recursive: true, force: true });
    }
}
describe('scorer fixture setup fails closed (GH 2160)', () => {
    for (const failure of ['root', 'empty-root', 'project', 'flow', 'git-init', 'git-config', 'git-add', 'git-commit', 'sqlite']) {
        it(`stops on ${failure} failure without changing the caller checkout`, () => {
            const calls = runFixture(failure);
            assert.ok(!calls.includes('scoring'), 'no scorer runs after setup fails');
            if (['root', 'empty-root', 'project'].includes(failure))
                assert.ok(calls.every((call) => ['root', 'project'].includes(call)), 'no Git or database setup after allocation fails');
            else
                assert.equal(calls.at(-1), failure);
        });
    }
    it('runs every scorer after successful setup and cleans its owned fixtures', () => assert.equal(runFixture('none').at(-1), 'scoring'));
});
//# sourceMappingURL=scorers-scratch-safety.test.js.map