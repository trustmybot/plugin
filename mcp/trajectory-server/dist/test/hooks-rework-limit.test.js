/**
 * The rework-limit gate (GH 1738, GH 2148) on a temp trajectory DB: a swe
 * spawn is denied once the task has two review FAILs since its last pass, six
 * swe runs (budget handbacks aside), or its issue four FAILs across its tasks
 * with no later pass on the same task, each counted since the latest Human waiver (an author 'human', kind
 * 'decision' row) on the task or its issue; no agent-written row and no Human
 * note lifts it. agent-spawn-dispatch.sh returns that deny
 * before any PREPARE step.
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
import { ISSUE_FAIL_LIMIT, REWORK_FAIL_LIMIT, SWE_RUN_LIMIT } from '../task-rework.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const OTHER_ISSUE_ID = 10;
const TASK_ID = 3;
const OTHER_TASK_ID = 4;
const FRESH_TASK_ID = 5;
const ELSEWHERE_TASK_ID = 6;
let sandbox;
let seq = 0;
/** Every row gets the next minute of a clock, so insertion order is created_at order. */
function fixture() {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const db = join(root, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    for (const id of [ISSUE_ID, OTHER_ISSUE_ID]) {
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(id);
    }
    for (const [id, issue] of [
        [TASK_ID, ISSUE_ID],
        [OTHER_TASK_ID, ISSUE_ID],
        [FRESH_TASK_ID, ISSUE_ID],
        [ELSEWHERE_TASK_ID, OTHER_ISSUE_ID],
    ]) {
        d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', 'running', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(id, issue, `feat/${id}-x`);
    }
    d.close();
    let minute = 0;
    const tick = () => {
        minute += 1;
        return new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + minute * 60_000).toISOString();
    };
    const write = (sql, ...params) => {
        const w = new DatabaseSync(db);
        w.prepare(sql).run(...params);
        w.close();
    };
    let attempt = 0;
    const verdictsOn = (taskId, ...list) => {
        for (const verdict of list) {
            attempt += 1;
            write("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 'f', 1, ?)", taskId, attempt, verdict, tick());
        }
    };
    const runs = (n, { stopCause = null, exitReason = 'completed' } = {}) => {
        for (let i = 0; i < n; i += 1) {
            const at = tick();
            write("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, exit_reason, stop_cause) VALUES (?, ?, 'swe', ?, ?, ?, ?)", TASK_ID, ISSUE_ID, at, at, exitReason, stopCause);
        }
    };
    const discuss = ({ author = 'bro', kind = 'note', taskId = TASK_ID }) => {
        write('INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)', ISSUE_ID, author, kind, 'b', tick(), taskId);
    };
    return { db, env, verdicts: (...list) => verdictsOn(TASK_ID, ...list), verdictsOn, runs, discuss };
}
const payload = (subagent = 'swe', prompt = `task_id=${TASK_ID} do the thing`) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: subagent, prompt } });
function run(f, input = payload()) {
    return reworkLimit(input, f.env);
}
const spawnOf = (f, taskId) => run(f, payload('swe', `task_id=${taskId} go`));
function denyReason(stdout) {
    assert.notEqual(stdout, '', 'expected a deny');
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
function assertHumanOnlyWaiver(reason, taskId) {
    assert.ok(reason.includes(`waive task ${taskId}`), reason);
    assert.doesNotMatch(reason, /discussion_append/);
    assert.doesNotMatch(reason, /decision/i);
}
const ALLOWED = { stdout: '', code: 0 };
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
    it('keeps the limits as named constants', () => {
        assert.equal(REWORK_FAIL_LIMIT, 2);
        assert.equal(SWE_RUN_LIMIT, 6);
        assert.equal(ISSUE_FAIL_LIMIT, 4);
    });
    describe('task FAILs', () => {
        it('denies a swe spawn after two FAILs, naming the limit, its count and the Human waiver', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            const reason = denyReason(run(f).stdout);
            assert.match(reason, /task 3 is at the rework limit/);
            assert.match(reason, /task FAILs: 2 review FAILs on the task since its last pass \(limit 2\)/);
            assert.doesNotMatch(reason, /task runs:|issue FAILs:/);
            assertHumanOnlyWaiver(reason, TASK_ID);
        });
        it('a newer kind=decision row by bro, on the task or the issue, does not lift it', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ kind: 'decision' });
            denyReason(run(f).stdout);
            f.discuss({ kind: 'decision', taskId: null });
            denyReason(run(f).stdout);
            f.discuss({ kind: 'note' });
            denyReason(run(f).stdout);
        });
        it('a newer Human row on the task lifts it', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision' });
            assert.deepEqual(run(f), ALLOWED);
        });
        it('a newer issue-level Human row lifts it', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision', taskId: null });
            assert.deepEqual(run(f), ALLOWED);
        });
        it('a Human row on another task of the issue does not lift it', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision', taskId: OTHER_TASK_ID });
            denyReason(run(f).stdout);
        });
        it('counts the FAILs after the latest Human row afresh', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision' });
            f.verdicts('fail');
            assert.deepEqual(run(f), ALLOWED);
            f.verdicts('fail');
            const reason = denyReason(run(f).stdout);
            assert.match(reason, /task FAILs: 2 review FAILs/);
            assert.match(reason, /since the Human's last waiver at 2026-10-25T10:03:00\.000Z/);
        });
        it('counts only the FAILs after the latest pass', () => {
            const f = fixture();
            f.verdicts('fail', 'fail', 'pass', 'fail');
            assert.deepEqual(run(f), ALLOWED);
            f.verdicts('fail');
            assert.match(denyReason(run(f).stdout), /task FAILs: 2 review FAILs on the task since its last pass/);
        });
    });
    describe('task runs', () => {
        it('denies a seventh swe run with no FAILs, naming the limit and its count', () => {
            const f = fixture();
            f.runs(5);
            assert.deepEqual(run(f), ALLOWED);
            f.runs(1);
            const reason = denyReason(run(f).stdout);
            assert.match(reason, /task runs: 6 swe runs of the task, budget handbacks aside \(limit 6\)/);
            assert.doesNotMatch(reason, /task FAILs:|issue FAILs:/);
            assertHumanOnlyWaiver(reason, TASK_ID);
        });
        it('does not count budget handbacks or swept orphans', () => {
            const f = fixture();
            f.runs(5);
            f.runs(3, { stopCause: 'budget' });
            f.runs(2, { exitReason: 'swept_orphan' });
            assert.deepEqual(run(f), ALLOWED);
            f.runs(1, { stopCause: 'hook_block' });
            denyReason(run(f).stdout);
        });
        it('a newer Human row resets the count; a bro decision does not', () => {
            const f = fixture();
            f.runs(6);
            f.discuss({ kind: 'decision' });
            denyReason(run(f).stdout);
            f.discuss({ author: 'human', kind: 'decision', taskId: null });
            assert.deepEqual(run(f), ALLOWED);
            f.runs(5);
            assert.deepEqual(run(f), ALLOWED);
            f.runs(1);
            assert.match(denyReason(run(f).stdout), /task runs: 6 swe runs/);
        });
    });
    describe('issue FAILs', () => {
        it('denies a spawn of a fresh task once the issue has four unresolved FAILs across its tasks', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
            f.verdictsOn(TASK_ID, 'fail');
            f.verdictsOn(ELSEWHERE_TASK_ID, 'fail');
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
            f.verdictsOn(OTHER_TASK_ID, 'fail');
            const reason = denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
            assert.match(reason, /task 5 is at the rework limit/);
            assert.match(reason, /issue FAILs: 4 review FAILs across the issue's tasks \(limit 4\)/);
            assert.doesNotMatch(reason, /task FAILs:|task runs:/);
            assertHumanOnlyWaiver(reason, FRESH_TASK_ID);
            denyReason(spawnOf(f, TASK_ID).stdout);
            assert.deepEqual(spawnOf(f, ELSEWHERE_TASK_ID), ALLOWED);
        });
        it('allows every task of an issue whose FAILs all have a later pass on the same task, however many', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'pass', 'fail', 'fail', 'pass');
            f.verdictsOn(TASK_ID, 'fail', 'pass', 'fail', 'fail', 'fail', 'pass');
            for (const taskId of [FRESH_TASK_ID, TASK_ID, OTHER_TASK_ID]) {
                assert.deepEqual(spawnOf(f, taskId), ALLOWED);
            }
        });
        it('a FAIL after a task\'s latest pass counts again', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'pass', 'fail', 'fail');
            f.verdictsOn(TASK_ID, 'fail', 'pass', 'fail');
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
            f.verdictsOn(TASK_ID, 'fail');
            assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
        });
        it('a pass on one task does not clear the FAILs on another', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
            f.verdictsOn(TASK_ID, 'fail', 'fail');
            f.verdictsOn(FRESH_TASK_ID, 'pass');
            assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
            f.verdictsOn(TASK_ID, 'pass');
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
        });
        it('a newer issue-level Human row lifts it for every task', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
            denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
            f.discuss({ kind: 'decision', taskId: null });
            denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
            f.discuss({ author: 'human', kind: 'decision', taskId: null });
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
            assert.deepEqual(spawnOf(f, TASK_ID), ALLOWED);
        });
        it('counts unresolved FAILs afresh after the latest Human row', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision', taskId: null });
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail');
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
            f.verdictsOn(TASK_ID, 'fail');
            assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
        });
        it('a newer Human row on the task being spawned lifts it for that task only', () => {
            const f = fixture();
            f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision', taskId: FRESH_TASK_ID });
            assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
            denyReason(spawnOf(f, TASK_ID).stdout);
        });
    });
    it('names every limit that tripped', () => {
        const f = fixture();
        f.runs(6);
        f.verdicts('fail', 'fail');
        f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
        const reason = denyReason(run(f).stdout);
        assert.match(reason, /task FAILs: 2 .*; task runs: 6 .*; issue FAILs: 4 /);
        assertHumanOnlyWaiver(reason, TASK_ID);
    });
    it("a newer author 'human' kind 'note' row (pr_monitor's shape for a login named human) resets none of the three limits", () => {
        const f = fixture();
        f.runs(6);
        f.verdicts('fail', 'fail');
        f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
        f.discuss({ author: 'human', kind: 'note' });
        f.discuss({ author: 'human', kind: 'note', taskId: null });
        const reason = denyReason(run(f).stdout);
        assert.match(reason, /task FAILs: 2 .*; task runs: 6 .*; issue FAILs: 4 /);
        assert.doesNotMatch(reason, /since the Human's last waiver/);
        f.discuss({ author: 'human', kind: 'decision' });
        assert.deepEqual(run(f), ALLOWED);
    });
    it('allows one FAIL, no FAIL, an unknown task, a non-swe spawn, a non-Agent tool and a prompt without task_id', () => {
        const f = fixture();
        assert.deepEqual(run(f), ALLOWED);
        f.verdicts('fail');
        assert.deepEqual(run(f), ALLOWED);
        f.verdicts('fail');
        assert.deepEqual(run(f, payload('swe', 'task_id=999')), ALLOWED);
        assert.deepEqual(run(f, payload('code-reviewer')), ALLOWED);
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
            f.discuss({ kind: 'decision' });
            const { hooks, marks } = dispatcherRoot();
            const r = dispatch(hooks, f.env);
            assert.equal(r.status, 0);
            assert.match(denyReason(r.stdout.trim()), /task FAILs: 2 review FAILs/);
            assert.equal(existsSync(join(marks, 'ensure-swe-worktree')), false, 'ensure-swe-worktree.sh did not run');
            assert.equal(existsSync(join(marks, 'record-swe-spawn')), false, 'record-swe-spawn.sh did not run');
        });
        it('passes after a Human waiver and runs the PREPARE steps', () => {
            const f = fixture();
            f.verdicts('fail', 'fail');
            f.discuss({ author: 'human', kind: 'decision' });
            const { hooks, marks } = dispatcherRoot();
            const r = dispatch(hooks, f.env);
            assert.equal(r.status, 0);
            assert.equal(r.stdout.trim(), '');
            assert.equal(existsSync(join(marks, 'ensure-swe-worktree')), true, 'ensure-swe-worktree.sh ran');
            assert.equal(existsSync(join(marks, 'record-swe-spawn')), true, 'record-swe-spawn.sh ran');
        });
    });
    describe('hook docs', () => {
        for (const [doc, stale] of [
            ['scripts/hooks/README.md', 'a decision naming the change of approach'],
            ['scripts/hooks/agent-spawn-dispatch.sh', 'needs a newer decision'],
        ]) {
            it(`${doc} names the Human-only waiver and no decision-row escape`, () => {
                const text = readFileSync(join(PLUGIN_ROOT, doc), 'utf8');
                assert.equal(text.includes(stale), false, `${doc} still says "${stale}"`);
                assert.ok(text.includes('waive task'), `${doc} names \`waive task <N>\``);
            });
        }
    });
});
//# sourceMappingURL=hooks-rework-limit.test.js.map