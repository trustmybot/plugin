import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
function parse(r) {
    return JSON.parse(r.content[0].text);
}
async function call(handlers, name, args) {
    const h = handlers[name];
    assert.ok(h, `handler not found: ${name}`);
    return h(args);
}
describe('branch_id_propose', () => {
    const db = new TrajectoryDB(':memory:');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    it('maps "fix the auth crash" to fix/ prefix', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'fix the auth crash',
            objective: 'auth crash',
        });
        const out = parse(r);
        assert.equal(out['branch_id'], 'fix/auth-crash');
        assert.equal(out['triage'], 'simple');
    });
    it('maps "add export feature" to feat/ prefix', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'add export feature',
        });
        const out = parse(r);
        assert.equal(out['branch_id'], 'feat/add-export-feature');
    });
    it('flags architecture-touching intent as triage=difficult', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'add new public API for billing',
        });
        const out = parse(r);
        assert.equal(out['triage'], 'difficult');
    });
    it('rejects empty intent', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: '   ',
        });
        assert.equal(r.isError, true);
    });
    it('rejects non-bro caller', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'swe',
            intent: 'fix bug',
        });
        assert.equal(r.isError, true);
    });
});
describe('task_retry_batch', () => {
    it('clones a failed task with corrected spec, links rationale + audit', async () => {
        const db = new TrajectoryDB(':memory:');
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueResult = parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro',
            objective: 'composite retry test',
            description: 'desc',
        }));
        const issueId = String(issueResult['id']);
        // Pre-seed scope-gate question + branch_id_proposed audit so
        // task_create_batch is allowed.
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro',
            issue_id: issueId,
            author: 'bro',
            kind: 'question',
            body: 'scope?',
        });
        await call(audit.handlers, 'audit_log', {
            agent: 'bro',
            issue_id: issueId,
            kind: 'event',
            event_type: 'branch_id_proposed',
            from_node: 'bro',
            branch_id: 'fix/initial',
            summary: 'branch proposed',
        });
        const created = parse(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro',
            issue_id: issueId,
            tasks: [{
                    branch_id: 'fix/initial',
                    description: 'do thing',
                    success_criteria: 'thing done',
                    spec_body: 'placeholder',
                }],
        }));
        const failedId = String(created[0].id);
        // Mark it failed.
        await call(tasks.handlers, 'task_update_status', {
            agent: 'swe',
            task_id: failedId,
            status: 'failed',
        });
        const retry = await call(composites.handlers, 'task_retry_batch', {
            agent: 'bro',
            failed_task_id: failedId,
            new_branch_id: 'fix/initial-v2',
            corrected_spec_body: 'fixed approach',
            retry_rationale: 'wrong path; use approach B',
            description: 'retry desc',
            success_criteria: 'thing done correctly',
        });
        assert.equal(retry.isError, undefined);
        const out = parse(retry);
        assert.equal(out.branch_id, 'fix/initial-v2');
        const decisions = db.all(`SELECT body FROM discussions WHERE issue_id = ? AND kind = 'decision'`, [issueId]);
        assert.ok(decisions.some((d) => d.body.includes('Retry rationale')));
        const auditRows = db.all(`SELECT event_type FROM audit WHERE issue_id = ?`, [issueId]);
        assert.ok(auditRows.some((r) => r.event_type === 'task_retry_attempted'));
    });
    it('rejects retry on a task whose status is not failed', async () => {
        const db = new TrajectoryDB(':memory:');
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_log', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/x', summary: 's',
        });
        const created = parse(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            tasks: [{ branch_id: 'fix/x', description: 'd', success_criteria: 'sc', spec_body: 's' }],
        }));
        const id = String(created[0].id);
        const r = await call(composites.handlers, 'task_retry_batch', {
            agent: 'bro',
            failed_task_id: id,
            new_branch_id: 'fix/x-v2',
            corrected_spec_body: 's',
            retry_rationale: 'r',
            description: 'd',
            success_criteria: 'sc',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /status is "pending"/);
    });
});
describe('bro_atomic_close', () => {
    it('rejects when task is not in completed/needs_validation', async () => {
        const db = new TrajectoryDB(':memory:');
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_log', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/x', summary: 's',
        });
        const created = parse(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            tasks: [{ branch_id: 'fix/x', description: 'd', success_criteria: 'sc', spec_body: 's' }],
        }));
        const id = String(created[0].id);
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro',
            task_id: id,
            commit_sha: 'abcdef1234567',
            file_summaries: [{ path: 'a.ts', summary: 's' }],
            verification_summary: 'ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /expected "completed" or "needs_validation"/);
    });
    it('rejects malformed commit_sha', async () => {
        const db = new TrajectoryDB(':memory:');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro',
            task_id: '1',
            commit_sha: 'not-a-sha',
            file_summaries: [{ path: 'a.ts', summary: 's' }],
            verification_summary: 'ok',
        });
        assert.equal(r.isError, true);
    });
    it('rejects empty file_summaries', async () => {
        const db = new TrajectoryDB(':memory:');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro',
            task_id: '1',
            commit_sha: 'abcdef1',
            file_summaries: [],
            verification_summary: 'ok',
        });
        assert.equal(r.isError, true);
    });
    it('rejects non-bro caller', async () => {
        const db = new TrajectoryDB(':memory:');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'swe',
            task_id: '1',
            commit_sha: 'abcdef1',
            file_summaries: [{ path: 'a.ts', summary: 's' }],
            verification_summary: 'ok',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
});
//# sourceMappingURL=composites.test.js.map