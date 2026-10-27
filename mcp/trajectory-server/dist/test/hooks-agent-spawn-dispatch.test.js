/**
 * The agent-spawn-dispatch gate (GH 1692) over a stub gate lookup: the chain
 * runs in order, the first deny comes out verbatim and stops the run before
 * PREPARE, and the chain's additionalContext parts are joined by a `---`
 * line. ensure-swe-worktree on a real repo: it adds the slug worktree, and
 * (GH 2032) leaves a task's recorded worktree in place without a
 * `git worktree add`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CHAIN, CONTEXT_SEPARATOR, PREPARE, agentSpawnDispatch } from '../hooks/agent-spawn-dispatch.js';
import { ensureSweWorktree } from '../hooks/ensure-swe-worktree.js';
import { ALLOW } from '../hooks/gate.js';
import { findGate, gateNames } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const T0 = '2026-10-01T10:00:00.000Z';
const PAYLOAD = JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'swe', prompt: 'task_id=5' } });
const context = (text) => ({
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
    code: 0,
});
const deny = (reason) => ({
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
    code: 0,
});
/** A lookup whose gates log their name and the input they got, then reply with <replies>[name] (ALLOW when absent). */
function stubs(replies = {}) {
    const calls = [];
    const find = (name) => {
        const reply = replies[name];
        return async (input) => {
            calls.push({ name, input });
            if (typeof reply === 'function')
                return reply(input, {});
            return reply ?? ALLOW;
        };
    };
    return { calls, find, names: () => calls.map((c) => c.name) };
}
describe('agent-spawn-dispatch', () => {
    it('runs the nine chain gates in order, then the two PREPARE steps, and allows', async () => {
        const s = stubs();
        assert.deepEqual(await agentSpawnDispatch(`${PAYLOAD}\n\n`, {}, s.find), ALLOW);
        assert.deepEqual(s.names(), [...CHAIN, ...PREPARE]);
        assert.ok(s.calls.every((c) => c.input === PAYLOAD), 'every gate gets the payload without trailing newlines');
        assert.deepEqual(CHAIN, [
            'require-task-spec',
            'require-spawn-effort',
            'require-feature-branch-active',
            'code-reviewer-no-worktree',
            'code-reviewer-spawn-prompt-shape',
            'code-reviewer-after-atomic-close',
            'code-reviewer-spawn-note',
            'code-reviewer-preflight',
            'rework-limit',
        ]);
        assert.deepEqual(PREPARE, ['ensure-swe-worktree', 'record-swe-spawn']);
    });
    it('prints the first deny verbatim and runs no later gate or PREPARE step', async () => {
        const first = deny('no "spec"\nfor task 5');
        const s = stubs({ 'require-feature-branch-active': first, 'code-reviewer-no-worktree': deny('second'), 'require-task-spec': context('ctx') });
        assert.deepEqual(await agentSpawnDispatch(PAYLOAD, {}, s.find), first);
        assert.deepEqual(s.names(), CHAIN.slice(0, 3));
    });
    it('prints a deny gate output byte for byte, trailing newlines trimmed to one', async () => {
        const raw = '{ "hookSpecificOutput" : { "permissionDecision" : "deny" } }';
        const s = stubs({ 'rework-limit': { stdout: `${raw}\n\n\n`, code: 0 } });
        assert.deepEqual(await agentSpawnDispatch(PAYLOAD, {}, s.find), { stdout: `${raw}\n`, code: 0 });
        assert.ok(!s.names().some((n) => PREPARE.includes(n)));
    });
    it('joins the context parts of the passing gates by a --- line', async () => {
        const s = stubs({ 'require-task-spec': context('first part'), 'code-reviewer-spawn-note': context('second\npart'), 'rework-limit': context('third') });
        const r = await agentSpawnDispatch(PAYLOAD, {}, s.find);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.endsWith('}\n'));
        assert.deepEqual(JSON.parse(r.stdout), {
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ['first part', 'second\npart', 'third'].join(CONTEXT_SEPARATOR) },
        });
        assert.equal(CONTEXT_SEPARATOR, '\n\n---\n\n');
        assert.deepEqual(s.names(), [...CHAIN, ...PREPARE]);
    });
    it('drops the PREPARE steps output from the context', async () => {
        const s = stubs({ 'ensure-swe-worktree': context('prepare'), 'record-swe-spawn': deny('ignored') });
        assert.deepEqual(await agentSpawnDispatch(PAYLOAD, {}, s.find), ALLOW);
    });
    it('counts a missing, throwing or non-JSON gate as empty and drops its stderr', async () => {
        const written = [];
        const write = process.stderr.write;
        const s = stubs({
            'require-task-spec': () => {
                process.stderr.write('noise\n');
                throw new Error('boom');
            },
            'require-spawn-effort': { stdout: 'not json\n', code: 1 },
            'code-reviewer-preflight': context(''),
            'record-swe-spawn': () => {
                throw new Error('prepare boom');
            },
        });
        const find = (name) => (name === 'code-reviewer-no-worktree' ? undefined : s.find(name));
        process.stderr.write = ((chunk) => written.push(String(chunk)) > 0);
        let r;
        try {
            r = await agentSpawnDispatch(PAYLOAD, {}, find);
        }
        finally {
            process.stderr.write = write;
        }
        assert.deepEqual(r, ALLOW);
        assert.deepEqual(written, []);
        assert.ok(s.names().includes('rework-limit'));
    });
    it('is registered with every chain and PREPARE gate, and allows a non-Agent payload end to end', async () => {
        for (const name of ['agent-spawn-dispatch', ...CHAIN, ...PREPARE])
            assert.ok(gateNames().includes(name), name);
        const gate = findGate('agent-spawn-dispatch');
        assert.ok(gate);
        const home = mkdtempSync(join(tmpdir(), 'tmb-asd-home-'));
        try {
            const env = { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: home, TRAJECTORY_DB_PATH: join(home, 'missing.db') };
            assert.deepEqual(await gate(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), env), ALLOW);
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
const GIT_ENV = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
};
function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
}
describe('ensure-swe-worktree', () => {
    let sandbox;
    let seq = 0;
    before(() => {
        sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-ensure-swe-worktree-')));
    });
    after(() => rmSync(sandbox, { recursive: true, force: true }));
    /** <ws>/plugin is a git repo with <branch>; task 5 of <ws>'s DB is on it, with <worktree> recorded. */
    function fixture(branch, worktree) {
        seq += 1;
        const ws = join(sandbox, `case-${seq}`);
        const repo = join(ws, 'plugin');
        mkdirSync(repo, { recursive: true });
        git(repo, 'init', '-q', '-b', 'main');
        writeFileSync(join(repo, 'README.md'), 'r\n');
        git(repo, 'add', 'README.md');
        git(repo, 'commit', '-q', '-m', 'init');
        git(repo, 'branch', branch);
        const db = join(ws, '.claude/tmb/trajectory.db');
        mkdirSync(dirname(db), { recursive: true });
        const d = new DatabaseSync(db);
        d.exec(SCHEMA);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)").run(T0, T0);
        d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('plugin', repo);
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, worktree_path) VALUES (5, 1, ?, 'd', 'running', ?, ?, 'plugin', ?)").run(branch, T0, T0, worktree(repo));
        d.close();
        const env = { ...process.env, ...GIT_ENV, HOME: join(ws, 'home'), TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: ws };
        delete env.TMB_DISABLE_ENSURE_SWE_WORKTREE;
        return { repo, env };
    }
    function ensure(env) {
        const written = [];
        const write = process.stderr.write;
        process.stderr.write = ((chunk) => written.push(String(chunk)) > 0);
        try {
            assert.deepEqual(ensureSweWorktree(PAYLOAD, env), ALLOW);
        }
        finally {
            process.stderr.write = write;
        }
        return written.join('');
    }
    const worktrees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    it('adds the slug worktree for a task with no recorded worktree', () => {
        const f = fixture('feat/clean', () => null);
        const slugPath = join(f.repo, '.claude/worktrees/clean');
        assert.equal(ensure(f.env), `ensure-swe-worktree: created worktree ${slugPath} for branch feat/clean\n`);
        assert.ok(existsSync(join(slugPath, 'README.md')));
        assert.equal(ensure(f.env), '', 'a registered slug worktree is left alone');
    });
    it('leaves an existing recorded worktree in place without a git worktree add (GH 2032)', () => {
        let recorded = '';
        const f = fixture('feat/adopted', (repo) => {
            recorded = join(repo, '.claude/worktrees/session-1');
            return recorded;
        });
        git(f.repo, 'worktree', 'add', '-q', '.claude/worktrees/session-1', 'feat/adopted');
        const before = worktrees(f.repo);
        assert.equal(ensure(f.env), '');
        assert.deepEqual(worktrees(f.repo), before);
        assert.ok(!existsSync(join(f.repo, '.claude/worktrees/adopted')));
    });
    it('falls back to the slug worktree when the recorded one is gone (GH 2032)', () => {
        const f = fixture('feat/gone', (repo) => join(repo, '.claude/worktrees/session-gone'));
        const slugPath = join(f.repo, '.claude/worktrees/gone');
        assert.equal(ensure(f.env), `ensure-swe-worktree: created worktree ${slugPath} for branch feat/gone\n`);
        assert.ok(existsSync(slugPath));
    });
    it('does nothing under TMB_DISABLE_ENSURE_SWE_WORKTREE=1', () => {
        const f = fixture('feat/off', () => null);
        assert.equal(ensure({ ...f.env, TMB_DISABLE_ENSURE_SWE_WORKTREE: '1' }), '');
        assert.ok(!existsSync(join(f.repo, '.claude/worktrees/off')));
    });
});
//# sourceMappingURL=hooks-agent-spawn-dispatch.test.js.map