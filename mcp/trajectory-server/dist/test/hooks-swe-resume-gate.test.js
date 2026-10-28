/**
 * The swe-resume-gate (GH 1742) on a temp trajectory DB: a SendMessage to a
 * swe is a resume of its task, denied at any rework limit with rework-limit's
 * reason and on an effort mismatch with the task, allowed otherwise; any other
 * target, or a swe of a closed task, passes with no output.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sweResumeGate } from '../hooks/swe-resume-gate.js';
import { reworkLimit } from '../hooks/rework-limit.js';
import { findGate, gateNames } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const TASK_ID = 3;
const SWE = 'agent-swe-1';
const ALLOWED = { stdout: '', code: 0 };
const AFTER_LATEST_FAIL = '2026-10-25T11:00:00.000Z';
let sandbox;
let seq = 0;
function fixture({ runEffort = 'medium', taskEffort = 'medium', status = 'running' } = {}) {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const db = join(root, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(ISSUE_ID);
    d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, effort, created_at, updated_at) VALUES (?, ?, 'feat/3-x', 'd', ?, ?, '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(TASK_ID, ISSUE_ID, status, taskEffort);
    d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason) VALUES (?, ?, 'swe', '2026-10-25T09:05:00.000Z', '2026-10-25T09:50:00.000Z', ?, ?, 'completed')").run(TASK_ID, ISSUE_ID, SWE, runEffort);
    d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (?, ?, 'code-reviewer', '2026-10-25T09:55:00.000Z', 'agent-reviewer-1')").run(TASK_ID, ISSUE_ID);
    d.close();
    const exec = (sql, ...params) => {
        const w = new DatabaseSync(db);
        w.prepare(sql).run(...params);
        w.close();
    };
    let attempt = 0;
    const fails = (n) => {
        for (let i = 0; i < n; i += 1) {
            attempt += 1;
            exec("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', 'fail', 'f', 1, ?)", TASK_ID, attempt, `2026-10-25T10:0${attempt}:00.000Z`);
        }
    };
    return { db, env, exec, fails };
}
const sendMessage = (to) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to, message: 'fix the FAIL findings' } });
const spawnPayload = () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'swe', prompt: `task_id=${TASK_ID} go` } });
function run(f, input = sendMessage(SWE)) {
    return sweResumeGate(input, f.env);
}
function denyReason(stdout) {
    assert.notEqual(stdout, '', 'expected a deny');
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
describe('swe-resume-gate', () => {
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-swe-resume-gate-'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
        assert.equal(findGate('swe-resume-gate'), sweResumeGate);
        assert.ok(gateNames().includes('swe-resume-gate'));
    });
    it('denies a resume after two FAILs, with the spawn gate reason', () => {
        const f = fixture();
        f.fails(2);
        const reason = denyReason(run(f).stdout);
        assert.equal(reason, denyReason(reworkLimit(spawnPayload(), f.env).stdout));
        assert.match(reason, /task FAILs: 2 review FAILs on the task since its last pass \(limit 2\)/);
        assert.match(reason, /waive task 3/);
    });
    it('still denies the resume after a newer kind=decision row by bro', () => {
        const f = fixture();
        f.fails(2);
        f.exec("INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, 'bro', 'decision', 'b', ?, ?)", ISSUE_ID, AFTER_LATEST_FAIL, TASK_ID);
        denyReason(run(f).stdout);
    });
    it('allows the resume after a newer Human decision row on the task or on its issue', () => {
        const f = fixture();
        f.fails(2);
        f.exec("INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, 'human', 'decision', 'b', ?, ?)", ISSUE_ID, AFTER_LATEST_FAIL, TASK_ID);
        assert.deepEqual(run(f), ALLOWED);
        const g = fixture();
        g.fails(2);
        g.exec("INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'human', 'decision', 'b', ?)", ISSUE_ID, AFTER_LATEST_FAIL);
        assert.deepEqual(run(g), ALLOWED);
    });
    it('denies a resume at six swe runs with no FAILs, budget handbacks aside, until a Human decision row', () => {
        const f = fixture();
        const addRun = (startedAt, stopCause) => f.exec("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason, stop_cause) VALUES (?, ?, 'swe', ?, ?, ?, 'medium', 'completed', ?)", TASK_ID, ISSUE_ID, startedAt, startedAt, `agent-swe-extra-${startedAt}`, stopCause);
        for (let i = 1; i <= 4; i += 1)
            addRun(`2026-10-25T10:1${i}:00.000Z`, null);
        addRun('2026-10-25T10:20:00.000Z', 'budget');
        assert.deepEqual(run(f), ALLOWED);
        addRun('2026-10-25T10:21:00.000Z', 'hook_block');
        const reason = denyReason(run(f).stdout);
        assert.equal(reason, denyReason(reworkLimit(spawnPayload(), f.env).stdout));
        assert.match(reason, /task runs: 6 swe runs of the task, budget handbacks aside \(limit 6\)/);
        f.exec("INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'human', 'decision', 'b', ?)", ISSUE_ID, AFTER_LATEST_FAIL);
        assert.deepEqual(run(f), ALLOWED);
    });
    it('allows a resume under the limit at the task effort', () => {
        const f = fixture();
        f.fails(1);
        assert.deepEqual(run(f), ALLOWED);
    });
    it('denies an effort mismatch, naming a fresh spawn at the task effort', () => {
        const f = fixture({ runEffort: 'low', taskEffort: 'high' });
        const reason = denyReason(run(f).stdout);
        assert.match(reason, /swe agent-swe-1 ran task 3 at effort low; the task's effort is now high/);
        assert.match(reason, /Spawn a fresh swe at the task's effort instead: Agent\(subagent_type='swe', effort='high'/);
    });
    it('judges the swe by its latest run of the task', () => {
        const f = fixture({ runEffort: 'low', taskEffort: 'high' });
        f.exec("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, effort, resumed_from) VALUES (?, ?, 'swe', '2026-10-25T10:30:00.000Z', ?, 'high', 1)", TASK_ID, ISSUE_ID, SWE);
        assert.deepEqual(run(f), ALLOWED);
    });
    it('passes with no output for a non-swe target, an unknown agent id, a closed task and another tool', () => {
        const f = fixture({ runEffort: 'low', taskEffort: 'high' });
        f.fails(2);
        assert.deepEqual(run(f, sendMessage('agent-reviewer-1')), ALLOWED);
        assert.deepEqual(run(f, sendMessage('agent-nobody')), ALLOWED);
        assert.deepEqual(run(f, sendMessage('')), ALLOWED);
        assert.deepEqual(run(f, spawnPayload()), ALLOWED);
        const closed = fixture({ runEffort: 'low', taskEffort: 'high', status: 'closed' });
        closed.fails(2);
        assert.deepEqual(run(closed), ALLOWED);
    });
    it('denies when the DB cannot be read', () => {
        const f = fixture();
        writeFileSync(f.db, 'not a database');
        assert.match(denyReason(run(f).stdout), /trajectory DB unavailable — swe-resume-gate/);
    });
    it('runs through node dist/hooks.js', () => {
        const f = fixture();
        f.fails(2);
        const r = spawnSync('node', [join(SERVER_ROOT, 'dist/hooks.js'), 'swe-resume-gate'], {
            input: sendMessage(SWE),
            env: f.env,
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.equal(r.status, 0);
        assert.match(denyReason(r.stdout.trim()), /task FAILs: 2 review FAILs on the task since its last pass/);
    });
});
//# sourceMappingURL=hooks-swe-resume-gate.test.js.map