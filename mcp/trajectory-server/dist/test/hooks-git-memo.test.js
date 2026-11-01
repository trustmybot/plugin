/**
 * The per-router-call git memo (GH 1692 R-async A2a, decision 937): an allowlisted
 * read runs one child however many gates ask, anything else clears the reads,
 * identical fetches share one run, and no waiter inherits another gate's cut.
 * Children are counted through a `git` on PATH that logs its argv.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW } from '../hooks/gate.js';
import { runWithDeadline } from '../hooks/lib/deadline.js';
import { gitOut, gitRun, gitSpawn, isProvablyReadOnly, runWithGitMemo } from '../hooks/lib/git.js';
import { decide } from '../hooks/router/decide.js';
const CUT_MS = 2_000;
const PLENTY_MS = 60_000;
const HTTP_FETCH = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', 'origin', 'dev', '--quiet'];
const HEAD = ['rev-parse', 'HEAD'];
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
const sh = (cwd, ...args) => execFileSync(realGit, ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let root;
let bin;
let log;
let repo;
let env;
/** Installs the `git` on PATH: it logs its argv, runs <beforeExec> and execs the real git. */
function installGit(beforeExec = '') {
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\n${beforeExec}\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
}
function children(word) {
    let text;
    try {
        text = readFileSync(log, 'utf8');
    }
    catch {
        return 0;
    }
    return text.split('\n').filter((line) => line.includes(word)).length;
}
function commit(dir, message) {
    sh(dir, 'commit', '-q', '--allow-empty', '-m', message);
    return sh(dir, 'rev-parse', 'HEAD');
}
before(() => {
    root = mkdtempSync(join(tmpdir(), 'tmb-git-memo-'));
    bin = join(root, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    log = join(root, 'children.log');
    repo = join(root, 'work');
    sh(root, 'init', '-q', '-b', 'dev', repo);
    sh(repo, 'config', 'user.email', 't@t.t');
    sh(repo, 'config', 'user.name', 't');
    commit(repo, 'seed');
    sh(root, 'init', '-q', '--bare', join(root, 'origin.git'));
    sh(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
    sh(repo, 'push', '-q', 'origin', 'dev');
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
});
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
    rmSync(log, { force: true });
    installGit();
});
describe('within one router call', () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
    async function routerCall(gateEnv, gate) {
        const decision = await decide('PreToolUse', payload, gateEnv, {
            groups: [
                {
                    event: 'PreToolUse',
                    matcher: 'Bash',
                    groupBudgetMs: PLENTY_MS,
                    gates: [
                        { name: 'one', kind: 'enforcement', budgetMs: PLENTY_MS },
                        { name: 'two', kind: 'enforcement', budgetMs: PLENTY_MS },
                    ],
                },
            ],
            findGate: () => gate,
        });
        assert.equal(decision.denied, null);
    }
    it('the same read runs one child across gates and concurrent asks, and the next call starts empty', async () => {
        const sha = sh(repo, 'rev-parse', 'HEAD');
        const gate = async (_payload, gateEnv) => {
            const [a, b] = await Promise.all([gitOut(repo, HEAD, gateEnv), gitOut(repo, HEAD, gateEnv)]);
            assert.equal(a, sha);
            assert.equal(b, sha);
            assert.equal(await gitOut(repo, HEAD, gateEnv), sha);
            return ALLOW;
        };
        await routerCall(env, gate);
        assert.equal(children('rev-parse'), 1);
        await routerCall(env, gate);
        assert.equal(children('rev-parse'), 2);
    });
    it('a different dir, argv or input is its own run', async () => {
        await runWithGitMemo(env, async () => {
            await gitOut(repo, HEAD, env);
            await gitOut(repo, ['rev-parse', '--short', 'HEAD'], env);
            await gitOut(root, HEAD, env);
            await gitOut(repo, ['cat-file', '--batch-check'], env, 'HEAD\n');
            await gitOut(repo, ['cat-file', '--batch-check'], env, 'HEAD\n');
            await gitOut(repo, ['cat-file', '--batch-check'], env, 'HEAD^{tree}\n');
        });
        assert.equal(children('rev-parse'), 3);
        assert.equal(children('cat-file'), 2);
    });
    it('a failing read is an answer and is kept', async () => {
        await runWithGitMemo(env, async () => {
            assert.notEqual((await gitRun(repo, ['rev-parse', '--verify', '--quiet', 'no-such-ref'], env)).code, 0);
            assert.notEqual((await gitRun(repo, ['rev-parse', '--verify', '--quiet', 'no-such-ref'], env)).code, 0);
        });
        assert.equal(children('rev-parse'), 1);
    });
    it('a caller with its own env, stderr or timeout runs its own child and clears nothing', async () => {
        await runWithGitMemo(env, async () => {
            await gitOut(repo, HEAD, env);
            await gitSpawn(repo, HEAD, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, stderr: 'pipe', timeoutMs: PLENTY_MS });
            await gitSpawn(repo, HEAD, { env, stderr: 'pipe' });
            await gitSpawn(repo, HEAD, { env, timeoutMs: PLENTY_MS });
            assert.equal(children('rev-parse'), 4);
            await gitOut(repo, HEAD, env);
        });
        assert.equal(children('rev-parse'), 4);
    });
    it('a caller with its own env still clears the reads when its subcommand is a writer', async () => {
        await runWithGitMemo(env, async () => {
            await gitOut(repo, HEAD, env);
            await gitSpawn(repo, ['ls-tree', 'HEAD'], { env: { ...env }, stderr: 'pipe', timeoutMs: PLENTY_MS });
            await gitOut(repo, HEAD, env);
        });
        assert.equal(children('rev-parse'), 2);
    });
});
describe('outside the router', () => {
    it('nothing is memoized', async () => {
        await gitOut(repo, HEAD, env);
        await gitOut(repo, HEAD, env);
        assert.equal(children('rev-parse'), 2);
    });
});
describe('the read-only allowlist', () => {
    const admitted = [
        ['rev-parse', '--verify', 'HEAD'],
        ['symbolic-ref', '--short', 'HEAD'],
        ['symbolic-ref', '-q', 'HEAD'],
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        ['show-ref', '--verify', '--quiet', 'refs/heads/dev'],
        ['merge-base', '--is-ancestor', 'a', 'b'],
        ['rev-list', '--count', 'a..b'],
        ['cat-file', '--batch'],
        ['log', '--oneline', '-5'],
        ['status', '--porcelain'],
        ['remote', 'get-url', 'origin'],
        ['worktree', 'list', '--porcelain'],
    ];
    const refused = [
        ['-c', 'core.pager=x', 'rev-parse', 'HEAD'],
        ['symbolic-ref', 'HEAD', 'refs/heads/other'],
        ['symbolic-ref', '-m', 'why', 'HEAD', 'refs/heads/other'],
        ['symbolic-ref', '-d', 'HEAD'],
        ['symbolic-ref', '--delete', 'HEAD'],
        ['symbolic-ref'],
        ['log', '--output=/tmp/x', '-p'],
        ['log', '--outp=/tmp/x', '-p'],
        ['rev-list', '--output=/tmp/x', 'HEAD'],
        ['remote', 'add', 'x', 'y'],
        ['remote', 'set-url', 'origin', 'y'],
        ['worktree', 'add', 'x'],
        ['worktree', 'remove', 'x'],
        ['fetch', 'origin'],
        ['commit', '-m', 'x'],
        ['config', 'x', 'y'],
        ['diff'],
        [],
    ];
    for (const args of admitted)
        it(`admits ${args.join(' ')}`, () => assert.equal(isProvablyReadOnly(args), true));
    for (const args of refused)
        it(`refuses ${args.join(' ') || 'no args'}`, () => assert.equal(isProvablyReadOnly(args), false));
});
describe('a writer clears the memo', () => {
    it('a real commit: the read after it runs a new child and sees the new commit', async () => {
        await runWithGitMemo(env, async () => {
            const first = await gitOut(repo, HEAD, env);
            await gitOut(repo, HEAD, env);
            assert.equal(children('rev-parse'), 1);
            assert.equal((await gitRun(repo, ['commit', '-q', '--allow-empty', '-m', 'second'], env)).code, 0);
            const second = await gitOut(repo, HEAD, env);
            assert.equal(children('rev-parse'), 2);
            assert.notEqual(second, first);
            assert.equal(second, sh(repo, 'rev-parse', 'HEAD'));
        });
    });
    it('a real ref update: the read after it sees the moved ref', async () => {
        const seed = sh(repo, 'rev-parse', 'HEAD');
        const tip = sh(repo, 'commit-tree', '-m', 'moved', `${seed}^{tree}`);
        sh(repo, 'update-ref', 'refs/heads/moving', seed);
        await runWithGitMemo(env, async () => {
            assert.equal(await gitOut(repo, ['rev-parse', 'refs/heads/moving'], env), seed);
            assert.equal((await gitRun(repo, ['update-ref', 'refs/heads/moving', tip], env)).code, 0);
            assert.equal(await gitOut(repo, ['rev-parse', 'refs/heads/moving'], env), tip);
        });
    });
    it('a symbolic-ref write is a writer, its read form is not', async () => {
        sh(repo, 'update-ref', 'refs/heads/pointed', 'HEAD');
        sh(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/dev');
        await runWithGitMemo(env, async () => {
            assert.equal(await gitOut(repo, ['symbolic-ref', '--short', 'refs/heads/alias'], env), 'dev');
            assert.equal((await gitRun(repo, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/pointed'], env)).code, 0);
            assert.equal(await gitOut(repo, ['symbolic-ref', '--short', 'refs/heads/alias'], env), 'pointed');
        });
        sh(repo, 'symbolic-ref', '-d', 'refs/heads/alias');
    });
    it('a read still in flight when the writer settles is not kept', async () => {
        await runWithGitMemo(env, async () => {
            const [before] = await Promise.all([gitOut(repo, HEAD, env), gitRun(repo, ['commit', '-q', '--allow-empty', '-m', 'raced'], env)]);
            assert.match(before, /^[0-9a-f]{40}$/);
            assert.equal(await gitOut(repo, HEAD, env), sh(repo, 'rev-parse', 'HEAD'));
        });
    });
});
describe('fetch', () => {
    let other;
    let advanced;
    before(() => {
        other = join(root, 'other');
        sh(root, 'clone', '-q', '-b', 'dev', join(root, 'origin.git'), other);
        sh(other, 'config', 'user.email', 't@t.t');
        sh(other, 'config', 'user.name', 't');
    });
    beforeEach(() => {
        sh(repo, 'push', '-q', '--force', 'origin', 'dev');
        sh(repo, 'fetch', '-q', 'origin');
        sh(other, 'pull', '-q', '--rebase=false', 'origin', 'dev');
        advanced = commit(other, 'upstream');
        sh(other, 'push', '-q', 'origin', 'dev');
    });
    it('identical concurrent fetches run one child and later reads are fresh', async () => {
        await runWithGitMemo(env, async () => {
            const stale = await gitOut(repo, ['rev-parse', 'origin/dev'], env);
            assert.notEqual(stale, advanced);
            const runs = await Promise.all([gitRun(repo, HTTP_FETCH, env), gitRun(repo, HTTP_FETCH, env), gitRun(repo, HTTP_FETCH, env)]);
            assert.deepEqual(runs.map((r) => r.code), [0, 0, 0]);
            assert.equal(children(' fetch '), 1);
            assert.equal(await gitOut(repo, ['rev-parse', 'origin/dev'], env), advanced);
            assert.equal(children('rev-parse'), 2);
        });
    });
    it('a done fetch is shared with a later gate, until a writer runs', async () => {
        await runWithGitMemo(env, async () => {
            await gitRun(repo, HTTP_FETCH, env);
            await gitRun(repo, HTTP_FETCH, env);
            assert.equal(children(' fetch '), 1);
            await gitRun(repo, ['update-ref', 'refs/heads/after-fetch', 'HEAD'], env);
            await gitRun(repo, HTTP_FETCH, env);
            assert.equal(children(' fetch '), 2);
        });
    });
    it('a different fetch is its own run', async () => {
        await runWithGitMemo(env, async () => {
            await Promise.all([gitRun(repo, HTTP_FETCH, env), gitRun(repo, ['fetch', 'origin', '--quiet'], env)]);
        });
        assert.equal(children(' fetch '), 2);
    });
    it('a failed fetch is not kept', async () => {
        await runWithGitMemo(env, async () => {
            const failing = ['fetch', 'origin', 'no-such-branch', '--quiet'];
            assert.notEqual((await gitRun(repo, failing, env)).code, 0);
            assert.notEqual((await gitRun(repo, failing, env)).code, 0);
        });
        assert.equal(children(' fetch '), 2);
    });
    it('a cut fetch is not kept', async () => {
        installGit(`if [ ! -e '${join(root, 'cut-fetch')}' ]; then : > '${join(root, 'cut-fetch')}'; exec sleep 30; fi`);
        rmSync(join(root, 'cut-fetch'), { force: true });
        await runWithGitMemo(env, async () => {
            const cut = await runWithDeadline(performance.now() + CUT_MS, () => gitRun(repo, HTTP_FETCH, env));
            assert.equal(cut.value.code, -1);
            assert.equal(cut.expired, true);
            const next = await runWithDeadline(performance.now() + PLENTY_MS, () => gitRun(repo, HTTP_FETCH, env));
            assert.equal(next.value.code, 0);
            assert.equal(next.expired, false);
        });
        assert.equal(children(' fetch '), 2);
    });
});
describe('deadlines on a shared run', () => {
    let marker;
    beforeEach(() => {
        marker = join(root, 'marker');
        rmSync(marker, { force: true });
    });
    const hangFirstChild = () => installGit(`if [ ! -e '${marker}' ]; then : > '${marker}'; exec sleep 30; fi`);
    const holdUntilMarker = () => installGit(`while [ ! -e '${marker}' ]; do sleep 0.02; done`);
    const inScope = (ms) => runWithDeadline(performance.now() + ms, () => gitSpawn(repo, HEAD, { env }));
    it('a waiter past its own deadline returns -1 with its own scope expired, and the starter is unaffected', async () => {
        holdUntilMarker();
        const sha = sh(repo, 'rev-parse', 'HEAD');
        await runWithGitMemo(env, async () => {
            const starter = inScope(PLENTY_MS);
            const waiter = await inScope(CUT_MS);
            assert.equal(waiter.value.code, -1);
            assert.equal(waiter.value.error?.code, 'ETIMEDOUT');
            assert.equal(waiter.expired, true);
            assert.equal(children('rev-parse'), 1, 'the waiter started no child');
            writeFileSync(marker, '');
            const started = await starter;
            assert.equal(started.value.code, 0);
            assert.equal(started.value.stdout.toString().trim(), sha);
            assert.equal(started.expired, false);
        });
    });
    it('waiters with time left whose starter was cut run git once more and get the real result, not expired', async () => {
        hangFirstChild();
        const sha = sh(repo, 'rev-parse', 'HEAD');
        await runWithGitMemo(env, async () => {
            const [starter, waiterA, waiterB] = await Promise.all([inScope(CUT_MS), inScope(PLENTY_MS), inScope(PLENTY_MS)]);
            assert.equal(starter.value.code, -1);
            assert.equal(starter.expired, true);
            for (const waiter of [waiterA, waiterB]) {
                assert.equal(waiter.value.code, 0);
                assert.equal(waiter.value.stdout.toString().trim(), sha);
                assert.equal(waiter.expired, false);
            }
            assert.equal(children('rev-parse'), 2);
        });
    });
    it('a cut run is not served to a later caller', async () => {
        hangFirstChild();
        const sha = sh(repo, 'rev-parse', 'HEAD');
        await runWithGitMemo(env, async () => {
            const cut = await inScope(CUT_MS);
            assert.equal(cut.value.code, -1);
            const later = await inScope(PLENTY_MS);
            assert.equal(later.value.code, 0);
            assert.equal(later.value.stdout.toString().trim(), sha);
            assert.equal(later.expired, false);
            assert.equal(children('rev-parse'), 2);
        });
    });
    it('past its own deadline a caller gets -1 and expired even with the answer already held', async () => {
        await runWithGitMemo(env, async () => {
            assert.equal((await inScope(PLENTY_MS)).value.code, 0);
            const late = await runWithDeadline(performance.now() + 1, async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return await gitSpawn(repo, HEAD, { env });
            });
            assert.equal(late.value.code, -1);
            assert.equal(late.expired, true);
        });
    });
});
//# sourceMappingURL=hooks-git-memo.test.js.map