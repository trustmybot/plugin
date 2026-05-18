import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
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
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    it('maps "fix the auth crash" to fix/ prefix', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'fix the auth crash',
            objective: 'auth crash',
        });
        const out = parse(r);
        assert.equal(out['branch_id'], 'fix/auth-crash');
    });
    it('maps "add export feature" to feat/ prefix', async () => {
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'add export feature',
        });
        const out = parse(r);
        assert.equal(out['branch_id'], 'feat/add-export-feature');
    });
    it('omits any triage field on the return shape', async () => {
        // The simple/difficult triage classifier was retired — branch_id_propose
        // returns only { branch_id, confidence } now.
        const r = await call(composites.handlers, 'branch_id_propose', {
            agent: 'bro',
            intent: 'add new public API for billing',
        });
        const out = parse(r);
        assert.equal(out['triage'], undefined);
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
        const db = tempDB();
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
            waive_intent_gate: true,
            waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true,
            waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            tasks: [{
                    branch_id: 'fix/initial',
                    description: 'do thing',
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
        const db = tempDB();
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
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
        }));
        const id = String(created[0].id);
        const r = await call(composites.handlers, 'task_retry_batch', {
            agent: 'bro',
            failed_task_id: id,
            new_branch_id: 'fix/x-v2',
            corrected_spec_body: 's',
            retry_rationale: 'r',
            description: 'd',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /status is "pending"/);
    });
});
describe('bro_atomic_close', () => {
    it('rejects when task is not in completed/needs_validation', async () => {
        const db = tempDB();
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
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
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
        const db = tempDB();
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
        const db = tempDB();
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
        const db = tempDB();
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
    it('sets closed_at on parent issue when close_issue_if_last_task=true (regression: Bug 1)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'bac-closed-at-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        writeFileSync(join(repoRoot, 'a.ts'), 'export const x = 1;\n');
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const composites = compositeTools(db, dbPath);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        try {
            const issueId = String((parse(await call(issues.handlers, 'issue_create', {
                agent: 'bro', objective: 'closed_at regression', description: 'x',
            }))['id']));
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_log', {
                agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
                from_node: 'bro', branch_id: 'fix/closed-at', summary: 's',
            });
            const created = parse(await call(tasks.handlers, 'task_create_batch', {
                agent: 'bro', issue_id: issueId,
                waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
                waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                tasks: [{ branch_id: 'fix/closed-at', description: 'd', spec_body: 's', repo: 'app' }],
            }));
            const taskId = String(created[0].id);
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'running',
            });
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
            });
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: taskId,
                commit_sha: 'abc1234',
                file_summaries: [{ path: 'a.ts', summary: 'fixed', repo: 'app' }],
                verification_summary: 'ok',
                close_issue_if_last_task: true,
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['issue_closed'], true);
            const row = db.get(`SELECT status, closed_at FROM issues WHERE id = ?`, [issueId]);
            assert.ok(row, 'issue row must exist');
            assert.equal(row.status, 'closed');
            assert.ok(row.closed_at !== null, 'closed_at must be set by bro_atomic_close auto-close');
        }
        finally {
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('headless_intent_start', () => {
    it('writes audit + note + intent in one transaction', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'headless test', description: 'x',
        }))['id']));
        const r = await call(composites.handlers, 'headless_intent_start', {
            agent: 'bro',
            issue_id: Number(issueId),
            branch_id: 'feat/headless-test',
            intent_verbatim: 'add export feature',
            fallback_summary: 'defaults applied: base_branch=dev',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.deepEqual(out['written'], ['audit', 'note', 'intent']);
        const auditRows = db.all(`SELECT event_type FROM audit WHERE issue_id = ?`, [issueId]);
        assert.ok(auditRows.some((a) => a.event_type === 'headless_fallback'));
        const discussions = db.all(`SELECT kind, body FROM discussions WHERE issue_id = ?`, [issueId]);
        assert.ok(discussions.some((d) => d.kind === 'note' && d.body.includes('Headless fallback')));
        assert.ok(discussions.some((d) => d.kind === 'intent' && d.body.includes('add export feature')));
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'headless_intent_start', {
            agent: 'swe', issue_id: 1, branch_id: 'feat/x', intent_verbatim: 'do thing',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects empty intent_verbatim', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'headless_intent_start', {
            agent: 'bro', issue_id: 1, branch_id: 'feat/x', intent_verbatim: '   ',
        });
        assert.equal(r.isError, true);
    });
});
describe('bro_verification_fail_record', () => {
    it('writes audit + note in one transaction', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'fail record test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_log', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/fail-rec', summary: 's',
        });
        const created = parse(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test; not under test',
            tasks: [{ branch_id: 'fix/fail-rec', description: 'd', spec_body: 's' }],
        }));
        const taskId = String(created[0].id);
        const r = await call(composites.handlers, 'bro_verification_fail_record', {
            agent: 'bro',
            task_id: taskId,
            which_check: 'V2 — tests',
            details: 'test_auth failed with exit code 1',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.deepEqual(out['written'], ['audit', 'note']);
        const auditRows = db.all(`SELECT event_type FROM audit WHERE issue_id = ?`, [issueId]);
        assert.ok(auditRows.some((a) => a.event_type === 'bro_verification_fail'));
        const notes = db.all(`SELECT kind, body FROM discussions WHERE issue_id = ? AND kind='note'`, [issueId]);
        assert.ok(notes.some((n) => n.body.includes('V2 — tests')));
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_verification_fail_record', {
            agent: 'pr-reviewer', task_id: '1', which_check: 'V2', details: 'failed',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects details exceeding 500 chars', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_verification_fail_record', {
            agent: 'bro', task_id: '1', which_check: 'V2', details: 'x'.repeat(501),
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /≤500/);
    });
    it('rejects missing task', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claire/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_verification_fail_record', {
            agent: 'bro', task_id: '99999', which_check: 'V3', details: 'not found',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /No task/);
    });
});
describe('pr_review_worktree', () => {
    it('rejects non-pr-reviewer caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_review_worktree', {
            agent: 'bro', commit_sha: 'abc1234', repo_path: '/tmp', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects malformed commit_sha', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_review_worktree', {
            agent: 'pr-reviewer', commit_sha: 'not-a-sha', repo_path: '/tmp', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /hex SHA/);
    });
    it('rejects relative repo_path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_review_worktree', {
            agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: 'relative/path', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /absolute path/);
    });
    it('rejects empty command', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_review_worktree', {
            agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: '/tmp', command: '   ',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /non-empty/);
    });
});
describe('reap_and_review_prep', () => {
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'reap_and_review_prep', {
            agent: 'swe', task_ids: ['1'], repo_path: '/tmp',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects empty task_ids', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'reap_and_review_prep', {
            agent: 'bro', task_ids: [], repo_path: '/tmp',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /non-empty/);
    });
    it('rejects relative repo_path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'reap_and_review_prep', {
            agent: 'bro', task_ids: ['1'], repo_path: 'relative',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /absolute/);
    });
    it('reports missing task in per-task result without throwing', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'reap_and_review_prep', {
            agent: 'bro', task_ids: ['99999'], repo_path: '/tmp',
        });
        assert.ok(!r.isError, `expected outer ok; got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out.reaped[0].reaped, false);
        assert.match(out.reaped[0].error, /No task/);
    });
});
// #2873-sibling: workspace-pattern multi-repo path resolution on
// bro_atomic_close.file_summaries. Per-update repo: explicit `repo` →
// task.repo → tmb_default_repo → error. Each test uses a tmp workspace
// shape with at least two on-disk inner repos and a trajectory DB at
// <ws>/.claude/tmb/trajectory.db so resolveDefaultRepo + the inner-repo
// path resolution exercise correctly.
describe('bro_atomic_close multi-repo file_summaries', () => {
    // Helper: build a workspace-pattern fixture with two inner repos, return
    // { ws, dbPath, repoARoot, repoBRoot, db, composites, taskFactory }.
    function makeMultiRepoFixture() {
        const ws = mkdtempSync(join(tmpdir(), 'bac-mr-'));
        const repoARoot = join(ws, 'app');
        const repoBRoot = join(ws, 'service');
        mkdirSync(repoARoot, { recursive: true });
        mkdirSync(repoBRoot, { recursive: true });
        // Touchable source files so disk-md5 path wins. `app` and `service`
        // each get one file at a known relative path.
        mkdirSync(join(repoARoot, 'src'), { recursive: true });
        writeFileSync(join(repoARoot, 'src', 'index.ts'), 'export const x = 1;\n');
        mkdirSync(join(repoBRoot, 'lib'), { recursive: true });
        writeFileSync(join(repoBRoot, 'lib', 'core.ts'), 'export const core = true;\n');
        // Workspace-pattern DB location: <ws>/.claude/tmb/trajectory.db.
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoARoot]);
        db.run(`INSERT INTO repos (name, path) VALUES ('service', ?)`, [repoBRoot]);
        const composites = compositeTools(db, dbPath);
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueFactory = async (objective) => {
            const out = parse(await call(issues.handlers, 'issue_create', {
                agent: 'bro',
                objective,
                description: 'multi-repo fixture',
            }));
            return out['id'];
        };
        const taskFactory = async (issueId, repo) => {
            // Satisfy decision_gate + branch_id_proposed gate first.
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro',
                issue_id: String(issueId),
                author: 'bro',
                kind: 'decision',
                body: 'multi-repo fixture decision',
            });
            await call(audit.handlers, 'audit_log', {
                agent: 'bro',
                issue_id: String(issueId),
                kind: 'event',
                event_type: 'branch_id_proposed',
                from_node: 'bro',
                branch_id: `fix/multi-repo-${issueId}`,
                summary: 'fixture',
            });
            const taskArgs = {
                agent: 'bro',
                issue_id: String(issueId),
                waive_intent_gate: true,
                waive_intent_gate_reason: 'unit-test fixture; intent gate not under test',
                waive_branch_gate: true,
                waive_branch_gate_reason: 'unit-test fixture; branch gate not under test',
                waive_scope_gate: true,
                waive_scope_gate_reason: 'unit-test fixture; scope-ambiguity gate not under test',
                tasks: [
                    {
                        branch_id: `fix/multi-repo-${issueId}`,
                        description: 'multi-repo fixture',
                        spec_body: 'fixture',
                        ...(repo !== null ? { repo } : {}),
                    },
                ],
            };
            const created = (await call(tasks.handlers, 'task_create_batch', taskArgs));
            const arr = parse(created);
            const id = arr[0].id;
            // Flip status so bro_atomic_close accepts the row.
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe',
                task_id: String(id),
                status: 'running',
            });
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe',
                task_id: String(id),
                status: 'completed',
                commit_sha: 'abc1234',
            });
            return id;
        };
        return {
            ws,
            dbPath,
            repoARoot,
            repoBRoot,
            db,
            composites,
            issueFactory,
            taskFactory,
            cleanup: () => {
                db.close();
                rmSync(ws, { recursive: true, force: true });
            },
        };
    }
    it('explicit `repo` on the file_summaries entry wins over task.repo + tmb_default_repo', async () => {
        const fx = makeMultiRepoFixture();
        try {
            fx.db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"app"')`);
            const issueId = await fx.issueFactory('explicit-repo wins');
            const taskId = await fx.taskFactory(issueId, 'app'); // task.repo='app'
            const result = await call(fx.composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: String(taskId),
                commit_sha: 'abc1234',
                // explicit repo='service' on the file_summaries entry — should win.
                file_summaries: [{ path: 'lib/core.ts', summary: 'core', repo: 'service' }],
                verification_summary: 'ok',
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parse(result))}`);
            const row = fx.db.get(`SELECT repo, summary FROM file_registry WHERE summary = 'core'`);
            assert.ok(row);
            assert.equal(row.repo, 'service', 'explicit per-update repo wins');
        }
        finally {
            fx.cleanup();
        }
    });
    it('falls back to task.repo when file_summaries entry omits repo', async () => {
        const fx = makeMultiRepoFixture();
        try {
            // Set tmb_default_repo to the OTHER repo to prove task.repo wins.
            fx.db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"service"')`);
            const issueId = await fx.issueFactory('task.repo fallback');
            const taskId = await fx.taskFactory(issueId, 'app'); // task.repo='app'
            const result = await call(fx.composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: String(taskId),
                commit_sha: 'abc1234',
                file_summaries: [{ path: 'src/index.ts', summary: 'index' }],
                verification_summary: 'ok',
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parse(result))}`);
            const row = fx.db.get(`SELECT repo, summary FROM file_registry WHERE summary = 'index'`);
            assert.ok(row);
            assert.equal(row.repo, 'app', 'task.repo wins over tmb_default_repo');
        }
        finally {
            fx.cleanup();
        }
    });
    it('falls back to tmb_default_repo when neither explicit nor task.repo is set', async () => {
        const fx = makeMultiRepoFixture();
        try {
            fx.db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"service"')`);
            const issueId = await fx.issueFactory('tmb_default_repo fallback');
            const taskId = await fx.taskFactory(issueId, null); // task.repo NULL
            const result = await call(fx.composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: String(taskId),
                commit_sha: 'abc1234',
                file_summaries: [{ path: 'lib/core.ts', summary: 'core via default' }],
                verification_summary: 'ok',
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parse(result))}`);
            const row = fx.db.get(`SELECT repo, summary FROM file_registry WHERE summary = 'core via default'`);
            assert.ok(row);
            assert.equal(row.repo, 'service', 'tmb_default_repo wins when task.repo is null');
        }
        finally {
            fx.cleanup();
        }
    });
    it('throws transaction-aborted error when no repo can be resolved', async () => {
        const fx = makeMultiRepoFixture();
        try {
            // No tmb_default_repo. task.repo also null.
            const issueId = await fx.issueFactory('no repo anywhere');
            const taskId = await fx.taskFactory(issueId, null);
            const result = await call(fx.composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: String(taskId),
                commit_sha: 'abc1234',
                file_summaries: [{ path: 'src/index.ts', summary: 'no repo' }],
                verification_summary: 'ok',
            });
            assert.equal(result.isError, true);
            const err = parse(result)['error'];
            assert.match(err, /no repo specified/i);
            assert.match(err, /task\.repo/i);
            assert.match(err, /tmb_default_repo/i);
        }
        finally {
            fx.cleanup();
        }
    });
});
//# sourceMappingURL=composites.test.js.map