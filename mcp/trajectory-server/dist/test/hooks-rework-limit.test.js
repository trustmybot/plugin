/**
 * The rework-limit gate (GH 1738) on a temp trajectory DB: a swe spawn after
 * two review FAILs since the task's last pass is denied until a newer
 * kind='decision' row or a Human-authored row exists, and
 * agent-spawn-dispatch.sh returns that deny before any PREPARE step.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { reworkLimit } from '../hooks/rework-limit.js';
import { findGate, gateNames } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const TASK_ID = 3;
const OTHER_TASK_ID = 4;
let sandbox;
let seq = 0;
/** Verdict n is recorded at 10:0n; a discussion `at` is any ISO time. */
function fixture() {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const db = join(root, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(ISSUE_ID);
    for (const id of [TASK_ID, OTHER_TASK_ID]) {
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', 'running', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(id, ISSUE_ID, `feat/${id}-x`);
    }
    d.close();
    let attempt = 0;
    const verdicts = (...list) => {
        const w = new DatabaseSync(db);
        for (const verdict of list) {
            attempt += 1;
            w.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'pr-reviewer', ?, 'f', 1, ?)").run(TASK_ID, attempt, verdict, `2026-10-25T10:0${attempt}:00.000Z`);
        }
        w.close();
    };
    const discuss = ({ author = 'bro', kind = 'note', taskId = TASK_ID, at }) => {
        const w = new DatabaseSync(db);
        w.prepare('INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)').run(ISSUE_ID, author, kind, 'b', at, taskId);
        w.close();
    };
    return { db, env, verdicts, discuss };
}
const payload = (subagent = 'swe', prompt = `task_id=${TASK_ID} do the thing`) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: subagent, prompt } });
function run(f, input = payload()) {
    return reworkLimit(input, f.env);
}
function denyReason(stdout) {
    assert.notEqual(stdout, '', 'expected a deny');
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
const ALLOWED = { stdout: '', code: 0 };
const AFTER_LATEST_FAIL = '2026-10-25T11:00:00.000Z';
const BEFORE_LATEST_FAIL = '2026-10-25T10:01:30.000Z';
describe('rework-limit', () => {
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-rework-limit-'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
        assert.equal(findGate('rework-limit'), reworkLimit);
        assert.ok(gateNames().includes('rework-limit'));
    });
    it('denies a swe spawn after two FAILs with no newer decision, naming the ways forward', () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.discuss({ kind: 'decision', at: BEFORE_LATEST_FAIL });
        const reason = denyReason(run(f).stdout);
        assert.match(reason, /task 3 has 2 review FAILs since its last pass/);
        assert.match(reason, /the latest at 2026-10-25T10:02:00\.000Z/);
        assert.match(reason, /discussion_append kind='decision' task_id=3/);
        assert.match(reason, /task_retry with a redesigned spec/);
        assert.match(reason, /split the task/);
        assert.match(reason, /ask the Human/);
    });
    it('allows the spawn after a kind=decision row on the task newer than the latest FAIL', () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.discuss({ kind: 'decision', at: AFTER_LATEST_FAIL });
        assert.deepEqual(run(f), ALLOWED);
    });
    it('allows the spawn after an issue-level kind=decision row newer than the latest FAIL', () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.discuss({ kind: 'decision', taskId: null, at: AFTER_LATEST_FAIL });
        assert.deepEqual(run(f), ALLOWED);
    });
    it('allows the spawn after a Human-authored row instead of a decision', () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.discuss({ author: 'human', kind: 'note', taskId: null, at: AFTER_LATEST_FAIL });
        assert.deepEqual(run(f), ALLOWED);
    });
    it('a newer bro note, or a decision on another task, does not waive it', () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.discuss({ kind: 'note', at: AFTER_LATEST_FAIL });
        f.discuss({ kind: 'decision', taskId: OTHER_TASK_ID, at: AFTER_LATEST_FAIL });
        denyReason(run(f).stdout);
    });
    it('counts only the FAILs after the latest pass', () => {
        const f = fixture();
        f.verdicts('fail', 'fail', 'pass', 'fail');
        assert.deepEqual(run(f), ALLOWED);
        f.verdicts('fail');
        assert.match(denyReason(run(f).stdout), /2 review FAILs since its last pass/);
    });
    it('allows one FAIL, no FAIL, an unknown task, a non-swe spawn, a non-Agent tool and a prompt without task_id', () => {
        const f = fixture();
        assert.deepEqual(run(f), ALLOWED);
        f.verdicts('fail');
        assert.deepEqual(run(f), ALLOWED);
        f.verdicts('fail');
        assert.deepEqual(run(f, payload('swe', 'task_id=999')), ALLOWED);
        assert.deepEqual(run(f, payload('pr-reviewer')), ALLOWED);
        assert.deepEqual(run(f, payload('swe', 'no task here')), ALLOWED);
        assert.deepEqual(run(f, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })), ALLOWED);
        denyReason(run(f, payload('tmb:swe')).stdout);
    });
    it('denies when the DB cannot be read', () => {
        const f = fixture();
        writeFileSync(f.db, 'not a database');
        denyReason(run(f).stdout);
    });
    describe('agent-spawn-dispatch.sh', () => {
        function dispatcherRoot() {
            seq += 1;
            const root = join(sandbox, `plugin-${seq}`);
            const hooks = join(root, 'scripts/hooks');
            const marks = join(root, 'marks');
            mkdirSync(hooks, { recursive: true });
            mkdirSync(marks);
            mkdirSync(join(root, 'mcp/trajectory-server'), { recursive: true });
            symlinkSync(join(SERVER_ROOT, 'dist'), join(root, 'mcp/trajectory-server/dist'));
            copyFileSync(join(PLUGIN_ROOT, 'scripts/hooks/agent-spawn-dispatch.sh'), join(hooks, 'agent-spawn-dispatch.sh'));
            for (const step of ['ensure-swe-worktree', 'record-swe-spawn']) {
                writeFileSync(join(hooks, `${step}.sh`), `#!/usr/bin/env bash\ntouch "${marks}/${step}"\n`);
                chmodSync(join(hooks, `${step}.sh`), 0o755);
            }
            return { hooks, marks };
        }
        const dispatch = (hooks, env) => spawnSync('bash', [join(hooks, 'agent-spawn-dispatch.sh')], { input: payload(), env, encoding: 'utf8', timeout: 30_000 });
        it('returns the rework deny and runs no PREPARE step', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            const { hooks, marks } = dispatcherRoot();
            const r = dispatch(hooks, f.env);
            assert.equal(r.status, 0);
            assert.match(denyReason(r.stdout.trim()), /2 review FAILs/);
            assert.equal(existsSync(join(marks, 'ensure-swe-worktree')), false, 'ensure-swe-worktree.sh did not run');
            assert.equal(existsSync(join(marks, 'record-swe-spawn')), false, 'record-swe-spawn.sh did not run');
        });
        it('passes after a decision and runs the PREPARE steps', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ kind: 'decision', at: AFTER_LATEST_FAIL });
            const { hooks, marks } = dispatcherRoot();
            const r = dispatch(hooks, f.env);
            assert.equal(r.status, 0);
            assert.equal(r.stdout.trim(), '');
            assert.equal(existsSync(join(marks, 'ensure-swe-worktree')), true, 'ensure-swe-worktree.sh ran');
            assert.equal(existsSync(join(marks, 'record-swe-spawn')), true, 'record-swe-spawn.sh ran');
        });
    });
});
//# sourceMappingURL=hooks-rework-limit.test.js.map