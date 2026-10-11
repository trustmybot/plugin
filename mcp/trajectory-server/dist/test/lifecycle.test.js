import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { compositeTools } from '../tools/composites.js';
import { reportTools } from '../tools/reports.js';
import { branchReportMdTools } from '../tools/branch_report_md.js';
import { taskHasPassingReview } from '../tools/lifecycle.js';
const DB_PATH = '/tmp/.claude/tmb/trajectory.db';
function parse(r) {
    return JSON.parse(r.content[0].text);
}
async function call(handlers, name, args) {
    const h = handlers[name];
    assert.ok(h, `handler not found: ${name}`);
    return (await h(args));
}
function iso(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString();
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function seedIssue(db, ghIid = null) {
    db.run(`INSERT INTO issues (objective, status, created_at, updated_at, gh_iid, remote_kind) VALUES ('lifecycle', 'open', ?, ?, ?, ?)`, [iso(0), iso(0), ghIid, ghIid === null ? null : 'github']);
    return db.get('SELECT MAX(id) AS id FROM issues').id;
}
function seedTask(db, issueId, status, opts = {}) {
    const branch = opts.branch ?? `fix/t-${Math.random().toString(36).slice(2, 8)}`;
    db.run(`INSERT INTO tasks (issue_id, branch_id, description, status, commit_sha, created_at, updated_at, completed_at)
     VALUES (?, ?, 'd', ?, ?, ?, ?, ?)`, [issueId, branch, status, opts.commit ?? null, iso(-DAY), opts.updatedAt ?? iso(0), opts.completedAt ?? null]);
    return db.get('SELECT MAX(id) AS id FROM tasks').id;
}
function openRun(db, taskId, agentType) {
    db.run(`INSERT INTO agent_runs (task_id, agent_type, started_at) VALUES (?, ?, ?)`, [taskId, agentType, iso(-HOUR)]);
}
function recordVerdict(db, taskId, verdict, at) {
    const n = (db.get('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ?', [taskId])?.n ?? 0) + 1;
    db.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'pr-reviewer', ?, 1, ?)`, [taskId, n, verdict, at]);
}
function recordVerificationPass(db, issueId, taskId, sha, at) {
    db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'bro_verification_pass', 'ok', ?, ?)`, [issueId, JSON.stringify({ task_id: taskId, commit_sha: sha }), at]);
}
function auditRows(db, eventType) {
    return db
        .all('SELECT content_json, from_node FROM audit WHERE event_type = ? ORDER BY id', [eventType])
        .map((r) => ({ content: JSON.parse(r.content_json), from_node: r.from_node }));
}
function taskStatus(db, id) {
    return db.get('SELECT status FROM tasks WHERE id = ?', [id]).status;
}
function issueStatus(db, id) {
    return db.get('SELECT status FROM issues WHERE id = ?', [id]).status;
}
describe('issue_close: refuse or cascade', () => {
    it('refuses with issue_has_open_tasks listing the live task ids + statuses', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const running = seedTask(db, issue, 'running');
        const completed = seedTask(db, issue, 'completed', { commit: 'abc1234' });
        seedTask(db, issue, 'failed');
        const tools = issueTools(db, DB_PATH);
        const r = await call(tools.handlers, 'issue_close', { agent: 'bro', issue_id: String(issue) });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'issue_has_open_tasks');
        assert.deepEqual(out['tasks'], [
            { task_id: running, status: 'running' },
            { task_id: completed, status: 'completed' },
        ]);
        assert.equal(issueStatus(db, issue), 'open');
        db.close();
    });
    it('cascade escalates live tasks, closes their runs issue_closed, audits each, then closes remote once after local', async () => {
        const db = tempDB();
        const issue = seedIssue(db, 77);
        const pending = seedTask(db, issue, 'pending');
        const running = seedTask(db, issue, 'running');
        const needsValidation = seedTask(db, issue, 'needs_validation');
        const completed = seedTask(db, issue, 'completed', { commit: 'abc1234' });
        const failed = seedTask(db, issue, 'failed');
        openRun(db, running, 'swe');
        openRun(db, running, 'bro');
        openRun(db, completed, 'bro');
        const spawns = [];
        const spawnFn = (_cmd, args) => {
            spawns.push({ args, issueStatusAtSpawn: issueStatus(db, issue) });
            return { status: 0, stdout: '', stderr: '' };
        };
        const tools = issueTools(db, DB_PATH);
        const r = await call(tools.handlers, 'issue_close', {
            agent: 'bro', issue_id: String(issue), cascade: true, reason: 'superseded by a new plan', _spawnFn: spawnFn,
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.deepEqual(parse(r)['tasks_escalated'], [pending, running, needsValidation, completed]);
        for (const id of [pending, running, needsValidation, completed]) {
            assert.equal(taskStatus(db, id), 'escalated', `task ${id} escalated`);
        }
        assert.equal(taskStatus(db, failed), 'failed', 'terminal tasks are untouched');
        const runs = db.all('SELECT completed_at, exit_reason FROM agent_runs ORDER BY id');
        assert.equal(runs.length, 3);
        assert.ok(runs.every((x) => x.completed_at !== null && x.exit_reason === 'issue_closed'));
        const audits = auditRows(db, 'task_escalated_by_issue_close');
        assert.deepEqual(audits.map((a) => a.content), [
            { task_id: pending, from_status: 'pending', reason: 'superseded by a new plan' },
            { task_id: running, from_status: 'running', reason: 'superseded by a new plan' },
            { task_id: needsValidation, from_status: 'needs_validation', reason: 'superseded by a new plan' },
            { task_id: completed, from_status: 'completed', reason: 'superseded by a new plan' },
        ]);
        assert.equal(issueStatus(db, issue), 'closed');
        const closes = spawns.filter((s) => s.args[0] === 'issue' && s.args[1] === 'close');
        assert.equal(closes.length, 1, 'remote close called once');
        assert.equal(closes[0].issueStatusAtSpawn, 'closed', 'remote close runs after the local close committed');
        db.close();
    });
    it('a refused close calls no remote', async () => {
        const db = tempDB();
        const issue = seedIssue(db, 78);
        seedTask(db, issue, 'pending');
        let spawned = 0;
        const tools = issueTools(db, DB_PATH);
        const r = await call(tools.handlers, 'issue_close', {
            agent: 'bro', issue_id: String(issue), _spawnFn: () => { spawned++; return { status: 0, stdout: '', stderr: '' }; },
        });
        assert.equal(r.isError, true);
        assert.equal(spawned, 0);
        db.close();
    });
});
describe('issue_close: review evidence for closed tasks', () => {
    it('refuses with tasks_without_review when a closed task has no pass', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-2 * HOUR) });
        recordVerificationPass(db, issue, t, 'abc1234', iso(-HOUR));
        const tools = issueTools(db, DB_PATH);
        const r = await call(tools.handlers, 'issue_close', { agent: 'bro', issue_id: String(issue) });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'tasks_without_review');
        assert.deepEqual(out['tasks'], [{ task_id: t, commit_sha: 'abc1234' }]);
        assert.equal(issueStatus(db, issue), 'open');
        db.close();
    });
    it('closes when the pass is newer than the bro_verification_pass of the current commit', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-3 * HOUR) });
        recordVerificationPass(db, issue, t, 'abc1234', iso(-2 * HOUR));
        recordVerdict(db, t, 'pass', iso(-HOUR));
        assert.equal(taskHasPassingReview(db, t), true);
        const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issue) });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(issueStatus(db, issue), 'closed');
        db.close();
    });
    it('refuses when the only pass is older than the commit (re-verified at a new sha)', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'def5678', completedAt: iso(-5 * HOUR) });
        recordVerificationPass(db, issue, t, 'abc1234', iso(-4 * HOUR));
        recordVerdict(db, t, 'pass', iso(-3 * HOUR));
        recordVerificationPass(db, issue, t, 'def5678', iso(-2 * HOUR));
        assert.equal(taskHasPassingReview(db, t), false);
        const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issue) });
        assert.equal(parse(r)['error'], 'tasks_without_review');
        db.close();
    });
    it('a fail verdict is not a pass', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-2 * HOUR) });
        recordVerdict(db, t, 'fail', iso(-HOUR));
        assert.equal(taskHasPassingReview(db, t), false);
        db.close();
    });
    it('falls back to completed_at when no bro_verification_pass names the commit', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        recordVerdict(db, t, 'pass', iso(-2 * HOUR));
        assert.equal(taskHasPassingReview(db, t), false, 'a pass before completion does not count');
        recordVerdict(db, t, 'pass', iso(-HOUR / 2));
        assert.equal(taskHasPassingReview(db, t), true);
        db.close();
    });
    it('waive_review + reason closes and writes review_gate_waived per task', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', {
            agent: 'bro', issue_id: String(issue), waive_review: true, waive_review_reason: 'docs-only change, reviewed by Human',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(issueStatus(db, issue), 'closed');
        assert.deepEqual(parse(r)['review_waived_tasks'], [t]);
        const rows = auditRows(db, 'review_gate_waived');
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].content, {
            skill: 'issue_close', task_id: t, commit_sha: 'abc1234', waive_review_reason: 'docs-only change, reviewed by Human',
        });
        db.close();
    });
    it('rejects a waiver reason shorter than 10 chars', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        seedTask(db, issue, 'closed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', {
            agent: 'bro', issue_id: String(issue), waive_review: true, waive_review_reason: 'short',
        });
        assert.equal(r.isError, true);
        assert.match(String(parse(r)['error']), /waive_review_reason/);
        assert.equal(issueStatus(db, issue), 'open');
        assert.equal(auditRows(db, 'review_gate_waived').length, 0);
        db.close();
    });
    it('a task whose bypass is already recorded does not block the close', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'escalated', { commit: 'abc1234' });
        const tasks = taskTools(db);
        const r = await call(tasks.handlers, 'task_update_status', { agent: 'bro', task_id: String(t), status: 'closed' });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const close = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issue) });
        assert.ok(!close.isError, JSON.stringify(parse(close)));
        db.close();
    });
});
describe('review_gate_bypassed on non-atomic closes', () => {
    it('task_update_status → closed without a pass writes review_gate_bypassed', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'escalated', { commit: 'abc1234' });
        const r = await call(taskTools(db).handlers, 'task_update_status', { agent: 'bro', task_id: String(t), status: 'closed' });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(taskStatus(db, t), 'closed');
        const rows = auditRows(db, 'review_gate_bypassed');
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].content, { task_id: t, commit_sha: 'abc1234', closed_by: 'task_update_status' });
        assert.equal(rows[0].from_node, 'bro');
        db.close();
    });
    it('task_update_status → closed with a pass writes no bypass row', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'escalated', { commit: 'abc1234' });
        recordVerdict(db, t, 'pass', iso(-HOUR));
        await call(taskTools(db).handlers, 'task_update_status', { agent: 'bro', task_id: String(t), status: 'closed' });
        assert.equal(taskStatus(db, t), 'closed');
        assert.equal(auditRows(db, 'review_gate_bypassed').length, 0);
        db.close();
    });
    it('task_recover closing at a commit without a pass writes review_gate_bypassed', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'completed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'task_recover', {
            agent: 'bro', task_id: String(t), commit_sha: 'abc1234',
        }));
        assert.equal(out['action'], 'closed');
        assert.equal(out['review_gate_bypassed'], true);
        assert.deepEqual(auditRows(db, 'review_gate_bypassed').map((r) => r.content), [
            { task_id: t, commit_sha: 'abc1234', closed_by: 'task_recover' },
        ]);
        db.close();
    });
});
describe('bro_atomic_close', () => {
    it('returns review_pending and writes no review_gate_bypassed', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'completed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'bro_atomic_close', {
            agent: 'bro', task_id: String(t), commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true,
        }));
        assert.equal(out['review_pending'], true);
        assert.equal(taskStatus(db, t), 'closed');
        assert.equal(auditRows(db, 'review_gate_bypassed').length, 0);
        db.close();
    });
    it('close_issue_if_last_task with a live sibling leaves the issue open and names the sibling', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'completed', { commit: 'abc1234', completedAt: iso(-HOUR) });
        const sibling = seedTask(db, issue, 'running');
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'bro_atomic_close', {
            agent: 'bro', task_id: String(t), commit_sha: 'abc1234', verification_summary: 'ok',
            waive_scope_gate: true, close_issue_if_last_task: true,
        }));
        assert.equal(out['issue_closed'], false);
        assert.deepEqual(out['issue_left_open'], {
            reason: 'issue_has_open_tasks', tasks: [{ task_id: sibling, status: 'running' }],
        });
        assert.equal(issueStatus(db, issue), 'open');
        assert.equal(taskStatus(db, sibling), 'running', 'never cascades silently');
        db.close();
    });
});
describe('task_recover stale sweep', () => {
    const saved = process.env['TMB_STALE_RUNNING_HOURS'];
    afterEach(() => {
        if (saved === undefined)
            delete process.env['TMB_STALE_RUNNING_HOURS'];
        else
            process.env['TMB_STALE_RUNNING_HOURS'] = saved;
    });
    it('sweeps stale running tasks with no open swe run, reports old pending, leaves the rest', async () => {
        delete process.env['TMB_STALE_RUNNING_HOURS'];
        const db = tempDB();
        const issue = seedIssue(db);
        const stale = seedTask(db, issue, 'running', { updatedAt: iso(-7 * HOUR) });
        openRun(db, stale, 'bro');
        const withSwe = seedTask(db, issue, 'running', { updatedAt: iso(-7 * HOUR) });
        openRun(db, withSwe, 'swe');
        const fresh = seedTask(db, issue, 'running', { updatedAt: iso(-5 * HOUR) });
        const oldPending = seedTask(db, issue, 'pending', { updatedAt: iso(-8 * DAY) });
        const newPending = seedTask(db, issue, 'pending', { updatedAt: iso(-6 * DAY) });
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'task_recover', { agent: 'bro' }));
        assert.deepEqual(out['tasks_swept'], [stale]);
        assert.equal(out['runs_swept'], 1);
        const reported = out['reported'];
        assert.deepEqual(reported.map((r) => r['task_id']), [oldPending]);
        assert.equal(taskStatus(db, stale), 'failed');
        assert.equal(taskStatus(db, withSwe), 'running');
        assert.equal(taskStatus(db, fresh), 'running');
        assert.equal(taskStatus(db, oldPending), 'pending', 'old pending is reported only');
        assert.equal(taskStatus(db, newPending), 'pending');
        const run = db.get('SELECT exit_reason FROM agent_runs WHERE task_id = ?', [stale]);
        assert.equal(run.exit_reason, 'swept_stale');
        const audits = auditRows(db, 'task_stale_swept');
        assert.equal(audits.length, 1);
        assert.equal(audits[0].content['task_id'], stale);
        assert.equal(audits[0].content['stale_after_hours'], 6);
        const again = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'task_recover', { agent: 'bro' }));
        assert.deepEqual(again['tasks_swept'], [], 'idempotent');
        db.close();
    });
    it('honours TMB_STALE_RUNNING_HOURS', async () => {
        process.env['TMB_STALE_RUNNING_HOURS'] = '2';
        const db = tempDB();
        const issue = seedIssue(db);
        const t = seedTask(db, issue, 'running', { updatedAt: iso(-3 * HOUR) });
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'task_recover', { agent: 'bro' }));
        assert.deepEqual(out['tasks_swept'], [t]);
        db.close();
    });
    it('a task_id call still reports the sweep alongside its recovery result', async () => {
        delete process.env['TMB_STALE_RUNNING_HOURS'];
        const db = tempDB();
        const issue = seedIssue(db);
        const stale = seedTask(db, issue, 'running', { updatedAt: iso(-7 * HOUR) });
        const pending = seedTask(db, issue, 'pending');
        const out = parse(await call(compositeTools(db, DB_PATH, null).handlers, 'task_recover', {
            agent: 'bro', task_id: String(pending),
        }));
        assert.equal(out['action'], 're-dispatch');
        assert.deepEqual(out['tasks_swept'], [stale]);
        assert.deepEqual(out['reported'], []);
        db.close();
    });
});
describe('progress counters count closed only', () => {
    it('issue_get_phase reports completed as awaiting close', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        seedTask(db, issue, 'closed');
        seedTask(db, issue, 'completed');
        const out = parse(await call(issueTools(db, DB_PATH).handlers, 'issue_get_phase', { agent: 'bro', issue_id: String(issue) }));
        assert.equal(out['phase'], 'tasks');
        assert.deepEqual(out['counts'], { tasks_total: 2, tasks_completed: 1, tasks_awaiting_close: 1, tasks_failed: 0 });
        db.close();
    });
    it('issue_report_md summary counts closed as done and completed as awaiting close', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        seedTask(db, issue, 'closed');
        seedTask(db, issue, 'completed');
        seedTask(db, issue, 'failed');
        const out = parse(await call(reportTools(db).handlers, 'issue_report_md', { agent: 'bro', issue_id: String(issue) }));
        assert.match(String(out['markdown']), /3 total, 1 done \(closed\), 1 awaiting close, 1 failed/);
        db.close();
    });
    it('branch_report_md labels completed tasks as awaiting close', async () => {
        const db = tempDB();
        const issue = seedIssue(db);
        seedTask(db, issue, 'completed', { branch: 'fix/one', completedAt: iso(-HOUR) });
        const out = parse(await call(branchReportMdTools(db).handlers, 'branch_report_md', {
            agent: 'bro', issue_id: String(issue), branch_id: 'fix/one',
        }));
        const md = String(out['markdown']);
        assert.match(md, /\*\*Done:\*\* 0 of 1 closed, 1 awaiting close/);
        assert.match(md, /completed \(awaiting close\)/);
        db.close();
    });
});
//# sourceMappingURL=lifecycle.test.js.map