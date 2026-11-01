/**
 * Async git and the per-gate deadline scope (GH 1692 R-async A1, decision 1107):
 * an awaited gitOk decides on a boolean, overlapping scopes each read their own
 * deadline, and a git past its deadline dies and marks its gate over budget.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW } from '../hooks/gate.js';
import { deadlineSignal, runWithDeadline, spawnLimit } from '../hooks/lib/deadline.js';
import { gitOk, gitOut, gitRun, gitSpawn } from '../hooks/lib/git.js';
import { decide } from '../hooks/router/decide.js';
const CUT_DEADLINE_MS = 200;
const STARTED_BY_THEN_MS = 2_000;
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
describe('async git results', () => {
    it('gitOk on a failing command resolves false and its awaited use takes the false branch', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-git-ok-'));
        try {
            const failing = gitOk(dir, ['rev-parse', '--verify', 'refs/heads/no-such-branch']);
            assert.ok(failing instanceof Promise);
            assert.equal(await failing, false);
            const taken = (await gitOk(dir, ['rev-parse', '--verify', 'refs/heads/no-such-branch'])) ? 'true branch' : 'false branch';
            assert.equal(taken, 'false branch');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('keeps the exit code, strips only trailing newlines and feeds input', async () => {
        assert.equal((await gitRun('/', ['--version'])).code, 0);
        assert.notEqual((await gitRun('/', ['no-such-subcommand'])).code, 0);
        assert.match(await gitOut('/', ['--version']), /^git version [^\n]*[^\n]$/);
        const hashed = await gitOut('/', ['hash-object', '--stdin'], process.env, 'x\n');
        assert.equal(hashed, '587be6b4c3f93f93c489c0111bba5596147a26cb');
    });
    it('a git that cannot start fails with code -1 and its error', async () => {
        const r = await gitSpawn('/', ['--version'], { env: { PATH: '/no-such-dir' } });
        assert.equal(r.code, -1);
        assert.equal(r.error?.code, 'ENOENT');
    });
});
describe('the deadline scope', () => {
    it('two overlapping scopes each read their own deadline', async () => {
        let releaseA = () => undefined;
        let releaseB = () => undefined;
        const aHeld = new Promise((resolve) => {
            releaseA = resolve;
        });
        const bHeld = new Promise((resolve) => {
            releaseB = resolve;
        });
        const clock = () => 1000;
        const a = runWithDeadline(1100, async () => {
            const first = spawnLimit()?.timeout;
            releaseB();
            await aHeld;
            return [first, spawnLimit()?.timeout];
        }, clock);
        const b = runWithDeadline(1700, async () => {
            await bHeld;
            const first = spawnLimit()?.timeout;
            releaseA();
            await Promise.resolve();
            return [first, spawnLimit()?.timeout];
        }, clock);
        const [left, right] = await Promise.all([a, b]);
        assert.deepEqual(left.value, [100, 100]);
        assert.deepEqual(right.value, [700, 700]);
    });
    it('outside a scope there is no deadline', async () => {
        await runWithDeadline(1100, () => undefined, () => 1000);
        assert.equal(spawnLimit(), null);
        assert.equal(deadlineSignal(), undefined);
    });
});
describe('a git past its deadline', () => {
    let bin;
    let pidFile;
    let env;
    before(() => {
        bin = mkdtempSync(join(tmpdir(), 'tmb-hung-git-'));
        pidFile = join(bin, 'pid');
        writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
        chmodSync(join(bin, 'git'), 0o755);
        env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    });
    after(() => rmSync(bin, { recursive: true, force: true }));
    it('is killed, returns a failed result and leaves the scope expired', async () => {
        rmSync(pidFile, { force: true });
        const { value, expired } = await runWithDeadline(performance.now() + STARTED_BY_THEN_MS, () => gitRun('/', ['status'], env));
        assert.equal(value.code, -1);
        assert.equal(expired, true);
        assert.ok(existsSync(pidFile), 'the hung git ran');
        assert.equal(isAlive(Number(readFileSync(pidFile, 'utf8').trim())), false, 'the hung git is gone');
    });
    it('a git still holding its pipe through its own child settles at the cut', async () => {
        const holder = mkdtempSync(join(tmpdir(), 'tmb-pipe-git-'));
        try {
            writeFileSync(join(holder, 'git'), '#!/bin/sh\nsleep 30\n');
            chmodSync(join(holder, 'git'), 0o755);
            const held = { ...process.env, PATH: `${holder}:${process.env.PATH ?? ''}` };
            const { value, expired } = await runWithDeadline(performance.now() + CUT_DEADLINE_MS, () => gitOk('/', ['status'], held));
            assert.equal(value, false);
            assert.equal(expired, true);
        }
        finally {
            rmSync(holder, { recursive: true, force: true });
        }
    });
    it('a scope past its deadline never starts git', async () => {
        rmSync(pidFile, { force: true });
        const { value, expired } = await runWithDeadline(performance.now() + 1, async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return gitRun('/', ['status'], env);
        });
        assert.equal(value.code, -1);
        assert.equal(expired, true);
        assert.equal(existsSync(pidFile), false);
    });
    it('judge reports overBudget for the gate that swallowed the failure', async () => {
        let t = 0;
        const CLOCK_SETBACK_MS = 60_000;
        const swallows = async (_payload, gateEnv) => {
            t -= CLOCK_SETBACK_MS;
            const ok = await gitOk('/', ['status'], gateEnv);
            t += CLOCK_SETBACK_MS;
            assert.equal(ok, false);
            return ALLOW;
        };
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
        const verdict = async (kind) => await decide('PreToolUse', payload, env, {
            groups: [{ event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: CLOCK_SETBACK_MS, gates: [{ name: 'swallows', kind, budgetMs: CUT_DEADLINE_MS }] }],
            findGate: () => swallows,
            now: () => t,
        });
        const denied = await verdict('enforcement');
        assert.equal(denied.denied?.gate, 'swallows');
        assert.match(denied.stdout, /TMB gate swallows timed out after 200 ms/);
        const skipped = await verdict('advisory');
        assert.deepEqual(skipped.gates.map((g) => g.outcome), ['skipped_budget']);
    });
});
//# sourceMappingURL=hooks-git-async.test.js.map