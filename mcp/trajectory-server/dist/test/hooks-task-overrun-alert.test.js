/**
 * The task-overrun-alert gate (GH 1738) on a temp trajectory DB with a fixture
 * clock: a running task past the threshold alerts bro once, writing one
 * task_overrun_alerted audit row; a task under the threshold, a non-bro
 * caller and a second call stay silent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeTaskOverrunAlert, OVERRUN_ENV, taskOverrunAlert } from '../hooks/task-overrun-alert.js';
import { findGate, gateNames } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const NOW = new Date('2026-10-25T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
let sandbox;
let seq = 0;
function fixture() {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const db = join(root, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', ?, ?)").run(ISSUE_ID, minutesAgo(600), minutesAgo(600));
    d.close();
    const exec = (sql, ...args) => {
        const w = new DatabaseSync(db);
        w.prepare(sql).run(...args);
        w.close();
    };
    let attempt = 0;
    return {
        db,
        env,
        task: (id, createdMinAgo, status = 'running') => exec("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, ?)", id, ISSUE_ID, `feat/${id}-x`, status, minutesAgo(createdMinAgo), minutesAgo(createdMinAgo)),
        sweRun: (taskId, exitReason = null) => exec("INSERT INTO agent_runs (task_id, issue_id, agent_type, exit_reason) VALUES (?, ?, 'swe', ?)", taskId, ISSUE_ID, exitReason),
        fail: (taskId, feedback) => {
            attempt += 1;
            exec("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', 'fail', ?, 1, ?)", taskId, attempt, feedback, minutesAgo(10));
        },
        alertRows: (taskId) => {
            const r = new DatabaseSync(db);
            const sql = "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'task_overrun_alerted'" +
                (taskId === undefined ? '' : ` AND json_extract(content_json, '$.task_id') = ${taskId}`);
            const n = r.prepare(sql).get().n;
            r.close();
            return n;
        },
    };
}
const gate = makeTaskOverrunAlert(() => NOW);
const broPrompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' });
function context(stdout) {
    assert.notEqual(stdout, '', 'expected an alert');
    const out = JSON.parse(stdout);
    return out.hookSpecificOutput.additionalContext;
}
describe('task-overrun-alert', () => {
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-overrun-'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
        assert.equal(findGate('task-overrun-alert'), taskOverrunAlert);
        assert.ok(gateNames().includes('task-overrun-alert'));
    });
    it('alerts bro once for a task running 61 min, then is silent on the next call', () => {
        const f = fixture();
        f.task(5, 61);
        f.sweRun(5);
        f.sweRun(5);
        f.sweRun(5, 'swept_orphan');
        f.fail(5, '\n  Missing changelog fragment\nsecond line');
        const first = gate(broPrompt, f.env);
        assert.equal(first.code, 0);
        const out = JSON.parse(first.stdout);
        assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
        assert.equal(out.hookSpecificOutput.additionalContext, 'TMB: task 5 has been running 61 min (attempts: 2 swe spawns; blocker: Missing changelog fragment). Decide with the Human whether to continue, redesign the spec or split the task.');
        assert.equal(f.alertRows(5), 1);
        assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
        assert.equal(f.alertRows(5), 1, 'the second call writes no row');
    });
    it('is silent for a task running 59 min', () => {
        const f = fixture();
        f.task(6, 59);
        assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
        assert.equal(f.alertRows(), 0);
    });
    it('is silent for a non-bro caller and writes no row', () => {
        const f = fixture();
        f.task(7, 61);
        const swe = JSON.stringify({ hook_event_name: 'PostToolUse', agent_type: 'swe', tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief' });
        assert.deepEqual(gate(swe, f.env), { stdout: '', code: 0 });
        assert.equal(f.alertRows(), 0);
    });
    it('one line per overrun task, the status as blocker without a FAIL, on the PostToolUse event; ignores non-running tasks', () => {
        const f = fixture();
        f.task(8, 90);
        f.task(3, 120);
        f.task(10, 200, 'closed');
        f.task(11, 30);
        const post = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_tmb_trajectory-server__task_list' });
        const out = JSON.parse(gate(post, f.env).stdout);
        assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
        const lines = out.hookSpecificOutput.additionalContext.split('\n');
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^TMB: task 3 has been running 120 min \(attempts: 0 swe spawns; blocker: status running\)/);
        assert.match(lines[1], /^TMB: task 8 has been running 90 min/);
        assert.equal(f.alertRows(3), 1);
        assert.equal(f.alertRows(8), 1);
        assert.equal(f.alertRows(), 2);
    });
    it(`${OVERRUN_ENV} overrides the threshold`, () => {
        const f = fixture();
        f.task(12, 16);
        assert.match(context(gate(broPrompt, { ...f.env, [OVERRUN_ENV]: '15' }).stdout), /task 12 has been running 16 min/);
    });
    it('is silent with no DB', () => {
        const env = { PATH: process.env.PATH, HOME: join(sandbox, 'nohome'), TRAJECTORY_DB_PATH: join(sandbox, 'absent.db'), CLAUDE_PROJECT_DIR: join(sandbox, 'noproj') };
        assert.deepEqual(gate(broPrompt, env), { stdout: '', code: 0 });
    });
});
//# sourceMappingURL=hooks-task-overrun-alert.test.js.map