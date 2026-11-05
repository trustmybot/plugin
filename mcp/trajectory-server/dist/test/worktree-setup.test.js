/**
 * Opt-in per-repo worktree setup (GH 2054): the runWorktreeSetup util, and
 * its fail-soft (task_provision), fail-with-error (pr_monitor_worktree) and
 * fail-closed (swe-verification-gate) callers. cli.js integrate's case lives
 * in cli-integrate.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runWorktreeSetup, WORKTREE_SETUP_FILE } from '../utils/worktree-setup.js';
import { compositeTools } from '../tools/composites.js';
import { sweVerificationGate } from '../hooks/swe-verification-gate.js';
import { pinScanEnv, tempDB } from './helpers.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t.t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t.t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
};
function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
        .toString()
        .trim();
}
function writeSetup(dir, body) {
    mkdirSync(join(dir, '.config/tmb'), { recursive: true });
    writeFileSync(join(dir, WORKTREE_SETUP_FILE), typeof body === 'string' ? body : JSON.stringify(body));
}
function tempDir(prefix) {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
const parse = (r) => JSON.parse(r.content[0].text);
describe('runWorktreeSetup', () => {
    let dir;
    before(() => {
        dir = tempDir('tmb-wt-setup-');
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    it('an absent file is a no-op: ran false, no error', async () => {
        const empty = join(dir, 'absent');
        mkdirSync(empty);
        assert.deepEqual(await runWorktreeSetup(empty), { ran: false, commands: [] });
    });
    it('runs the commands in order in the worktree cwd and stops at the first non-zero exit', async () => {
        const wt = join(dir, 'ordered');
        mkdirSync(wt);
        const commands = ['pwd -P > cwd.txt; echo one >> log.txt', 'echo two >> log.txt; echo setup-broke; exit 3', 'echo three >> log.txt'];
        writeSetup(wt, { version: 1, commands });
        const r = await runWorktreeSetup(wt);
        assert.equal(r.ran, true);
        assert.deepEqual(r.commands.map((c) => [c.command, c.exit_code, c.timed_out]), [
            [commands[0], 0, false],
            [commands[1], 3, false],
        ]);
        assert.equal(readFileSync(join(wt, 'log.txt'), 'utf8'), 'one\ntwo\n', 'the third command never ran');
        assert.equal(readFileSync(join(wt, 'cwd.txt'), 'utf8').trim(), wt);
        assert.match(r.error ?? '', /exited 3: echo two >> log.txt; echo setup-broke; exit 3/);
        assert.match(r.output_tail ?? '', /setup-broke/);
    });
    it('a passing setup reports every command with exit 0 and no error', async () => {
        const wt = join(dir, 'passing');
        mkdirSync(wt);
        writeSetup(wt, { version: 1, commands: ['true', 'echo ok'] });
        const r = await runWorktreeSetup(wt);
        assert.equal(r.ran, true);
        assert.equal(r.error, undefined);
        assert.deepEqual(r.commands.map((c) => [c.command, c.exit_code]), [['true', 0], ['echo ok', 0]]);
    });
    for (const [name, body] of [
        ['malformed JSON', '{"version":1,"commands":['],
        ['a wrong version', { version: 2, commands: ['true'] }],
        ['no version', { commands: ['true'] }],
        ['an empty commands array', { version: 1, commands: [] }],
        ['a non-string command', { version: 1, commands: ['true', 7] }],
        ['an empty-string command', { version: 1, commands: [' '] }],
        ['a non-object file', [1]],
    ]) {
        it(`${name} returns an error and runs nothing`, async () => {
            const wt = mkdtempSync(join(dir, 'bad-'));
            writeSetup(wt, body);
            const r = await runWorktreeSetup(wt);
            assert.equal(r.ran, false);
            assert.deepEqual(r.commands, []);
            assert.match(r.error ?? '', /\.config\/tmb\/worktree-setup\.json: /);
        });
    }
    it('a command past its timeout reports timed_out and kills it', async () => {
        const wt = join(dir, 'slow');
        mkdirSync(wt);
        writeSetup(wt, { version: 1, commands: ['sleep 5; touch late.txt', 'touch next.txt'] });
        const r = await runWorktreeSetup(wt, { timeoutMs: 300 });
        assert.equal(r.commands.length, 1);
        assert.equal(r.commands[0].timed_out, true);
        assert.ok(r.commands[0].elapsed_ms < 4000, `elapsed ${r.commands[0].elapsed_ms}ms`);
        assert.match(r.error ?? '', /timed out/);
        assert.equal(existsSync(join(wt, 'next.txt')), false);
    });
    it('a total budget cuts the command running when it runs out', async () => {
        const wt = join(dir, 'total-budget');
        mkdirSync(wt);
        writeSetup(wt, { version: 1, commands: ['sleep 0.3', 'sleep 5; touch late.txt', 'touch next.txt'] });
        const r = await runWorktreeSetup(wt, { totalTimeoutMs: 800 });
        assert.deepEqual(r.commands.map((c) => [c.exit_code, c.timed_out]), [[0, false], [124, true]]);
        assert.ok(r.commands[1].elapsed_ms < 4000, `elapsed ${r.commands[1].elapsed_ms}ms`);
        assert.match(r.error ?? '', /timed out: its 1s budget ran out: sleep 5; touch late\.txt/);
        assert.equal(existsSync(join(wt, 'next.txt')), false);
    });
    it('a spent total budget starts no command', async () => {
        const wt = join(dir, 'spent-budget');
        mkdirSync(wt);
        writeSetup(wt, { version: 1, commands: ['touch first.txt'] });
        const r = await runWorktreeSetup(wt, { totalTimeoutMs: 0 });
        assert.equal(r.ran, false);
        assert.deepEqual(r.commands.map((c) => [c.command, c.exit_code, c.timed_out]), [['touch first.txt', 124, true]]);
        assert.match(r.error ?? '', /ran out of its 0s budget before command 1\/1: touch first\.txt/);
        assert.equal(existsSync(join(wt, 'first.txt')), false);
    });
    it('gets the env it is given', async () => {
        const wt = join(dir, 'env');
        mkdirSync(wt);
        writeSetup(wt, { version: 1, commands: ['test "$SETUP_PROBE" = here'] });
        assert.equal((await runWorktreeSetup(wt, { env: { ...process.env, SETUP_PROBE: 'here' } })).error, undefined);
        assert.match((await runWorktreeSetup(wt, { env: { ...process.env, SETUP_PROBE: 'gone' } })).error ?? '', /exited 1/);
    });
});
function makeRepo(setup) {
    const ws = tempDir('tmb-wt-setup-repo-');
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot);
    git(repoRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, 'package.json'), '{}\n');
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.claude/\n');
    if (setup !== undefined)
        writeSetup(repoRoot, setup);
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'base');
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'node_modules/marker'), 'dep\n');
    return { ws, repoRoot };
}
describe('task_provision runs worktree setup fail-soft', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
    const provision = async (repoRoot, ws, branch) => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const r = (await composites.handlers['task_provision']({
            agent: 'bro',
            issue_id: 1,
            branch_id: branch,
            decision_body: 'Chosen approach: provision with a setup step.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
        }));
        return { r, db };
    };
    it('a failing setup still provisions and reports the failing command', async () => {
        const { ws, repoRoot } = makeRepo({ version: 1, commands: ['echo provision-setup-broke; exit 6'] });
        try {
            const { r, db } = await provision(repoRoot, ws, 'feat/setup-fails');
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            const out = parse(r);
            assert.equal(typeof out['task_id'], 'number');
            assert.equal(out['git_setup'], 'created');
            assert.ok(existsSync(join(repoRoot, '.claude/worktrees/setup-fails/a.txt')), 'worktree created');
            const setup = out['worktree_setup'];
            assert.equal(setup.ran, true);
            assert.match(setup.error, /exited 6: echo provision-setup-broke; exit 6/);
            assert.match(setup.output_tail, /provision-setup-broke/);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('a passing setup runs after node_modules is linked and is reported', async () => {
        const { ws, repoRoot } = makeRepo({ version: 1, commands: ['test -f node_modules/marker && touch setup-ran'] });
        try {
            const { r, db } = await provision(repoRoot, ws, 'feat/setup-passes');
            const out = parse(r);
            const setup = out['worktree_setup'];
            assert.equal(setup.ran, true);
            assert.equal(setup.error, undefined);
            assert.ok(existsSync(join(repoRoot, '.claude/worktrees/setup-passes/setup-ran')));
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('no setup file leaves the result without worktree_setup', async () => {
        const { ws, repoRoot } = makeRepo(undefined);
        try {
            const { r, db } = await provision(repoRoot, ws, 'feat/no-setup');
            assert.equal(parse(r)['worktree_setup'], undefined);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('pr_monitor_worktree runs worktree setup before its command', () => {
    const monitor = async (repoRoot, command) => {
        const sha = git(repoRoot, 'rev-parse', 'HEAD');
        const db = tempDB();
        try {
            const composites = compositeTools(db, join(repoRoot, '.claude', 'tmb', 'trajectory.db'));
            const r = (await composites.handlers['pr_monitor_worktree']({ agent: 'code-reviewer', commit_sha: sha, repo_path: repoRoot, command }));
            return { r, sha };
        }
        finally {
            db.close();
        }
    };
    it('a setup failure returns an error naming the command, skips the command and removes the worktree', async () => {
        const { ws, repoRoot } = makeRepo({ version: 1, commands: ['echo review-setup-broke; exit 4'] });
        try {
            const { r, sha } = await monitor(repoRoot, 'touch ../../command-ran');
            assert.equal(r.isError, true);
            const error = parse(r)['error'];
            assert.match(error, /worktree setup failed/);
            assert.match(error, /exited 4: echo review-setup-broke; exit 4/);
            assert.match(error, /Output \(last 20 lines\):\nreview-setup-broke/);
            assert.equal(existsSync(join(repoRoot, '.claude/worktrees', `pr-review-${sha}`)), false, 'worktree removed');
            assert.equal(existsSync(join(repoRoot, '.claude/command-ran')), false, 'command not run');
            assert.ok(!git(repoRoot, 'worktree', 'list', '--porcelain').includes('pr-review-'), 'worktree unregistered');
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('links node_modules and runs setup before the command', async () => {
        const { ws, repoRoot } = makeRepo({ version: 1, commands: ['test -f node_modules/marker && touch setup-ran'] });
        try {
            const { r, sha } = await monitor(repoRoot, 'test -f setup-ran && test -f node_modules/marker');
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            assert.equal(parse(r)['passed'], true);
            assert.equal(existsSync(join(repoRoot, '.claude/worktrees', `pr-review-${sha}`)), false);
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('swe-verification-gate runs worktree setup before verification[]', () => {
    const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
    const T1 = '2026-11-05T10:00:00.000Z';
    const VERIFICATION = ['test -f setup-ran', 'echo verified'];
    let base;
    let dbFile;
    const worktreeOf = (slug) => join(base, 'project/checkout/.claude/worktrees', slug);
    before(() => {
        base = tempDir('tmb-wt-setup-gate-');
        mkdirSync(join(base, 'home'));
        const tasks = [
            { id: 60, slug: 'setup-ok', setup: ['touch setup-ran'] },
            { id: 61, slug: 'setup-broke', setup: ['echo gate-setup-broke; exit 9'] },
            { id: 62, slug: 'setup-slow', setup: ['sleep 5'] },
            { id: 63, slug: 'setup-spends', setup: ['sleep 0.2'] },
            { id: 64, slug: 'setup-shares', setup: ['sleep 1.2'], verification: ['sleep 2'] },
        ];
        for (const t of tasks) {
            const wt = worktreeOf(t.slug);
            mkdirSync(wt, { recursive: true });
            writeSetup(wt, { version: 1, commands: t.setup });
            writeFileSync(join(wt, '.gitignore'), 'setup-ran\n');
            git(wt, 'init', '-q');
            git(wt, 'add', '.');
            git(wt, 'commit', '-q', '-m', t.slug);
        }
        dbFile = join(base, 'project/.claude/tmb/trajectory.db');
        mkdirSync(dirname(dbFile), { recursive: true });
        const db = new DatabaseSync(dbFile);
        try {
            db.exec(SCHEMA);
            db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)').run('plugin', join(base, 'project/checkout'), T1);
            db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'setup', 'open', ?, ?)").run(T1, T1);
            const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, verification, created_at, updated_at) VALUES (?, 1, ?, 'd', 'running', 'plugin', ?, ?, ?)");
            for (const t of tasks)
                task.run(t.id, `feat/${t.slug}`, JSON.stringify('verification' in t ? t.verification : VERIFICATION), T1, T1);
        }
        finally {
            db.close();
        }
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    const env = (budgetS) => ({
        ...(budgetS === undefined ? {} : { TMB_VERIFICATION_TIMEOUT_S: String(budgetS) }),
        HOME: join(base, 'home'),
        CLAUDE_PROJECT_DIR: join(base, 'project'),
        TRAJECTORY_DB_PATH: dbFile,
        MISE_DATA_DIR: join(base, 'mise'),
        PATH: process.env.PATH,
        TMPDIR: base,
    });
    const completion = (taskId) => JSON.stringify({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status', tool_input: { agent: 'swe', task_id: taskId, status: 'completed' } });
    const read = (sql, ...params) => {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
            return db.prepare(sql).all(...params).map((r) => ({ ...r }));
        }
        finally {
            db.close();
        }
    };
    it('a setup failure denies the close with the command and its output tail, and records no run', async () => {
        const r = await sweVerificationGate(completion(61), env());
        const out = JSON.parse(r.stdout);
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
        const reason = out.hookSpecificOutput.permissionDecisionReason ?? '';
        assert.match(reason, /^BLOCKED: worktree setup failed/);
        assert.match(reason, /exited 9: echo gate-setup-broke; exit 9/);
        assert.match(reason, /Output \(last 20 lines\):\ngate-setup-broke/);
        assert.deepEqual(read('SELECT id FROM verification_runs WHERE task_id = ?', 61), []);
    });
    it('a passing setup runs before verification[] and records only the verification[] commands', async () => {
        assert.deepEqual(await sweVerificationGate(completion(60), env()), { stdout: '', code: 0 });
        const rows = read('SELECT command, exit_code FROM verification_run_commands WHERE run_id = (SELECT id FROM verification_runs WHERE task_id = ?) ORDER BY ordinal', 60);
        assert.deepEqual(rows, VERIFICATION.map((command) => ({ command, exit_code: 0 })));
    });
    const reasonOf = (r) => {
        const out = JSON.parse(r.stdout);
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
        return out.hookSpecificOutput.permissionDecisionReason ?? '';
    };
    it('setup is cut off when the verification budget runs out, and the close is denied', async () => {
        const started = Date.now();
        const reason = reasonOf(await sweVerificationGate(completion(62), env(1)));
        assert.ok(Date.now() - started < 4000, `gate took ${Date.now() - started}ms`);
        assert.match(reason, /^BLOCKED: worktree setup failed/);
        assert.match(reason, /timed out: its 1s budget ran out: sleep 5/);
        assert.match(reason, /counts against the 1s verification budget/);
        assert.deepEqual(read('SELECT id FROM verification_runs WHERE task_id = ?', 62), []);
    });
    it('a setup that uses up the verification budget denies without running verification[]', async () => {
        const reason = reasonOf(await sweVerificationGate(completion(63), env(1)));
        assert.match(reason, /^BLOCKED: worktree setup used up the 1s verification budget \(1s\)/);
        assert.deepEqual(read('SELECT id FROM verification_runs WHERE task_id = ?', 63), []);
    });
    it('verification[] gets only the budget setup leaves', async () => {
        const reason = reasonOf(await sweVerificationGate(completion(64), env(3)));
        assert.match(reason, /^BLOCKED: verification timed out — the 1s budget left after 2s of worktree setup ran out/);
        assert.deepEqual(read('SELECT budget_s, timed_out FROM verification_runs WHERE task_id = ?', 64), [{ budget_s: 1, timed_out: 1 }]);
    });
    it('a reused passing run does not run setup', async () => {
        rmSync(join(worktreeOf('setup-ok'), 'setup-ran'));
        const r = await sweVerificationGate(completion(60), env());
        assert.match(r.stdout, /verification reused run #/);
        assert.equal(existsSync(join(worktreeOf('setup-ok'), 'setup-ran')), false, 'setup did not run again');
    });
});
//# sourceMappingURL=worktree-setup.test.js.map