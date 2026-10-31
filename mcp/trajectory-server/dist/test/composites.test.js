import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinScanEnv, seedReviewerObservation, tempDB } from './helpers.js';
import { validationTools } from '../tools/validation.js';
import { activeFindingProbes } from '../tools/verification-runs.js';
import { compositeTools, filesToDirs, pathInFiles, scopeCheckCommit, scopeSurface } from '../tools/composites.js';
import { GraphHolder } from '../graph.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
import { embed } from '../embeddings/model.js';
import { upsertRepoRemotes } from '../repos/remotes.js';
import { DATA_CONTRACTS, isSqlContract } from '../data-contracts.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
function parse(r) {
    return JSON.parse(r.content[0].text);
}
function parseBatch(r) {
    const raw = JSON.parse(r.content[0].text);
    return (raw.tasks ?? raw);
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
describe('task_retry', () => {
    it('clones a failed task with corrected spec, links rationale + audit', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueResult = parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
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
        await call(audit.handlers, 'audit_append', {
            agent: 'bro',
            issue_id: issueId,
            kind: 'event',
            event_type: 'branch_id_proposed',
            from_node: 'bro',
            branch_id: 'fix/initial',
            summary: 'branch proposed',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro',
            issue_id: issueId,
            waive_intent_gate: true,
            waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true,
            waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
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
        const retry = await call(composites.handlers, 'task_retry', {
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
        const rationale = db.get(`SELECT task_id FROM discussions WHERE issue_id = ? AND kind = 'decision' AND body LIKE 'Retry rationale%'`, [issueId]);
        assert.equal(rationale.task_id, out.task_id, 'the retry rationale belongs to the retry task');
        const auditRows = db.all(`SELECT event_type FROM audit WHERE issue_id = ?`, [issueId]);
        assert.ok(auditRows.some((r) => r.event_type === 'task_retry_attempted'));
    });
    it('records task_retry_attempted and task_effort_raised with the calling agent', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const caller = 'bro';
        const issueId = Number(parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'retry audit author', description: 'x',
        }))['id']);
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, effort, created_at, updated_at)
       VALUES (?, 'fix/audit-author', '', 'd', 'failed', 's', 'medium', datetime('now'), datetime('now'))`, [issueId]);
        const failedId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/audit-author'`).id;
        const retry = await call(composites.handlers, 'task_retry', {
            agent: caller,
            failed_task_id: String(failedId),
            new_branch_id: 'fix/audit-author-v2',
            corrected_spec_body: 'fixed approach',
            retry_rationale: 'raise effort',
            description: 'retry desc',
            effort: 'high',
        });
        assert.equal(retry.isError, undefined, JSON.stringify(parse(retry)));
        const attempted = db.get(`SELECT from_node FROM audit WHERE issue_id = ? AND event_type = 'task_retry_attempted'`, [issueId]);
        assert.equal(attempted.from_node, caller);
        const raised = db.get(`SELECT from_node, content_json FROM audit WHERE issue_id = ? AND event_type = 'task_effort_raised'`, [issueId]);
        assert.equal(raised.from_node, caller);
        const content = JSON.parse(raised.content_json);
        assert.equal(content.from, 'medium');
        assert.equal(content.to, 'high');
        assert.equal(content.failed_task_id, failedId);
        db.close();
    });
    it('copies files, verification and prompt_bearing from the failed task', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const issueId = Number(parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'retry fences', description: 'x',
        }))['id']);
        const filesJson = JSON.stringify(['src/a.ts', 'agents/swe.md']);
        const verificationJson = JSON.stringify(['npm test', 'bash tests/l1-lint/dist-fresh.sh']);
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body,
                          prompt_bearing, files, verification, created_at, updated_at)
       VALUES (?, 'fix/fenced', '', 'd', 'failed', 's', 1, ?, ?, datetime('now'), datetime('now'))`, [issueId, filesJson, verificationJson]);
        const failed = db.get(`SELECT id, files, verification, prompt_bearing FROM tasks WHERE branch_id = 'fix/fenced'`);
        const retry = await call(composites.handlers, 'task_retry', {
            agent: 'bro',
            failed_task_id: String(failed.id),
            new_branch_id: 'fix/fenced-v2',
            corrected_spec_body: 'fixed approach',
            retry_rationale: 'retry keeps fences',
            description: 'retry desc',
        });
        assert.equal(retry.isError, undefined, JSON.stringify(parse(retry)));
        const newId = parse(retry).task_id;
        const row = db.get(`SELECT files, verification, prompt_bearing FROM tasks WHERE id = ?`, [newId]);
        assert.equal(row.files, failed.files);
        assert.equal(row.verification, failed.verification);
        assert.equal(row.prompt_bearing, failed.prompt_bearing);
        assert.equal(row.files, filesJson);
        assert.equal(row.verification, verificationJson);
        assert.equal(row.prompt_bearing, 1);
        db.close();
    });
    it('rejects retry on a task whose status is not failed', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/x', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
        }));
        const id = String(created[0].id);
        const r = await call(composites.handlers, 'task_retry', {
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
    it('#474: repo override lands on the new task; omitted repo inherits from failed task', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')`);
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'repo override test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/base', summary: 's',
        });
        // Create the initial task with no repo (null) — simulates single-repo workflow.
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'fix/base', description: 'd', spec_body: 's' }],
        }));
        const failedId = String(created[0].id);
        await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: failedId, status: 'failed' });
        // With repo override: new task carries the override ('plugin').
        const retryWithOverride = await call(composites.handlers, 'task_retry', {
            agent: 'bro', failed_task_id: failedId, new_branch_id: 'fix/base-v2',
            corrected_spec_body: 'fixed', retry_rationale: 'wrong repo; switch to plugin', description: 'd',
            repo: 'plugin',
        });
        assert.ok(!retryWithOverride.isError, `expected ok: ${JSON.stringify(parse(retryWithOverride))}`);
        const newId = parse(retryWithOverride).task_id;
        const newTask = db.get('SELECT repo FROM tasks WHERE id = ?', [newId]);
        assert.equal(newTask.repo, 'plugin', 'repo override lands on new task');
        // Without repo override: new task inherits 'plugin' from the previous task.
        await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: String(newId), status: 'failed' });
        const retryInherited = await call(composites.handlers, 'task_retry', {
            agent: 'bro', failed_task_id: String(newId), new_branch_id: 'fix/base-v3',
            corrected_spec_body: 'fixed again', retry_rationale: 'another attempt', description: 'd',
        });
        assert.ok(!retryInherited.isError);
        const inheritedId = parse(retryInherited).task_id;
        const inheritedTask = db.get('SELECT repo FROM tasks WHERE id = ?', [inheritedId]);
        assert.equal(inheritedTask.repo, 'plugin', 'repo inherited from previous task when omitted');
        db.close();
    });
    it('#474: repo override rejects ".." in path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'task_retry', {
            agent: 'bro', failed_task_id: '1', new_branch_id: 'fix/x-v2',
            corrected_spec_body: 's', retry_rationale: 'r', description: 'd',
            repo: '../etc/passwd',
        });
        assert.ok(r.isError);
        assert.match(parse(r)['error'], /must not contain/);
    });
    it('#474: repo override rejects leading "/"', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'task_retry', {
            agent: 'bro', failed_task_id: '1', new_branch_id: 'fix/x-v2',
            corrected_spec_body: 's', retry_rationale: 'r', description: 'd',
            repo: '/absolute/path',
        });
        assert.ok(r.isError);
        assert.match(parse(r)['error'], /must not start with/);
    });
    it('retry cap: rejects the 4th retry attempt (3 prior in lineage)', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'retry cap test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        const mkBranch = async (branch) => {
            await call(audit.handlers, 'audit_append', {
                agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
                from_node: 'bro', branch_id: branch, summary: 's',
            });
        };
        const mkTask = async (branch) => {
            await mkBranch(branch);
            const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
                agent: 'bro', issue_id: issueId,
                waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
                waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
                waive_spec_shape: true, waive_spec_shape_reason: 'not under test',
                tasks: [{ branch_id: branch, description: 'd', spec_body: 's' }],
            }));
            return String(created[0].id);
        };
        const retryFrom = async (failedId, newBranch) => {
            await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: failedId, status: 'failed' });
            await mkBranch(newBranch);
            const r = await call(composites.handlers, 'task_retry', {
                agent: 'bro', failed_task_id: failedId, new_branch_id: newBranch,
                corrected_spec_body: 's', retry_rationale: 'new approach', description: 'd',
            });
            assert.ok(!r.isError, `Retry should succeed for attempt on ${newBranch}: ${JSON.stringify(parse(r))}`);
            return String(parse(r).task_id);
        };
        const id0 = await mkTask('fix/cap-v1');
        const id1 = await retryFrom(id0, 'fix/cap-v2');
        const id2 = await retryFrom(id1, 'fix/cap-v3');
        const id3 = await retryFrom(id2, 'fix/cap-v4');
        await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: id3, status: 'failed' });
        await mkBranch('fix/cap-v5');
        const denied = await call(composites.handlers, 'task_retry', {
            agent: 'bro', failed_task_id: id3, new_branch_id: 'fix/cap-v5',
            corrected_spec_body: 's', retry_rationale: 'fourth retry', description: 'd',
        });
        assert.ok(denied.isError, '4th retry must be rejected by the retry cap');
        assert.match(parse(denied)['error'], /retry limit reached \(3\)/);
        assert.match(parse(denied)['error'], /escalate to Human/);
        db.close();
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
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/x', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
        }));
        const id = String(created[0].id);
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro',
            task_id: id,
            commit_sha: 'abcdef1234567',
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
            verification_summary: 'ok',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects missing verification_summary with a named validation error (#396)', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro',
            task_id: '1',
            commit_sha: 'abcdef1234567',
        });
        assert.ok(r.isError, 'Expected error when verification_summary is missing');
        const errMsg = parse(r)['error'];
        assert.ok(errMsg.includes('verification_summary'), `error should mention verification_summary, got: ${errMsg}`);
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
                labels: ['Bug', 'Priority: High'],
                agent: 'bro', objective: 'closed_at regression', description: 'x',
            }))['id']));
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_append', {
                agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
                from_node: 'bro', branch_id: 'fix/closed-at', summary: 's',
            });
            const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
                agent: 'bro', issue_id: issueId,
                waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
                waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
                tasks: [{ branch_id: 'fix/closed-at', description: 'd', spec_body: 's', repo: 'app' }],
            }));
            const taskId = String(created[0].id);
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'running',
            });
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
            });
            seedReviewedCommit(db, issueId, taskId, 'abc1234');
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: taskId,
                commit_sha: 'abc1234',
                verification_summary: 'ok',
                close_issue_if_last_task: true,
                waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
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
    it('#277: mirrors the auto-close to the linked remote (no local/remote drift)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'bac-remote-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        writeFileSync(join(repoRoot, 'a.ts'), 'export const x = 1;\n');
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
        upsertRepoRemotes(db, 'app', [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"auto"')`);
        const savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
        delete process.env.TMB_DISABLE_REMOTE_SYNC;
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const composites = compositeTools(db, dbPath);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        // Record every spawn so we can assert the remote close actually fired.
        const spawnCalls = [];
        const spawnFn = (cmd, args) => {
            spawnCalls.push({ cmd, args });
            return { status: 0, stdout: '', stderr: '' };
        };
        try {
            const issueId = String((parse(await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'],
                agent: 'bro', objective: 'remote close mirror', description: 'x',
            }))['id']));
            // Simulate an issue already synced to a GitHub remote (iid 42).
            db.run(`UPDATE issues SET gh_iid = 42, remote_kind = 'github' WHERE id = ?`, [issueId]);
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_append', {
                agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
                from_node: 'bro', branch_id: 'fix/remote-close', summary: 's',
            });
            const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
                agent: 'bro', issue_id: issueId,
                waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
                waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
                tasks: [{ branch_id: 'fix/remote-close', description: 'd', spec_body: 's', repo: 'app' }],
            }));
            const taskId = String(created[0].id);
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
            });
            seedReviewedCommit(db, issueId, taskId, 'abc1234');
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
                close_issue_if_last_task: true, waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test', _spawnFn: spawnFn,
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['issue_closed'], true);
            const closeCall = spawnCalls.find((c) => c.args.includes('issue') && c.args.includes('close'));
            assert.ok(closeCall, `expected a remote 'issue close' spawn; got ${JSON.stringify(spawnCalls)}`);
            assert.equal(closeCall.cmd, 'gh', 'github remote closes via gh');
            assert.ok(closeCall.args.includes('42'), 'remote close must target gh_iid 42');
            assert.deepEqual(parse(r)['remote']['synced'], true);
        }
        finally {
            if (savedEnv === undefined)
                delete process.env.TMB_DISABLE_REMOTE_SYNC;
            else
                process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
// A prior bro verification of the commit followed by a code-reviewer pass: the
// review evidence close_issue_if_last_task requires before it closes an issue.
function seedReviewedCommit(db, issueId, taskId, sha) {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() - 30_000).toISOString();
    db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'bro_verification_pass', 'ok', ?, ?)`, [issueId, JSON.stringify({ task_id: Number(taskId), commit_sha: sha }), earlier]);
    db.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, 1, 'code-reviewer', 'pass', 1, ?)`, [taskId, later]);
}
describe('pathInFiles (GH 1705)', () => {
    it('an entry covers itself and its subtree, never its siblings; any tests/ entry covers all of tests/', () => {
        assert.equal(pathInFiles('src/a/c.ts', ['src/a/b.ts']), false, 'a file entry does not cover its sibling');
        assert.equal(pathInFiles('src/a/b.ts', ['src/a/b.ts']), true, 'a file entry covers itself');
        assert.equal(pathInFiles('src/a/x/y.ts', ['src/a']), true, 'a dir entry without a slash covers its subtree');
        assert.equal(pathInFiles('src/a/x/y.ts', ['src/a/']), true, 'a trailing slash is stripped');
        assert.equal(pathInFiles('src/ab.ts', ['src/a']), false, 'path boundary, not string prefix');
        assert.equal(pathInFiles('tests/z.sh', ['tests/l1/x.sh']), true, 'any tests/ entry covers all of tests/');
    });
});
describe('scopeCheckCommit (#157)', () => {
    it('covers listed paths (a file entry covers itself, a trailing slash the directory beneath it); flags the rest', () => {
        const ws = mkdtempSync(join(tmpdir(), 'scopecheck-'));
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        try {
            git(ws, 'init', '-q', '-b', 'main');
            git(ws, 'config', 'user.email', 't@t.t');
            git(ws, 'config', 'user.name', 't');
            writeFileSync(join(ws, 'seed.txt'), 'seed\n');
            git(ws, 'add', '.');
            git(ws, 'commit', '-q', '-m', 'base');
            git(ws, 'update-ref', 'refs/remotes/origin/dev', git(ws, 'rev-parse', 'HEAD'));
            mkdirSync(join(ws, 'src'), { recursive: true });
            mkdirSync(join(ws, 'dist'), { recursive: true });
            writeFileSync(join(ws, 'src', 'a.ts'), 'a\n');
            writeFileSync(join(ws, 'dist', 'index.js'), 'i\n');
            writeFileSync(join(ws, 'rogue.ts'), 'r\n');
            git(ws, 'add', '.');
            git(ws, 'commit', '-q', '-m', 'work');
            const sha = git(ws, 'rev-parse', 'HEAD');
            const res = scopeCheckCommit(ws, 'origin/dev', sha, ['src/a.ts', 'dist/']);
            assert.equal(res.checked, true);
            assert.deepEqual(res.outOfScope, ['rogue.ts'], 'dist/ covers dist/index.js; src/a.ts covers itself; rogue.ts is out');
            assert.equal(res.baseMoved, false);
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('returns checked:false with a reason when the repo/commit is unresolvable', () => {
        const ws = mkdtempSync(join(tmpdir(), 'scopecheck-nogit-'));
        try {
            const res = scopeCheckCommit(ws, 'origin/dev', 'deadbeef', ['src/a.ts']);
            assert.equal(res.checked, false);
            assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('bro_atomic_close — scope gate (#157)', () => {
    // Build a real repo with an origin/dev ref, a base commit, and a work commit
    // that changes `changedFiles`. Returns the work commit SHA + a DB seeded with
    // a completed task whose typed files[] is `taskFiles`.
    async function setup(taskFiles, changedFiles, opts = {}) {
        const withRemote = opts.withRemote !== false;
        const ws = mkdtempSync(join(tmpdir(), 'bac-scope-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        git(repoRoot, 'init', '-q', '-b', 'dev');
        git(repoRoot, 'config', 'user.email', 't@t.t');
        git(repoRoot, 'config', 'user.name', 't');
        writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
        git(repoRoot, 'add', '.');
        git(repoRoot, 'commit', '-q', '-m', 'base');
        // A remoteless repo (withRemote:false) exercises the local-<base> fallback:
        // the scope gate must diff against the local parent ref, not origin/dev.
        if (withRemote)
            git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', git(repoRoot, 'rev-parse', 'HEAD'));
        const baseSha = git(repoRoot, 'rev-parse', 'HEAD');
        const commitFiles = (paths, message) => {
            for (const rel of paths) {
                const abs = join(repoRoot, rel);
                mkdirSync(join(abs, '..'), { recursive: true });
                writeFileSync(abs, `${rel} ${message}\n`);
            }
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', message);
            return git(repoRoot, 'rev-parse', 'HEAD');
        };
        // Local dev carries unpushed commits the task is cut from (GH 1713).
        if (opts.localAhead)
            commitFiles(opts.localAhead, 'local ahead');
        // A sibling branch the task is stacked on (its recorded base).
        let siblingSha = null;
        if (opts.sibling) {
            git(repoRoot, 'checkout', '-q', '-b', 'feat/sibling');
            siblingSha = commitFiles(opts.sibling, 'sibling');
            if (withRemote)
                git(repoRoot, 'update-ref', 'refs/remotes/origin/feat/sibling', siblingSha);
        }
        // Put the work commit on a feature branch so the local `dev` ref stays at
        // the base — the remoteless fallback then diffs a real parent...work range.
        git(repoRoot, 'checkout', '-q', '-b', 'feat/work');
        const sha = commitFiles(changedFiles, 'work');
        // dev advances with unrelated files after the task branched.
        if (opts.devAdvance) {
            git(repoRoot, 'checkout', '-q', 'dev');
            const devTip = commitFiles(opts.devAdvance, 'dev advance');
            if (withRemote)
                git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', devTip);
            git(repoRoot, 'checkout', '-q', 'feat/work');
        }
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const composites = compositeTools(db, dbPath);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'scope gate', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'feat/scope', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'feat/scope', description: 'd', spec_body: 's', repo: 'app' }],
        }));
        const taskId = String(created[0].id);
        db.run(`UPDATE tasks SET parent_branch_id=?, files=? WHERE id=?`, [
            opts.sibling ? 'feat/sibling' : 'dev',
            JSON.stringify(taskFiles),
            taskId,
        ]);
        await call(tasks.handlers, 'task_update_status', {
            agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha.slice(0, 12),
        });
        return {
            db, composites, taskId, issueId, sha, baseSha, siblingSha,
            cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); },
        };
    }
    it('closes when every changed file is within files[]', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts']);
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
        }
        finally {
            cleanup();
        }
    });
    it('a dir-prefix files[] entry (dist/) covers files beneath it (dist/index.js)', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['dist/'], ['dist/index.js']);
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
        }
        finally {
            cleanup();
        }
    });
    it('refuses to close an out-of-scope commit, names the path, leaves the task open', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.equal(r.isError, true);
            assert.match(parse(r)['error'], /rogue\.ts/);
            assert.match(parse(r)['error'], /waive_scope_gate=true/);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'completed', 'task stays open when the gate rejects');
        }
        finally {
            cleanup();
        }
    });
    it('waive_scope_gate=true closes an out-of-scope commit and logs the waive', async () => {
        const { db, composites, taskId, issueId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
                waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
            const waive = db.get(`SELECT COUNT(*) AS c FROM audit WHERE issue_id = ? AND event_type = 'scope_gate_waived'`, [issueId]);
            assert.equal(waive.c, 1, 'waive audit note recorded');
        }
        finally {
            cleanup();
        }
    });
    it('dev advancing with unrelated files after the task base does not count: close passes', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts'], {
            devAdvance: ['docs/elsewhere.md', 'scripts/hooks/other.sh'],
        });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `dev's own commits must not be extras, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['base_moved'], false);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
        }
        finally {
            cleanup();
        }
    });
    it('refusal names only the task commit path outside files[], grouped by surface', async () => {
        const { composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'scripts/hooks/rogue.sh'], { devAdvance: ['docs/elsewhere.md'] });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.equal(r.isError, true);
            const out = parse(r);
            assert.deepEqual(out['extras_by_surface'], { scripts: { count: 1, paths: ['scripts/hooks/rogue.sh'] } });
            assert.match(out['error'], /scripts \(1\): scripts\/hooks\/rogue\.sh/);
            assert.doesNotMatch(out['error'], /elsewhere/);
            assert.match(out['error'], /scope_waiver_reason/);
        }
        finally {
            cleanup();
        }
    });
    it('waive_scope_gate without a scope_waiver_reason of 10+ chars is refused', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
        try {
            for (const reason of [undefined, 'short']) {
                const r = await call(composites.handlers, 'bro_atomic_close', {
                    agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
                    waive_scope_gate: true, ...(reason ? { scope_waiver_reason: reason } : {}),
                });
                assert.equal(r.isError, true);
                assert.match(parse(r)['error'], /scope_waiver_reason/);
            }
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'completed');
        }
        finally {
            cleanup();
        }
    });
    it('a waiver records the accepted paths, reason, base_moved, recorded_base and merge_base; task_brief exposes scope', async () => {
        const { db, composites, taskId, issueId, sha, baseSha, siblingSha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'tests/rogue.test.ts'], { sibling: ['docs/sibling.md'] });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
                waive_scope_gate: true, scope_waiver_reason: 'sibling docs land with the stack; test needed',
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const out = parse(r);
            assert.equal(out['base_moved'], true);
            assert.equal(out['recorded_base'], siblingSha);
            assert.equal(out['merge_base'], baseSha);
            assert.deepEqual(out['extras_accepted'], ['tests/rogue.test.ts'], 'the sibling base commits are not the task\'s own');
            const waive = db.get(`SELECT summary, content_json FROM audit WHERE issue_id = ? AND event_type = 'scope_gate_waived'`, [issueId]);
            const payload = JSON.parse(waive.content_json);
            assert.deepEqual(payload['accepted_paths'], ['tests/rogue.test.ts']);
            assert.equal(payload['reason'], 'sibling docs land with the stack; test needed');
            assert.equal(payload['base_moved'], true);
            assert.equal(payload['recorded_base'], siblingSha);
            assert.equal(payload['merge_base'], baseSha);
            const brief = parse(await call(composites.handlers, 'task_brief', { agent: 'code-reviewer', task_id: Number(taskId) }));
            assert.deepEqual(brief['scope'], {
                files: ['src/a.ts'],
                extras_accepted: ['tests/rogue.test.ts'],
                base_moved: true,
            });
        }
        finally {
            cleanup();
        }
    });
    it('base_moved is reported without extras when the recorded base differs from the merge-base', async () => {
        const { composites, taskId, sha, cleanup } = await setup(['src/', 'docs/'], ['src/a.ts'], { sibling: ['docs/sibling.md'] });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['base_moved'], true);
            const brief = parse(await call(composites.handlers, 'task_brief', { agent: 'bro', task_id: Number(taskId) }));
            assert.deepEqual(brief['scope'], { files: ['src/', 'docs/'], extras_accepted: [], base_moved: true });
        }
        finally {
            cleanup();
        }
    });
    it('fails closed when the repo/commit cannot be resolved (no git checkout)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'bac-nogit-'));
        const notARepo = join(ws, 'notgit');
        mkdirSync(notARepo, { recursive: true });
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [notARepo]);
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const composites = compositeTools(db, dbPath);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        try {
            const issueId = String((parse(await call(issues.handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'fail closed', description: 'x',
            }))['id']));
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_append', {
                agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
                from_node: 'bro', branch_id: 'feat/fc', summary: 's',
            });
            const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
                agent: 'bro', issue_id: issueId,
                waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
                waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
                waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
                tasks: [{ branch_id: 'feat/fc', description: 'd', spec_body: 's', repo: 'app' }],
            }));
            const taskId = String(created[0].id);
            db.run(`UPDATE tasks SET parent_branch_id='dev', files=? WHERE id=?`, [JSON.stringify(['src/a.ts']), taskId]);
            await call(tasks.handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abcdef1',
            });
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: 'abcdef1', verification_summary: 'ok',
            });
            assert.equal(r.isError, true, 'fail-closed: unresolvable repo/commit must not silently close');
            assert.match(parse(r)['error'], /cannot resolve/);
            assert.match(parse(r)['error'], /waive_scope_gate=true/);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'completed', 'task stays open on fail-closed');
        }
        finally {
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('a task cut from a local dev ahead of origin/dev closes without the local base commits as extras (GH 1713)', async () => {
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts'], {
            localAhead: ['docs/local-only.md', 'scripts/unpushed.sh'],
        });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `local-ahead base commits must not be extras, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['extras_accepted'], undefined);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
        }
        finally {
            cleanup();
        }
    });
    it('remoteless repo: scope gate diffs against the local parent ref and still closes (#1063)', async () => {
        // No origin/dev exists — resolveBaseRef falls back to local dev, so the gate
        // computes its three-dot diff against the local parent ref rather than
        // fail-closing.
        const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts'], { withRemote: false });
        try {
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
            });
            assert.ok(!r.isError, `remoteless close must pass via the local base fallback, got: ${JSON.stringify(parse(r))}`);
            const row = db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
            assert.equal(row.status, 'closed');
        }
        finally {
            cleanup();
        }
    });
});
describe('bro_atomic_close — verification gate (GH 1672)', () => {
    function seedRun(db, taskId, sha, commands, exitCode = 0) {
        const now = new Date().toISOString();
        db.run(`INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (?, ?, 'gate', ?, ?, ?, 900, 0)`, [taskId, sha, now, now, exitCode]);
        const runId = db.get(`SELECT MAX(id) AS id FROM verification_runs`).id;
        commands.forEach((command, i) => {
            db.run(`INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (?, ?, ?, 0, 0.1, '')`, [runId, i + 1, command]);
        });
        return runId;
    }
    async function setup() {
        const ws = mkdtempSync(join(tmpdir(), 'bac-verify-'));
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        const issues = issueTools(db, dbPath);
        const tasks = taskTools(db);
        const composites = compositeTools(db, dbPath);
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'verification gate', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/verify', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
            waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'fix/verify', description: 'd', spec_body: 's' }],
        }));
        const taskId = String(created[0].id);
        db.run(`UPDATE tasks SET verification = ? WHERE id = ?`, [JSON.stringify(['bash lint.sh']), taskId]);
        await call(tasks.handlers, 'task_update_status', {
            agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abcdef1234567',
        });
        return { db, composites, issueId, taskId, cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); } };
    }
    const close = (composites, taskId) => call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: 'abcdef1234567', verification_summary: 'ok',
        waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
    });
    const status = (db, taskId) => db.get(`SELECT status FROM tasks WHERE id = ?`, [taskId]).status;
    it('a verification[] amend after swe completion voids the earlier run: refused until a run of the new verification[] is recorded for the commit', async () => {
        const { db, composites, taskId, cleanup } = await setup();
        try {
            const sha = 'abcdef1234567890abcdef1234567890abcdef12';
            seedRun(db, taskId, sha, ['bash lint.sh']);
            const amend = await call(composites.handlers, 'task_update_spec', {
                agent: 'bro', task_id: taskId, verification: ['bash lint.sh', 'npm test'], reason: 'verification[0] path fixed',
            });
            assert.ok(!amend.isError, `amend failed: ${JSON.stringify(parse(amend))}`);
            const refused = await close(composites, taskId);
            assert.equal(refused.isError, true);
            const error = parse(refused)['error'];
            assert.match(error, /^verification_run_missing: /);
            assert.match(error, /abcdef1234567/);
            assert.match(error, /task_update_status\(status='completed'/);
            assert.match(error, /waive_verification_gate_reason/);
            assert.equal(status(db, taskId), 'completed', 'task stays open when the gate refuses');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'bro_verification_pass'`).c, 0, 'no bro_verification_pass without a run');
            seedRun(db, taskId, sha, ['bash lint.sh', 'npm test'], 1);
            assert.equal((await close(composites, taskId)).isError, true, 'a failing run of the new verification[] does not open the gate');
            const runId = seedRun(db, taskId, sha, ['bash lint.sh', 'npm test']);
            const r = await close(composites, taskId);
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(status(db, taskId), 'closed');
            const run = db.get(`SELECT id FROM verification_runs WHERE task_id = ? AND commit_sha LIKE 'abcdef1234567%' AND exit_code = 0 ORDER BY id DESC LIMIT 1`, [taskId]);
            assert.equal(run?.id, runId, 'a passing verification_runs row exists for the closing commit');
        }
        finally {
            cleanup();
        }
    });
    it('a recorded review finding voids a run of verification[] alone: the run must also carry each non-wontfix probe (GH 1737)', async () => {
        const { db, composites, taskId, cleanup } = await setup();
        try {
            const sha = 'abcdef1234567890abcdef1234567890abcdef12';
            const now = new Date().toISOString();
            db.run(`INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, status, created_at)
         VALUES (?, ?, 1, 'npm test', 'exit 0', 'exit 1', 'open', ?), (?, ?, 1, 'exit 9', 'exit 0', 'exit 9', 'wontfix', ?),
                (?, ?, 1, 'bash l3.sh', 'exit 0', 'exit 2', 'fixed', ?)`, [`F${taskId}-1`, taskId, now, `F${taskId}-2`, taskId, now, `F${taskId}-10`, taskId, now]);
            seedRun(db, taskId, sha, ['bash lint.sh']);
            const refused = parse(await close(composites, taskId))['error'];
            assert.match(refused, /^verification_run_missing: /);
            assert.match(refused, /3 gate command\(s\)/);
            assert.match(refused, /review finding probes/);
            seedRun(db, taskId, sha, ['bash lint.sh', `[probe F${taskId}-10] bash l3.sh`, `[probe F${taskId}-1] npm test`]);
            assert.equal((await close(composites, taskId)).isError, true, 'probes out of id order do not match');
            seedRun(db, taskId, sha, ['bash lint.sh', `[probe F${taskId}-1] npm test`, `[probe F${taskId}-10] bash l3.sh`]);
            const r = await close(composites, taskId);
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(status(db, taskId), 'closed');
        }
        finally {
            cleanup();
        }
    });
    it('a task with verification[] and no run for the commit is refused; a run for another commit does not count', async () => {
        const { db, composites, taskId, cleanup } = await setup();
        try {
            assert.match(parse(await close(composites, taskId))['error'], /^verification_run_missing: /);
            seedRun(db, taskId, 'ffffff1234567890', ['bash lint.sh']);
            assert.equal((await close(composites, taskId)).isError, true);
            assert.equal(status(db, taskId), 'completed');
        }
        finally {
            cleanup();
        }
    });
    it('closes with a verification_gate_waived row for the commit and no run', async () => {
        const { db, composites, issueId, taskId, cleanup } = await setup();
        try {
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (?, 'fix/verify', 'hook:swe-verification-gate', 'verification_gate_waived', 'waived', ?, ?)`, [issueId, JSON.stringify({ task_id: Number(taskId), commit_sha: 'abcdef1234567', waiver_reason: 'docs-only change' }), new Date().toISOString()]);
            const r = await close(composites, taskId);
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(status(db, taskId), 'closed');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM verification_runs WHERE task_id = ?`, [taskId]).c, 0);
        }
        finally {
            cleanup();
        }
    });
    it('a waiver for another commit does not open the gate', async () => {
        const { db, composites, issueId, taskId, cleanup } = await setup();
        try {
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (?, 'fix/verify', 'hook:swe-verification-gate', 'verification_gate_waived', 'waived', ?, ?)`, [issueId, JSON.stringify({ task_id: Number(taskId), commit_sha: '1234567', waiver_reason: 'docs-only change' }), new Date().toISOString()]);
            assert.equal((await close(composites, taskId)).isError, true);
            assert.equal(status(db, taskId), 'completed');
        }
        finally {
            cleanup();
        }
    });
});
describe('task_recover', () => {
    async function seedPendingTask() {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'recover test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/recover', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
            tasks: [{ branch_id: 'fix/recover', description: 'd', spec_body: 's' }],
        }));
        const taskId = String(created[0].id);
        return { db, composites, tasks, issueId, taskId };
    }
    it('recover-with-commit: advances a pending task to closed + writes task_recovered + bro_verification_pass', async () => {
        const { db, composites, taskId } = await seedPendingTask();
        const r = await call(composites.handlers, 'task_recover', {
            agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'verified independently',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out['recovered'], true);
        assert.equal(out['action'], 'closed');
        assert.equal(out['commit_sha'], 'abc1234');
        const row = db.get('SELECT status, commit_sha FROM tasks WHERE id = ?', [taskId]);
        assert.equal(row.status, 'closed');
        assert.equal(row.commit_sha, 'abc1234');
        const recovered = db.get("SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_recovered'");
        assert.equal(recovered.c, 1);
        const pass = db.get("SELECT COUNT(*) AS c FROM audit WHERE event_type = 'bro_verification_pass'");
        assert.equal(pass.c, 1);
    });
    it('idempotent-already-closed: re-call on a closed task returns a no-op naming the status', async () => {
        const { db, composites, taskId } = await seedPendingTask();
        const first = parse(await call(composites.handlers, 'task_recover', {
            agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
        }));
        assert.equal(first['recovered'], true);
        const r = await call(composites.handlers, 'task_recover', {
            agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
        });
        assert.ok(!r.isError, 'idempotent re-call must not error');
        const out = parse(r);
        assert.equal(out['recovered'], false);
        assert.equal(out['action'], 'noop');
        assert.equal(out['status'], 'closed');
        // No duplicate audit rows on re-call.
        const recovered = db.get("SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_recovered'");
        assert.equal(recovered.c, 1);
    });
    it('re-dispatch-no-commit: pending with no commit returns re-dispatch without changing status', async () => {
        const { db, composites, taskId } = await seedPendingTask();
        const r = await call(composites.handlers, 'task_recover', {
            agent: 'bro', task_id: taskId,
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out['recovered'], false);
        assert.equal(out['action'], 're-dispatch');
        assert.match(out['reason'], /re-dispatch SWE/);
        const row = db.get('SELECT status FROM tasks WHERE id = ?', [taskId]);
        assert.equal(row.status, 'pending', 'status must be unchanged');
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'task_recover', {
            agent: 'swe', task_id: '1', commit_sha: 'abc1234',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
});
describe('intent_start — per-repo milestone default + repo param (#15)', () => {
    it('defaults the created issue milestone to the sole repo\'s sole OPEN milestone', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'intent default milestone',
            intent_verbatim: 'do the thing',
            branch_id: 'feat/intent-default-ms',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const issueId = parse(r)['issue_id'];
        const row = db.get('SELECT milestone, repo FROM issues WHERE id = ?', [issueId]);
        assert.equal(row?.milestone, 'v0.10.0', 'intent_start applies the sole open milestone');
        assert.equal(row?.repo, 'app', 'sole repo bound when repo omitted');
        db.close();
    });
    it('stays NULL when the repo has no open milestone', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'intent no milestone',
            intent_verbatim: 'do the thing',
            branch_id: 'feat/intent-no-ms',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const issueId = parse(r)['issue_id'];
        const row = db.get('SELECT milestone FROM issues WHERE id = ?', [issueId]);
        assert.equal(row?.milestone, null, 'no open milestone → null');
        db.close();
    });
    it('binds issues.repo to an explicit repo arg and resolves its milestone', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
        db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v2.0.0', 'backend', 'open')`);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'intent explicit repo',
            intent_verbatim: 'do the thing',
            branch_id: 'feat/intent-explicit-repo',
            repo: 'backend',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const issueId = parse(r)['issue_id'];
        const row = db.get('SELECT milestone, repo FROM issues WHERE id = ?', [issueId]);
        assert.equal(row?.repo, 'backend', 'explicit repo bound on the issue');
        assert.equal(row?.milestone, 'v2.0.0', 'milestone resolved from the explicit repo');
        db.close();
    });
    it('returns a named error for an explicit repo with no matching repos row', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'intent unknown repo',
            intent_verbatim: 'do the thing',
            branch_id: 'feat/intent-unknown-repo',
            repo: 'ghost',
        });
        assert.ok(r.isError, 'unknown repo must be a named error');
        assert.match(parse(r)['error'], /repo "ghost" has no matching repos row/);
        db.close();
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
            labels: ['Bug', 'Priority: High'],
            agent: 'bro', objective: 'fail record test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
            from_node: 'bro', branch_id: 'fix/fail-rec', summary: 's',
        });
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test; not under test',
            waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
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
            agent: 'code-reviewer', task_id: '1', which_check: 'V2', details: 'failed',
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
describe('pr_monitor_worktree', () => {
    it('rejects non-code-reviewer caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'bro', commit_sha: 'abc1234', repo_path: '/tmp', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects malformed commit_sha', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'code-reviewer', commit_sha: 'not-a-sha', repo_path: '/tmp', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /hex SHA/);
    });
    it('rejects relative repo_path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'code-reviewer', commit_sha: 'abc1234', repo_path: 'relative/path', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /absolute path/);
    });
    it('rejects empty command', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'code-reviewer', commit_sha: 'abc1234', repo_path: '/tmp', command: '   ',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /non-empty/);
    });
});
describe('pr_monitor_worktree — containment', () => {
    it('refuses a repo_path outside the project with outside_project', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/proj/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'code-reviewer', commit_sha: 'abc1234', repo_path: '/var/elsewhere', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'outside_project');
        assert.equal(out['path'], '/var/elsewhere');
        assert.equal(out['project_root'], '/tmp/proj');
    });
    it('checks the commit out under the repo, never in /tmp', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'prmon-'));
        try {
            const git = (...a) => execFileSync('git', ['-C', ws, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
            git('init', '-q', '-b', 'main');
            git('config', 'user.email', 't@t.t');
            git('config', 'user.name', 't');
            writeFileSync(join(ws, 'a.txt'), 'one\n');
            git('add', '.');
            git('commit', '-q', '-m', 'base');
            const sha = git('rev-parse', 'HEAD');
            const db = tempDB();
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'pr_monitor_worktree', {
                agent: 'code-reviewer', commit_sha: sha, repo_path: ws, command: 'pwd',
            });
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            assert.equal(parse(r)['worktree'], `${ws}/.claude/worktrees/pr-review-${sha}`);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('worktree_commits_fetch', () => {
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'worktree_commits_fetch', {
            agent: 'swe', task_ids: ['1'], repo_path: '/tmp',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects empty task_ids', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'worktree_commits_fetch', {
            agent: 'bro', task_ids: [], repo_path: '/tmp',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /non-empty/);
    });
    it('rejects relative repo_path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'worktree_commits_fetch', {
            agent: 'bro', task_ids: ['1'], repo_path: 'relative',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /absolute/);
    });
    it('surfaces a missing task as isError with the raw id preserved (#283)', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'worktree_commits_fetch', {
            agent: 'bro', task_ids: ['99999'], repo_path: '/tmp',
        });
        // A failed reap must not read as success (#283): isError + all_reaped=false.
        assert.ok(r.isError, `a missing task must surface isError; got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out.all_reaped, false);
        assert.equal(out.reaped[0].reaped, false);
        assert.equal(out.reaped[0].task_id, '99999', 'raw tid preserved, not NaN');
        assert.match(out.reaped[0].error, /No task/);
    });
    it('no-ops (no fetch) when the branch ref already resolves to the commit_sha in the main checkout (#156)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'reap-noop-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        try {
            git(repoRoot, 'init', '-q', '-b', 'main');
            git(repoRoot, 'config', 'user.email', 't@t.t');
            git(repoRoot, 'config', 'user.name', 't');
            writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'base');
            // Create the feature branch ref pointing at a real commit in the MAIN
            // checkout — as if SWE's commit had already landed on the shared ref.
            git(repoRoot, 'branch', 'fix/already-reaped');
            const sha = git(repoRoot, 'rev-parse', 'refs/heads/fix/already-reaped');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
            db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
            db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
         VALUES (1, 'fix/already-reaped', 't', 'd', 'completed', 's', ?, 'app', datetime('now'), datetime('now'))`, [sha]);
            const taskId = String(db.get('SELECT last_insert_rowid() AS id').id);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'worktree_commits_fetch', {
                agent: 'bro', task_ids: [taskId], repo_path: repoRoot,
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const out = parse(r);
            assert.equal(out.all_reaped, true);
            assert.equal(out.reaped[0].reaped, true);
            // The ref still points at the same SHA — the no-op did not move it, and no
            // worktree existed to fetch from (it would have errored if it tried).
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/already-reaped'), sha);
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('reaps from a linked worktree under the REPO root via update-ref (worktree .git is a file, not a remote) (#156)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'reap-wt-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        try {
            git(repoRoot, 'init', '-q', '-b', 'main');
            git(repoRoot, 'config', 'user.email', 't@t.t');
            git(repoRoot, 'config', 'user.name', 't');
            writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'base');
            // Create the feature branch + a linked worktree UNDER THE REPO ROOT, then
            // commit inside the worktree (the commit only lives on the worktree's
            // branch ref). The main checkout has NO such ref yet.
            const slug = 'wt-feature';
            const branch = `fix/${slug}`;
            const wtPath = join(repoRoot, '.claude', 'worktrees', slug);
            git(repoRoot, 'worktree', 'add', '-q', '-b', branch, wtPath, 'main');
            writeFileSync(join(wtPath, 'b.txt'), 'two\n');
            git(wtPath, 'add', '.');
            git(wtPath, 'commit', '-q', '-m', 'swe work');
            const sha = git(wtPath, 'rev-parse', 'HEAD');
            // Detach the worktree's branch so the main checkout's branch ref is the
            // only place the reap can set it — and prove update-ref (not fetch-from-
            // worktree) is what makes the SHA visible on refs/heads/<branch>.
            git(wtPath, 'checkout', '-q', '--detach');
            git(repoRoot, 'branch', '-q', '-D', branch);
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
            db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
            db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
         VALUES (1, ?, 't', 'd', 'completed', 's', ?, 'app', datetime('now'), datetime('now'))`, [branch, sha]);
            const taskId = String(db.get('SELECT last_insert_rowid() AS id').id);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'worktree_commits_fetch', {
                agent: 'bro', task_ids: [taskId], repo_path: repoRoot,
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const out = parse(r);
            assert.equal(out.all_reaped, true);
            assert.equal(out.reaped[0].reaped, true);
            // The branch ref now resolves to the worktree commit in the main checkout.
            assert.equal(git(repoRoot, 'rev-parse', `refs/heads/${branch}`), sha);
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('intent_start (#426)', () => {
    it('creates issue + intent + note + branch_id_proposed audit atomically', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'add export feature',
            intent_verbatim: 'I want to export data as CSV',
            branch_id: 'feat/add-export-feature',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(typeof out.issue_id, 'number');
        assert.equal(out.branch_id, 'feat/add-export-feature');
        const discussions = db.all(`SELECT kind, body FROM discussions WHERE issue_id = ? ORDER BY id ASC`, [out.issue_id]);
        assert.ok(discussions.some((d) => d.kind === 'note' && d.body.includes('Beginning planning on feat/add-export-feature')));
        assert.ok(discussions.some((d) => d.kind === 'intent' && d.body.includes('I want to export data as CSV')));
        const auditRows = db.all(`SELECT event_type, branch_id FROM audit WHERE issue_id = ?`, [out.issue_id]);
        assert.ok(auditRows.some((a) => a.event_type === 'branch_id_proposed' && a.branch_id === 'feat/add-export-feature'));
        const issue = db.get(`SELECT objective, status FROM issues WHERE id = ?`, [out.issue_id]);
        assert.equal(issue.objective, 'add export feature');
        assert.equal(issue.status, 'open');
        db.close();
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'swe',
            objective: 'do thing',
            intent_verbatim: 'x',
            branch_id: 'feat/do-thing',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
    it('rejects invalid branch_id', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'do thing',
            intent_verbatim: 'x',
            branch_id: 'not valid branch',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /conventional format/);
    });
    it('rolls back all writes when the transaction fails mid-way', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        // Poison the audit table so the 4th write (audit_append) throws.
        db.run(`DROP TABLE audit`);
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'rollback test',
            intent_verbatim: 'test rollback',
            branch_id: 'feat/rollback-test',
        });
        assert.equal(r.isError, true);
        // If the transaction rolled back, no issue was created.
        const issues = db.all(`SELECT id FROM issues WHERE id != -1`);
        assert.equal(issues.length, 0, 'transaction must roll back: no issue row must survive');
        db.close();
    });
    it('persists supplied labels on the issue row', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'labelled intent',
            intent_verbatim: 'x',
            branch_id: 'fix/labelled-intent',
            labels: ['Bug', 'Priority: High'],
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const issueId = parse(r).issue_id;
        const row = db.get(`SELECT labels FROM issues WHERE id = ?`, [issueId]);
        assert.equal(row.labels, '["Bug","Priority: High"]');
        db.close();
    });
    it('derives the taxonomy default labels when omitted', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'unlabelled intent',
            intent_verbatim: 'x',
            branch_id: 'fix/unlabelled-intent',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const issueId = parse(r).issue_id;
        const row = db.get(`SELECT labels FROM issues WHERE id = ?`, [issueId]);
        assert.notEqual(row.labels, null);
        const labels = JSON.parse(row.labels);
        const classification = ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'];
        const priority = ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'];
        assert.equal(labels.filter((l) => classification.includes(l)).length, 1);
        assert.equal(labels.filter((l) => priority.includes(l)).length, 1);
        db.close();
    });
    it('rejects invalid labels with missing_required_labels', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'bad labels',
            intent_verbatim: 'x',
            branch_id: 'fix/bad-labels',
            labels: ['nonsense'],
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /missing_required_labels/);
        const count = db.get(`SELECT COUNT(*) AS n FROM issues WHERE id != -1`);
        assert.equal(count.n, 0);
        db.close();
    });
    it('reports area_inferred null when no area config is set', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'fix src/hooks/x.ts',
            intent_verbatim: 'x',
            branch_id: 'fix/no-area-config',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(parse(r)['area_inferred'], null);
        db.close();
    });
    describe('with issue_area_labels configured (GH 1770)', () => {
        function configure(db) {
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('issue_area_labels', ?), ('issue_area_paths', ?)`, [JSON.stringify(['Area: Alpha', 'Area: Beta']), JSON.stringify({ 'src/hooks/': 'Area: Alpha', 'docs/': 'Area: Beta' })]);
        }
        async function start(db, objective, labels) {
            const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
            return call(composites.handlers, 'intent_start', {
                agent: 'bro',
                objective,
                intent_verbatim: 'x',
                branch_id: 'feat/area-intent',
                ...(labels ? { labels } : {}),
            });
        }
        it('refuses no area and no path hit', async () => {
            const db = tempDB();
            configure(db);
            const r = await start(db, 'no paths here');
            assert.equal(r.isError, true);
            assert.match(parse(r)['error'], /^missing_required_labels: .*an area label \(one of: Area: Alpha, Area: Beta\)/);
            assert.equal(db.get(`SELECT COUNT(*) AS n FROM issues WHERE id != -1`).n, 0);
            db.close();
        });
        it('refuses two areas', async () => {
            const db = tempDB();
            configure(db);
            const r = await start(db, 'two areas', ['Bug', 'Priority: High', 'Area: Alpha', 'Area: Beta']);
            assert.equal(r.isError, true);
            assert.match(parse(r)['error'], /^multiple_area_labels:/);
            db.close();
        });
        it('refuses paths in two areas with ambiguous_area', async () => {
            const db = tempDB();
            configure(db);
            const r = await start(db, 'touch src/hooks/x.ts and docs/y.md');
            assert.equal(r.isError, true);
            assert.match(parse(r)['error'], /^ambiguous_area: intent_start .*Area: Alpha \(src\/hooks\/x\.ts\); Area: Beta \(docs\/y\.md\)/);
            db.close();
        });
        it('accepts one supplied area', async () => {
            const db = tempDB();
            configure(db);
            const r = await start(db, 'one area', ['Bug', 'Priority: High', 'Area: Beta']);
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            assert.equal(parse(r)['area_inferred'], null);
            db.close();
        });
        it('infers the area from the objective onto the default labels', async () => {
            const db = tempDB();
            configure(db);
            const r = await start(db, 'fix src/hooks/x.ts');
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            assert.equal(parse(r)['area_inferred'], 'Area: Alpha');
            const issueId = parse(r).issue_id;
            const row = db.get(`SELECT labels FROM issues WHERE id = ?`, [issueId]);
            assert.ok(JSON.parse(row.labels).includes('Area: Alpha'));
            db.close();
        });
    });
});
describe('filesToDirs (#300)', () => {
    it('derives unique dirs from a typed files[] array', () => {
        const files = [
            'src/api/handler.ts',
            'src/api/util.ts',
            'docs/guide.md',
            'README.md',
        ];
        assert.deepEqual(filesToDirs(files).sort(), ['', 'docs', 'src/api']);
    });
});
function seedTask(db, opts) {
    if (opts.repo) {
        db.run(`INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)`, [opts.repo, `/tmp/${opts.repo}`]);
    }
    db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'brief test obj', 'd', 'open', datetime('now'), datetime('now'))`);
    db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'pending', ?, ?, ?, 'abc123def', ?, datetime('now'), datetime('now'))`, [opts.spec, JSON.stringify(opts.files ?? []), JSON.stringify(opts.verification ?? []), opts.repo ?? null]);
    const row = db.get('SELECT last_insert_rowid() AS id');
    db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
     VALUES (1, 'bro', 'decision', 'Use approach B', datetime('now'))`);
    return row.id;
}
describe('task_brief (#300)', () => {
    const SPEC = ['## Files', '- `src/api/handler.ts` — edit', '', '## Success Criteria', '- SC1: works'].join('\n');
    it('bundles task meta + spec + discussions; flags world model unavailable when graph is null', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id, section: 'all' }));
        const out = parse(r);
        assert.equal(out['task_id'], id);
        assert.equal(out['branch_id'], 'fix/1-brief');
        assert.equal(out['spec_body'], SPEC);
        assert.equal(out['commit_sha'], 'abc123def', 'commit_sha in brief (code-reviewer needs it for the diff)');
        assert.equal(out['world_model_warning'], 'world-model-unavailable');
        const disc = out['task_discussions'];
        assert.ok(disc.some((d) => d.kind === 'decision' && d.body === 'Use approach B'));
        db.close();
    });
    it('populates scope_world_model from the typed files[] dirs via the graph', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC, files: ['src/api/handler.ts'] });
        // Stub graph: only allDirectoriesForRepo is exercised by task_brief.
        const stubGraph = {
            allDirectoriesForRepo: () => [
                { key: 'app:src/api', repo: 'app', path: 'src/api', parent_path: 'src', summary: 'api layer', summary_source: 'readme', summary_updated_at: null, file_count: 3 },
                { key: 'app:src/api/v2', repo: 'app', path: 'src/api/v2', parent_path: 'src/api', summary: 'v2 handlers', summary_source: 'llm', summary_updated_at: null, file_count: 1 },
            ],
        };
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', GraphHolder.fixed(stubGraph));
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id, section: 'scope' }));
        const out = parse(r);
        assert.equal(out['world_model_warning'], undefined);
        const scope = out['scope_world_model'];
        const apiDir = scope.find((sc) => sc.dir === 'src/api');
        assert.ok(apiDir, 'src/api in scope');
        assert.equal(apiDir.summary, 'api layer');
        assert.ok(apiDir.children.some((c) => c.path === 'src/api/v2'), 'child surfaced');
        db.close();
    });
    it('emits the typed files[] + verification[] contract; [] for a legacy default-verification row', async () => {
        const db = tempDB();
        const files = ['src/api/handler.ts', 'src/api/'];
        const verification = ['bun test', 'bash tests/l1-lint/dist-fresh.sh'];
        const id = seedTask(db, { repo: 'app', spec: SPEC, files, verification });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id, section: 'all' }));
        const out = parse(r);
        assert.deepEqual(out['files'], files, 'typed files[] round-trips');
        assert.deepEqual(out['verification'], verification, 'typed verification[] round-trips');
        db.close();
        // Legacy row: verification unset → schema DEFAULT '[]' → [] without error.
        const db2 = tempDB();
        const legacyId = seedTask(db2, { repo: 'app', spec: SPEC, files });
        const tools2 = compositeTools(db2, '/tmp/.claude/tmb/trajectory.db', null);
        const lr = (await tools2.handlers['task_brief']({ agent: 'swe', task_id: legacyId, section: 'verification' }));
        const lout = parse(lr);
        assert.deepEqual(lout['verification'], [], 'unset verification yields []');
        db2.close();
    });
    it('verification_run is null without a recorded run, else the latest run with its commands in order', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC, verification: ['npm test', 'bash lint.sh'] });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const brief = async () => parse((await tools.handlers['task_brief']({ agent: 'code-reviewer', task_id: id })));
        assert.equal((await brief())['verification_run'], null, 'no run recorded yet');
        db.run(`INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (7, ?, 'old0000', 'gate', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', 1, 900, 0),
              (8, ?, 'abc123def', 'gate', '2026-10-02T00:00:00.000Z', '2026-10-02T00:03:00.000Z', 0, 1200, 0)`, [id, id]);
        db.run(`INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail)
       VALUES (8, 2, 'bash lint.sh', 0, 0.5, 'ok'), (8, 1, 'npm test', 0, 170.25, 'pass'), (7, 1, 'npm test', 1, 3, 'fail')`);
        const out = await brief();
        assert.deepEqual(out['verification'], ['npm test', 'bash lint.sh'], 'verification[] commands are unchanged');
        assert.deepEqual(out['verification_run'], {
            run_id: 8,
            commit_sha: 'abc123def',
            source: 'gate',
            started_at: '2026-10-02T00:00:00.000Z',
            finished_at: '2026-10-02T00:03:00.000Z',
            exit_code: 0,
            timed_out: false,
            budget_s: 1200,
            commands: [
                { ordinal: 1, command: 'npm test', exit_code: 0, elapsed_s: 170.25 },
                { ordinal: 2, command: 'bash lint.sh', exit_code: 0, elapsed_s: 0.5 },
            ],
        });
        db.close();
    });
    it('a swe caller records the swe_brief_fetched sentinel once; bro and code-reviewer record none', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const sentinels = () => db.all(`SELECT from_node, content_json FROM audit WHERE event_type = 'swe_brief_fetched'`);
        await tools.handlers['task_brief']({ agent: 'bro', task_id: id });
        await tools.handlers['task_brief']({ agent: 'code-reviewer', task_id: id });
        assert.equal(sentinels().length, 0, 'bro and code-reviewer write no sentinel');
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const rows = sentinels();
        assert.equal(rows.length, 1, 'first swe call writes exactly one row');
        assert.equal(rows[0].from_node, 'swe');
        assert.deepEqual(JSON.parse(rows[0].content_json), { task_id: id, agent_type: 'swe' });
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        assert.equal(sentinels().length, 1, 'a second swe call adds none');
        db.close();
    });
    it('errors on a missing task', async () => {
        const db = tempDB();
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: 99999 }));
        assert.ok(r.isError);
        assert.match(parse(r)['error'], /No task/);
        db.close();
    });
    it('bounds discussions: decision/intent kept full, other kinds truncated + capped', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        const longBody = 'x'.repeat(2000);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'decision', ?, datetime('now', '+1 second'))`, [longBody]);
        for (let i = 0; i < 12; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
         VALUES (1, 'swe', 'note', ?, datetime('now', ?))`, [`note ${i}`, `+${10 + i} seconds`]);
        }
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'swe', 'note', ?, datetime('now', '+30 seconds'))`, [longBody]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id, section: 'history' }));
        const out = parse(r);
        const disc = out['task_discussions'];
        const longDecision = disc.find((d) => d.kind === 'decision' && d.body.length > 1000);
        assert.ok(longDecision, 'a long decision is present');
        assert.equal(longDecision.body.length, 2000, 'decision body kept full');
        assert.equal(longDecision.truncated, undefined, 'decision not truncated');
        const truncatedNote = disc.find((d) => d.truncated === true);
        assert.ok(truncatedNote, 'the long note was truncated');
        assert.ok(truncatedNote.body.length < 700, 'truncated body capped near 500 + pointer');
        assert.match(truncatedNote.body, /truncated; discussion_search\(issue_id=1\)/);
        const noteCount = disc.filter((d) => d.kind === 'note').length;
        assert.ok(noteCount <= 8, `non-full kinds capped to last 8 (got ${noteCount})`);
        db.close();
    });
});
describe('task_brief sections (GH 1743)', () => {
    const SPEC = ['## Description', 'do it', '', '## Success Criteria', '- SC1: works'].join('\n');
    const CORE_KEYS = [
        'task_id', 'issue_id', 'branch_id', 'title', 'objective', 'status', 'commit_sha', 'repo', 'worktree_path', 'effort',
        'spec_body', 'files', 'open_findings', 'completion_report', 'spawn_note', 'checkpoint', 'last_stop', 'locations',
    ];
    const ALL_KEYS = [
        ...CORE_KEYS, 'verification', 'verification_run', 'scope', 'scope_world_model', 'world_model_warning', 'task_discussions',
    ];
    let seq = 0;
    const seed = (db) => {
        const id = seedTask(db, { repo: 'app', spec: SPEC, files: ['src/a.ts'], verification: ['true'] });
        db.run('UPDATE tasks SET branch_id = ? WHERE id = ?', [`fix/sections-${++seq}`, id]);
        return id;
    };
    const brief = async (db, args) => (await compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null).handlers['task_brief'](args));
    const keys = (r) => Object.keys(parse(r)).sort();
    it('a swe call with no section returns the core fields plus sections; each other section returns exactly its fields', async () => {
        const db = tempDB();
        const id = seed(db);
        const core = parse(await brief(db, { agent: 'swe', task_id: id }));
        assert.deepEqual(Object.keys(core).sort(), [...CORE_KEYS, 'sections'].sort());
        assert.deepEqual(Object.keys(core['sections']).sort(), ['core', 'history', 'scope', 'verification']);
        assert.deepEqual(keys(await brief(db, { agent: 'swe', task_id: id, section: 'core' })), [...CORE_KEYS, 'sections'].sort());
        assert.deepEqual(keys(await brief(db, { agent: 'swe', task_id: id, section: 'verification' })), ['verification', 'verification_run']);
        assert.deepEqual(keys(await brief(db, { agent: 'swe', task_id: id, section: 'scope' })), ['scope', 'scope_world_model', 'world_model_warning']);
        assert.deepEqual(keys(await brief(db, { agent: 'swe', task_id: id, section: 'history' })), ['task_discussions']);
        assert.deepEqual(keys(await brief(db, { agent: 'swe', task_id: id, section: 'all' })), [...ALL_KEYS].sort(), 'all carries no sections hint');
        db.close();
    });
    it('worktree_path is the slug path under the repo when no path is recorded, and the recorded path when one is', async () => {
        const db = tempDB();
        const id = seed(db);
        const branch = db.get('SELECT branch_id FROM tasks WHERE id = ?', [id]).branch_id;
        const slug = branch.replace(/^[^/]+\//, '');
        const core = async () => parse(await brief(db, { agent: 'swe', task_id: id, section: 'core' }));
        assert.equal((await core())['worktree_path'], `/tmp/app/.claude/worktrees/${slug}`);
        db.run('UPDATE tasks SET worktree_path = ?, worktree_adopted = 1 WHERE id = ?', ['/tmp/adopted-session-worktree', id]);
        assert.equal((await core())['worktree_path'], '/tmp/adopted-session-worktree');
        db.close();
    });
    it('worktree_path is null with the rest of the brief intact when the repo path cannot be resolved', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('one', '/tmp/one'), ('two', '/tmp/two')`);
        const id = seedTask(db, { spec: SPEC, files: ['src/a.ts'], verification: ['true'] });
        const r = await brief(db, { agent: 'swe', task_id: id, section: 'core' });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const core = parse(r);
        assert.equal(core['worktree_path'], null);
        assert.deepEqual(Object.keys(core).sort(), [...CORE_KEYS, 'sections'].sort());
        assert.equal(core['spec_body'], SPEC);
        assert.equal(core['branch_id'], 'fix/1-brief');
        db.close();
    });
    it('bro and code-reviewer calls with no section return the full brief', async () => {
        const db = tempDB();
        const id = seed(db);
        for (const agent of ['bro', 'code-reviewer']) {
            assert.deepEqual(keys(await brief(db, { agent, task_id: id })), [...ALL_KEYS].sort(), agent);
        }
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (1, 'swe', 'note', 'n', datetime('now'))`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at, supersedes)
            VALUES (1, 'bro', 'decision', 'B2', datetime('now', '+1 second'), (SELECT MIN(id) FROM discussions))`);
        assert.ok(keys(await brief(db, { agent: 'bro', task_id: id })).includes('task_discussions_omitted'));
        db.close();
    });
    it('the swe core brief minus spec_body stays under 4000 characters for a heavy task', async () => {
        const db = tempDB();
        const files = ['src/a/', 'src/b/', 'src/c/', 'src/d/', 'src/e/', 'src/f/'];
        const verification = Array.from({ length: 10 }, (_, i) => `cd pkg${i} && bun run build && node --test dist/test/*.test.js`);
        const id = seedTask(db, { repo: 'app', spec: SPEC.repeat(20), files, verification });
        for (let i = 0; i < 29; i++) {
            db.run(`INSERT INTO discussions (issue_id, task_id, author, kind, body, created_at) VALUES (1, ?, 'bro', ?, ?, datetime('now', ?))`, [i % 2 ? id : null, i % 3 ? 'decision' : 'note', `row ${i} `.repeat(120), `+${i} seconds`]);
        }
        assert.equal(db.get('SELECT COUNT(*) AS n FROM discussions').n, 30);
        const stubGraph = {
            allDirectoriesForRepo: () => files.flatMap((f) => {
                const dir = f.slice(0, -1);
                return [
                    { path: dir, parent_path: 'src', summary: `${dir} — `.repeat(40) },
                    ...[1, 2, 3, 4].map((n) => ({ path: `${dir}/sub${n}`, parent_path: dir, summary: `${dir}/sub${n} `.repeat(30) })),
                ];
            }),
        };
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', GraphHolder.fixed(stubGraph));
        const run = async (section) => parse((await tools.handlers['task_brief']({ agent: 'swe', task_id: id, ...(section ? { section } : {}) })));
        const core = await run();
        delete core['spec_body'];
        const coreLen = JSON.stringify(core).length;
        assert.ok(coreLen < 4000, `core brief minus spec_body is ${coreLen} chars`);
        const all = await run('all');
        assert.equal(all['scope_world_model'].length, 6);
        assert.equal(all['verification'].length, 10);
        delete all['spec_body'];
        assert.ok(JSON.stringify(all).length > coreLen * 4, 'the full brief is several times the core one');
        db.close();
    });
    it('an unknown section is an error naming the valid values, with no side effects', async () => {
        const db = tempDB();
        const id = seed(db);
        const r = await brief(db, { agent: 'swe', task_id: id, section: 'nope' });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /unknown section "nope"; valid values: core, verification, scope, history, all/);
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_brief_fetched'`).n, 0);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ?', [id]).n, 0);
        db.close();
    });
    it('every swe section call records swe_brief_fetched once per task and opens the swe agent_runs row', async () => {
        const db = tempDB();
        for (const section of ['core', 'verification', 'scope', 'history', 'all']) {
            const id = seed(db);
            await brief(db, { agent: 'swe', task_id: id, section });
            await brief(db, { agent: 'swe', task_id: id, section });
            const sentinels = db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_brief_fetched' AND json_extract(content_json, '$.task_id') = ?`, [id]).n;
            assert.equal(sentinels, 1, `${section}: one sentinel`);
            const runs = db.all('SELECT agent_type, completed_at FROM agent_runs WHERE task_id = ?', [id]);
            assert.deepEqual(runs.map((r) => ({ ...r })), [{ agent_type: 'swe', completed_at: null }], `${section}: one open swe row`);
        }
        db.close();
    });
});
describe('task_provision (#157)', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
    // Build a real git repo with an `origin/main` remote-tracking ref. The repos
    // row carries target_branch='main' (the sole source of truth, #980), so the
    // composite branches from origin/main unless an explicit `base` is passed.
    function makeRepo() {
        const ws = mkdtempSync(join(tmpdir(), 'plan-task-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        git(repoRoot, 'init', '-q', '-b', 'main');
        git(repoRoot, 'config', 'user.email', 't@t.t');
        git(repoRoot, 'config', 'user.name', 't');
        writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
        git(repoRoot, 'add', '.');
        git(repoRoot, 'commit', '-q', '-m', 'base');
        // Fabricate the remote-tracking ref the composite branches from.
        git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
        return { ws, repoRoot, git };
    }
    function seedIssue(db, repoRoot) {
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
        db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    }
    it('refuses a repo outside the project with outside_project and writes nothing', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, '', null, { host: 'claude', projectRoot: join(ws, 'elsewhere') });
            mkdirSync(join(ws, 'elsewhere'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro', issue_id: 1, branch_id: 'feat/outside', decision_body: 'Chosen approach: outside the project.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.equal(r.isError, true);
            assert.equal(parse(r)['error'], 'outside_project');
            assert.equal(db.get('SELECT COUNT(*) AS c FROM tasks').c, 0, 'no task row');
            assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/outside'), 'no branch ref');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('waive_spec_shape writes one per-task spec_shape_gate_waived row in the require-task-spec shape; none without it; a short reason writes nothing', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const provision = (branch_id, extra) => call(composites.handlers, 'task_provision', {
                agent: 'bro', issue_id: 1, branch_id, decision_body: 'Chosen approach: waive the spec shape.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
                ...extra,
            });
            const waivers = () => db.all(`SELECT issue_id, branch_id, from_node, content_json FROM audit WHERE event_type = 'spec_shape_gate_waived' ORDER BY id`);
            const plain = parse(await provision('feat/no-waiver', {}));
            assert.equal(typeof plain['task_id'], 'number');
            assert.equal(waivers().length, 0, 'no row without waive_spec_shape');
            const waived = parse(await provision('feat/waived', { waive_spec_shape: true, waive_spec_shape_reason: 'spec names no new column' }));
            const rows = waivers();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].issue_id, 1);
            assert.equal(rows[0].branch_id, 'feat/waived');
            assert.equal(rows[0].from_node, 'bro');
            assert.deepEqual(JSON.parse(rows[0].content_json), {
                task_id: waived['task_id'], gate: 'spec_shape', reason: 'spec names no new column', waived_by: 'bro', source: 'task_provision',
            });
            const short = await provision('feat/short-reason', { waive_spec_shape: true, waive_spec_shape_reason: 'short' });
            assert.equal(short.isError, true);
            assert.match(String(parse(short)['error']), /waive_spec_shape_reason/);
            assert.equal(waivers().length, 1);
            assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/short-reason'), 'no branch ref');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('accepts session_id when passed or omitted, opens no bro row, and rejects an invalid one writing nothing', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const provision = (branch_id, extra) => call(composites.handlers, 'task_provision', {
                agent: 'bro', issue_id: 1, branch_id, decision_body: 'Chosen approach: stamp the session.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
                ...extra,
            });
            const stamped = parse(await provision('feat/session-a', { session_id: '0b5e-4c1d_abcdEF12' }));
            assert.equal(typeof stamped['task_id'], 'number');
            const omitted = parse(await provision('feat/session-b', {}));
            assert.equal(typeof omitted['task_id'], 'number');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`).c, 0);
            for (const bad of ['short', 'has space in it', 'x'.repeat(65), "evil';--x", 12345678]) {
                const r = await provision('feat/session-bad', { session_id: bad });
                assert.equal(r.isError, true, `session_id ${JSON.stringify(bad)} is rejected`);
                assert.match(String(parse(r)['error']), /session_id must be 8–64 characters/);
            }
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'feat/session-bad'`).c, 0);
            assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/session-bad'), 'no branch ref');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('happy path: writes decision + task + branch + worktree and returns the spawn-ready shape', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/the-thing',
                decision_body: 'Chosen approach: build X because Y; trade-off Z.',
                task: {
                    title: 'Do X',
                    description: 'implement X',
                    spec_body: SPEC,
                    files: ['src/x.ts'],
                    verification: ['bun run build'],
                    repo: 'app',
                },
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const out = parse(r);
            assert.equal(typeof out['task_id'], 'number');
            assert.equal(out['branch_id'], 'feat/the-thing');
            assert.equal(out['repo'], 'app');
            assert.equal(out['slug'], 'the-thing');
            assert.equal(out['git_setup'], 'created');
            assert.equal(out['worktree_path'], join(repoRoot, '.claude', 'worktrees', 'the-thing'));
            assert.equal(out['diagnostic'], undefined);
            const briefed = parse(await call(composites.handlers, 'task_brief', { agent: 'swe', task_id: out['task_id'], section: 'core' }));
            assert.equal(briefed['worktree_path'], out['worktree_path'], 'task_brief returns the provisioned path');
            // Decision discussion written.
            const decision = db.get(`SELECT body, author FROM discussions WHERE issue_id = 1 AND kind = 'decision' LIMIT 1`);
            assert.ok(decision);
            assert.match(decision.body, /Chosen approach/);
            assert.equal(decision.author, 'bro');
            // Task row written with typed fields.
            const task = db.get(`SELECT id, status, files, verification, repo, parent_branch_id FROM tasks WHERE id = ?`, [out['task_id']]);
            assert.ok(task);
            assert.equal(task.status, 'pending');
            assert.deepEqual(JSON.parse(task.files), ['src/x.ts']);
            assert.deepEqual(JSON.parse(task.verification), ['bun run build']);
            // parent_branch_id persisted = the resolved base (repos.target_branch='main' when no explicit base).
            assert.equal(task.parent_branch_id, 'main', 'parent_branch_id = defaulted base (repos.target_branch)');
            // planning_complete audit written; bro is metered per session, not per task.
            const audit = db.get(`SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'planning_complete'`);
            assert.equal(audit.c, 1);
            const run = db.get(`SELECT COUNT(*) AS c FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [out['task_id']]);
            assert.equal(run.c, 0);
            // Branch ref + worktree created on disk.
            assert.equal(git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/the-thing').length, 40);
            const wtList = git(repoRoot, 'worktree', 'list', '--porcelain');
            assert.match(wtList, /the-thing/);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('persists parent_branch_id = explicit base passed to task_provision', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            // Fabricate an origin/dev remote-tracking ref so an explicit base='dev' resolves.
            git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', git(repoRoot, 'rev-parse', 'HEAD'));
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/explicit-base',
                base: 'dev',
                decision_body: 'approach: branch from dev; trade-off none.',
                task: {
                    description: 'd',
                    spec_body: SPEC,
                    files: ['src/x.ts'],
                    verification: ['true'],
                    repo: 'app',
                },
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            const out = parse(r);
            const task = db.get(`SELECT parent_branch_id FROM tasks WHERE id = ?`, [out['task_id']]);
            assert.ok(task);
            assert.equal(task.parent_branch_id, 'dev', 'parent_branch_id = explicit base passed');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    describe('cut base (GH 1713)', () => {
        const provisionDev = (branch_id) => ({
            agent: 'bro', issue_id: 1, branch_id, base: 'dev', decision_body: 'approach: cut from dev; trade-off none.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
        });
        const commitOn = (repoRoot, git, parent, msg) => git(repoRoot, 'commit-tree', git(repoRoot, 'rev-parse', 'HEAD^{tree}'), '-p', parent, '-m', msg);
        it('cuts at local dev when it is one commit ahead of origin/dev; base_ref is dev', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                const head = git(repoRoot, 'rev-parse', 'HEAD');
                git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', head);
                const localDev = commitOn(repoRoot, git, head, 'unpushed');
                git(repoRoot, 'update-ref', 'refs/heads/dev', localDev);
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionDev('feat/local-ahead'));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                const out = parse(r);
                assert.equal(out['base_ref'], 'dev');
                assert.equal(out['base_diverged'], undefined);
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/local-ahead'), localDev, 'cut at local dev');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('a diverged dev cuts at origin/dev and reports base_diverged', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                const head = git(repoRoot, 'rev-parse', 'HEAD');
                const remoteDev = commitOn(repoRoot, git, head, 'pushed elsewhere');
                const localDev = commitOn(repoRoot, git, head, 'local only');
                git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', remoteDev);
                git(repoRoot, 'update-ref', 'refs/heads/dev', localDev);
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionDev('feat/diverged-base'));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                const out = parse(r);
                assert.equal(out['base_ref'], 'origin/dev');
                const diverged = out['base_diverged'];
                assert.ok(diverged, 'base_diverged present');
                assert.equal(diverged['local_sha'], localDev);
                assert.equal(diverged['remote_sha'], remoteDev);
                assert.equal(diverged['ahead'], 1);
                assert.equal(diverged['behind'], 1);
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/diverged-base'), remoteDev, 'cut at origin/dev');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
    });
    describe('input shape (GH 1855)', () => {
        const provisionArgs = (branch_id, extra, task = {}) => ({
            agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: input shape; trade-off none.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], ...task },
            ...extra,
        });
        const addWebRepo = (ws, git) => {
            const root = join(ws, 'web');
            mkdirSync(root, { recursive: true });
            git(root, 'init', '-q', '-b', 'main');
            git(root, 'config', 'user.email', 't@t.t');
            git(root, 'config', 'user.name', 't');
            writeFileSync(join(root, 'w.txt'), 'web\n');
            git(root, 'add', '.');
            git(root, 'commit', '-q', '-m', 'web base');
            git(root, 'update-ref', 'refs/remotes/origin/main', git(root, 'rev-parse', 'HEAD'));
            return root;
        };
        it("base 'origin/dev' against a real origin remote provisions from origin/dev and records parent_branch_id 'dev'", async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                git(repoRoot, 'update-ref', '-d', 'refs/remotes/origin/main');
                git(repoRoot, 'branch', 'dev');
                const origin = join(ws, 'origin.git');
                git(ws, 'init', '-q', '--bare', origin);
                git(repoRoot, 'remote', 'add', 'origin', origin);
                git(repoRoot, 'push', '-q', 'origin', 'main', 'dev');
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/origin-prefixed', { base: 'origin/dev' }, { repo: 'app' }));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                const out = parse(r);
                assert.equal(out['base_ref'], 'origin/dev');
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/origin-prefixed'), git(repoRoot, 'rev-parse', 'refs/remotes/origin/dev'));
                const row = db.get('SELECT parent_branch_id FROM tasks WHERE id = ?', [out['task_id']]);
                assert.equal(row.parent_branch_id, 'dev');
                const missing = await call(composites.handlers, 'task_provision', provisionArgs('feat/origin-missing', { base: 'origin/nope' }, { repo: 'app' }));
                assert.equal(missing.isError, true);
                assert.match(String(parse(missing)['error']), /base does not resolve as 'origin\/nope' or local 'nope'/);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it("no task.repo in a two-repo workspace: provisions in the issue's repo", async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                const webRoot = addWebRepo(ws, git);
                const db = tempDB();
                seedIssue(db, repoRoot);
                db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('web', ?, 'main')`, [webRoot]);
                db.run(`UPDATE issues SET repo = 'web' WHERE id = 1`);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/issue-repo', {}));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                const out = parse(r);
                assert.equal(out['repo'], 'web');
                assert.equal(out['worktree_path'], join(webRoot, '.claude', 'worktrees', 'issue-repo'));
                assert.equal(git(webRoot, 'rev-parse', '--verify', 'refs/heads/feat/issue-repo').length, 40);
                assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/issue-repo'));
                const explicit = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/task-repo', {}, { repo: 'app' })));
                assert.equal(explicit['repo'], 'app', 'task.repo wins over the issue repo');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('no task.repo and no issue repo: sole repo when one, the existing refusal when two', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const sole = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/sole-repo', {})));
                assert.equal(sole['repo'], 'app');
                db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('web', ?, 'main')`, [addWebRepo(ws, git)]);
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/no-repo', {}));
                assert.equal(r.isError, true);
                assert.match(String(parse(r)['error']), /cannot resolve a repo path for git setup \(task\.repo=''\)/);
                assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'feat/no-repo'`).c, 0);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it("an issue-sourced repo gets the same '..' check as task.repo", async () => {
            const { ws, repoRoot } = makeRepo();
            try {
                const db = tempDB();
                seedIssue(db, repoRoot);
                db.run(`INSERT INTO repos (name, path) VALUES ('../evil', ?)`, [repoRoot]);
                db.run(`UPDATE issues SET repo = '../evil' WHERE id = 1`);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/evil-repo', {}));
                assert.equal(r.isError, true);
                assert.match(String(parse(r)['error']), /Invalid repo "\.\.\/evil": must not contain "\.\."/);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it("the schema states the required non-empty fields and that base accepts 'origin/<branch>'", () => {
            const db = tempDB();
            const def = compositeTools(db, '').definitions.find((d) => d.name === 'task_provision');
            const props = def.inputSchema.properties;
            const taskProps = props['task'].properties;
            assert.match(taskProps['description'].description, /Required, non-empty/);
            assert.match(taskProps['spec_body'].description, /Required, non-empty/);
            assert.match(props['base'].description, /'origin\/dev'/);
            assert.match(taskProps['repo'].description, /defaults to the issue's repo/);
            db.close();
        });
    });
    it('idempotent re-run reuses the existing branch + worktree (git_setup: reused)', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            // Two issues sharing one branch_id: the (issue_id, branch_id) UNIQUE
            // constraint means a re-run must use a DIFFERENT issue. The git setup,
            // keyed on branch_id/slug, is what must be idempotent.
            db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (2, 'o2', 'd', 'open', datetime('now'), datetime('now'))`);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const baseArgs = {
                agent: 'bro',
                branch_id: 'feat/reuse-me',
                decision_body: 'approach: reuse path; trade-off none.',
                task: {
                    description: 'd',
                    spec_body: SPEC,
                    files: ['src/x.ts'],
                    verification: ['true'],
                    repo: 'app',
                },
            };
            const first = parse(await call(composites.handlers, 'task_provision', { ...baseArgs, issue_id: 1 }));
            assert.equal(first['git_setup'], 'created');
            assert.equal(first['worktree_reused'], false);
            const second = parse(await call(composites.handlers, 'task_provision', { ...baseArgs, issue_id: 2 }));
            assert.equal(second['git_setup'], 'reused', 'existing branch + worktree reused, not error');
            assert.equal(second['worktree_reused'], true);
            assert.equal(second['worktree_path'], first['worktree_path']);
            assert.notEqual(second['task_id'], first['task_id']);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('atomicity: base-unresolvable git failure leaves NO task row; retry with a valid base + same branch_id succeeds', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'plan-task-nobase-'));
        try {
            const db = tempDB();
            // A real git repo but WITHOUT the origin/<base> remote-tracking ref, so
            // the base pre-validation fails and the branch is never created.
            const repoRoot = join(ws, 'app');
            mkdirSync(repoRoot, { recursive: true });
            const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
            git(repoRoot, 'init', '-q', '-b', 'main');
            git(repoRoot, 'config', 'user.email', 't@t.t');
            git(repoRoot, 'config', 'user.name', 't');
            writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'base');
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
            db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const baseTaskArgs = {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/atomic',
                decision_body: 'approach: x; trade-off y.',
                task: {
                    description: 'd',
                    spec_body: SPEC,
                    files: ['src/x.ts'],
                    verification: ['true'],
                    repo: 'app',
                },
            };
            // base 'no-such-base' has no origin/ ref → error, nothing persisted.
            const r = await call(composites.handlers, 'task_provision', {
                ...baseTaskArgs,
                base: 'no-such-base',
            });
            assert.ok(r.isError, 'unresolvable base must be a tool error');
            assert.match(parse(r)['error'], /does not resolve|No task row was created/);
            // No task row, no decision, no branch ref — the (issue_id, branch_id) slot is free.
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 0, 'no orphan task row after base-unresolvable git failure');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1 AND kind = 'decision'`).c, 0, 'no orphan decision after git failure');
            // Retry with a valid base (origin/main, fabricated here) + SAME branch_id succeeds.
            git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
            const retry = await call(composites.handlers, 'task_provision', {
                ...baseTaskArgs,
                base: 'main',
            });
            assert.ok(!retry.isError, `retry with a valid base must succeed: ${JSON.stringify(parse(retry))}`);
            const out = parse(retry);
            assert.equal(out['branch_id'], 'feat/atomic');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 1, 'retry creates exactly one task row');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('atomicity: repo-unresolvable git failure leaves NO task row; retry with a valid repo + same branch_id succeeds', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB();
            // Multi-repo workspace: register only 'app' (target_branch='main' so the
            // base resolves on retry). The first call names a repo that does not
            // resolve to a repos.path.
            db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
            db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const baseTaskArgs = {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/repo-atomic',
                decision_body: 'approach: x; trade-off y.',
                task: {
                    description: 'd',
                    spec_body: SPEC,
                    files: ['src/x.ts'],
                    verification: ['true'],
                },
            };
            // repo 'ghost' resolves to the literal name 'ghost' (no repos.path) — git
            // commands run against a non-existent dir and fail. Nothing persisted.
            const r = await call(composites.handlers, 'task_provision', {
                ...baseTaskArgs,
                task: { ...baseTaskArgs.task, repo: 'ghost' },
            });
            assert.ok(r.isError, 'unresolvable repo must be a tool error');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 0, 'no orphan task row after repo-unresolvable git failure');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1 AND kind = 'decision'`).c, 0, 'no orphan decision after git failure');
            // Retry with a valid repo + SAME branch_id succeeds.
            const retry = await call(composites.handlers, 'task_provision', {
                ...baseTaskArgs,
                task: { ...baseTaskArgs.task, repo: 'app' },
            });
            assert.ok(!retry.isError, `retry with a valid repo must succeed: ${JSON.stringify(parse(retry))}`);
            const out = parse(retry);
            assert.equal(out['repo'], 'app');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 1, 'retry creates exactly one task row');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('remoteless repo: base falls back to the local branch, branch created from local ref (#1063)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'plan-task-local-'));
        try {
            const repoRoot = join(ws, 'app');
            mkdirSync(repoRoot, { recursive: true });
            const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
            // A repo with NO remotes at all: only a local `dev` branch exists.
            git(repoRoot, 'init', '-q', '-b', 'dev');
            git(repoRoot, 'config', 'user.email', 't@t.t');
            git(repoRoot, 'config', 'user.name', 't');
            writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'base');
            const localDevSha = git(repoRoot, 'rev-parse', 'refs/heads/dev');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
            db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/local-base',
                base: 'dev',
                decision_body: 'approach: branch from local dev; trade-off none.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(!r.isError, `remoteless provision must succeed via the local fallback: ${JSON.stringify(parse(r))}`);
            // Task row created + the new branch points at the LOCAL dev ref.
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 1);
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/local-base'), localDevSha, 'branch created from the local dev ref when no origin exists');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('origin/<base> wins over a diverging local branch (origin preference unchanged, #1063)', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            // origin/main was fabricated at the base commit in makeRepo. Give origin
            // and the LOCAL main one commit each so the two diverge (a local main
            // only ahead is cut from, GH 1713); the branch must follow origin.
            const baseSha = git(repoRoot, 'rev-parse', 'HEAD');
            const originMainSha = git(repoRoot, 'commit-tree', git(repoRoot, 'rev-parse', 'HEAD^{tree}'), '-p', baseSha, '-m', 'origin advance');
            git(repoRoot, 'update-ref', 'refs/remotes/origin/main', originMainSha);
            writeFileSync(join(repoRoot, 'a.txt'), 'two\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'local advance');
            const localMainSha = git(repoRoot, 'rev-parse', 'refs/heads/main');
            assert.notEqual(originMainSha, localMainSha, 'precondition: origin/main and local main diverge');
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/prefers-origin',
                base: 'main',
                decision_body: 'approach: branch from origin/main; trade-off none.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/prefers-origin'), originMainSha, 'branch follows origin/main, not the diverged local main');
            assert.equal(parse(r)['base_ref'], 'origin/main');
            assert.ok(parse(r)['base_diverged'], 'divergence is reported');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('neither origin/<base> nor local <base> resolves: error names both forms, no task row (#1063)', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB();
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/no-base',
                base: 'ghost-base',
                decision_body: 'approach: x; trade-off y.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(r.isError, 'an unresolvable base must be a tool error');
            const msg = parse(r)['error'];
            assert.match(msg, /origin\/ghost-base/, 'error names the tried origin form');
            assert.match(msg, /local 'ghost-base'/, 'error names the tried local form');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 0, 'no orphan task row when neither base ref resolves');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    describe('existing branch policy', () => {
        const provisionArgs = (branch_id, extra = {}) => ({
            agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: existing-branch policy; trade-off none.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            ...extra,
        });
        // Advance origin/main by one commit without touching the local checkout.
        function advanceOrigin(repoRoot, git) {
            const tree = git(repoRoot, 'rev-parse', 'HEAD^{tree}');
            const sha = git(repoRoot, 'commit-tree', tree, '-p', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'), '-m', 'origin advance');
            git(repoRoot, 'update-ref', 'refs/remotes/origin/main', sha);
            return sha;
        }
        // A local branch carrying one commit that base does not have.
        function divergedBranch(repoRoot, git, branch) {
            const tree = git(repoRoot, 'rev-parse', 'HEAD^{tree}');
            const sha = git(repoRoot, 'commit-tree', tree, '-p', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'), '-m', 'stale work');
            git(repoRoot, 'update-ref', `refs/heads/${branch}`, sha);
        }
        it('fresh branch_id: git_setup created, worktree_reused false', async () => {
            const { ws, repoRoot } = makeRepo();
            try {
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/fresh')));
                assert.equal(out['git_setup'], 'created');
                assert.equal(out['worktree_reused'], false);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('existing branch behind the base tip is fast-forwarded and reported reused', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                git(repoRoot, 'branch', 'feat/behind', 'refs/remotes/origin/main');
                const newTip = advanceOrigin(repoRoot, git);
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/behind'));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                assert.equal(parse(r)['git_setup'], 'reused');
                assert.equal(parse(r)['worktree_reused'], false);
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/behind'), newTip, 'fast-forwarded to the base tip');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('existing branch checked out in its worktree is fast-forwarded there', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                git(repoRoot, 'branch', 'feat/checked-out', 'refs/remotes/origin/main');
                git(repoRoot, 'worktree', 'add', '-q', join(repoRoot, '.claude', 'worktrees', 'checked-out'), 'feat/checked-out');
                const newTip = advanceOrigin(repoRoot, git);
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/checked-out')));
                assert.equal(out['git_setup'], 'reused');
                assert.equal(out['worktree_reused'], true);
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/checked-out'), newTip);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('branch only on origin, ancestor of base: local ref created at the base tip, reported reused', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                git(repoRoot, 'update-ref', 'refs/remotes/origin/feat/remote-only', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'));
                const newTip = advanceOrigin(repoRoot, git);
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/remote-only')));
                assert.equal(out['git_setup'], 'reused');
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/remote-only'), newTip);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('diverged branch is refused with branch_exists_diverged + distance; nothing written', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                divergedBranch(repoRoot, git, 'feat/stale');
                advanceOrigin(repoRoot, git);
                const before = git(repoRoot, 'rev-parse', 'refs/heads/feat/stale');
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/stale'));
                assert.equal(r.isError, true);
                const out = parse(r);
                assert.equal(out['error'], 'branch_exists_diverged');
                assert.equal(out['ref'], 'refs/heads/feat/stale');
                assert.equal(out['base'], 'origin/main');
                assert.equal(out['ahead'], 1);
                assert.equal(out['behind'], 1);
                assert.deepEqual(out['open_prs'], []);
                assert.match(String(out['message']), /branch_id_propose/);
                assert.match(String(out['message']), /reuse_existing/);
                assert.equal(db.get('SELECT COUNT(*) AS c FROM tasks').c, 0, 'no task row');
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/stale'), before, 'ref untouched');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('diverged refusal names the open PR when the sync gate is on (mocked gh)', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                divergedBranch(repoRoot, git, 'feat/has-pr');
                const db = tempDB();
                seedIssue(db, repoRoot);
                upsertRepoRemotes(db, 'app', [{ name: 'origin', url: 'https://github.com/acme/app.git', provider: 'github' }]);
                db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
                const calls = [];
                const spawnFn = (cmd, a) => {
                    calls.push([cmd, ...a]);
                    return { status: 0, stdout: JSON.stringify([{ number: 42, url: 'https://github.com/acme/app/pull/42' }]), stderr: '' };
                };
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/has-pr', { _spawnFn: spawnFn }));
                const out = parse(r);
                assert.equal(out['error'], 'branch_exists_diverged');
                assert.deepEqual(out['open_prs'], [{ backend: 'gh', number: 42, url: 'https://github.com/acme/app/pull/42' }]);
                assert.match(String(out['message']), /pull\/42/);
                assert.deepEqual(calls[0].slice(0, 5), ['gh', 'pr', 'list', '--head', 'feat/has-pr']);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('sync gate off: no remote call is made for the PR lookup', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                divergedBranch(repoRoot, git, 'feat/gate-off');
                const db = tempDB();
                seedIssue(db, repoRoot);
                upsertRepoRemotes(db, 'app', [{ name: 'origin', url: 'https://github.com/acme/app.git', provider: 'github' }]);
                let called = 0;
                const spawnFn = () => { called++; return { status: 0, stdout: '[]', stderr: '' }; };
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/gate-off', { _spawnFn: spawnFn })));
                assert.equal(out['error'], 'branch_exists_diverged');
                assert.equal(called, 0);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('reuse_existing keeps a diverged branch as-is and reports reused', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                divergedBranch(repoRoot, git, 'feat/keep-me');
                const before = git(repoRoot, 'rev-parse', 'refs/heads/feat/keep-me');
                const db = tempDB();
                seedIssue(db, repoRoot);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/keep-me', { reuse_existing: true }));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                assert.equal(parse(r)['git_setup'], 'reused');
                assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/keep-me'), before, 'diverged ref kept');
                assert.equal(db.get('SELECT COUNT(*) AS c FROM tasks').c, 1);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('GH 1731: a branch_id the issue already uses is refused with branch_id_used_on_issue, with and without reuse_existing, changing no ref, worktree or row', async () => {
            const { ws, repoRoot, git } = makeRepo();
            try {
                git(repoRoot, 'branch', 'feat/dup', 'refs/remotes/origin/main');
                advanceOrigin(repoRoot, git);
                const db = tempDB();
                seedIssue(db, repoRoot);
                db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, commit_sha, created_at, updated_at)
           VALUES (1, 'feat/dup', '', 'd', 'closed', ?, 'app', 'abc1234', datetime('now'), datetime('now'))`, [SPEC]);
                const existingId = db.get(`SELECT id FROM tasks WHERE branch_id = 'feat/dup'`).id;
                const snapshot = () => ({
                    ref: git(repoRoot, 'rev-parse', 'refs/heads/feat/dup'),
                    worktrees: git(repoRoot, 'worktree', 'list', '--porcelain'),
                    tasks: db.get('SELECT COUNT(*) AS c FROM tasks').c,
                    discussions: db.get('SELECT COUNT(*) AS c FROM discussions').c,
                    audit: db.get('SELECT COUNT(*) AS c FROM audit').c,
                });
                const before = snapshot();
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                for (const extra of [{}, { reuse_existing: true }]) {
                    const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/dup', extra));
                    assert.equal(r.isError, true);
                    const out = parse(r);
                    assert.equal(out['error'], 'branch_id_used_on_issue', JSON.stringify(out));
                    assert.equal(out['issue_id'], 1);
                    assert.equal(out['branch_id'], 'feat/dup');
                    assert.equal(out['task_id'], existingId);
                    assert.equal(out['status'], 'closed');
                    assert.equal(out['commit_sha'], 'abc1234');
                    assert.match(String(out['message']), new RegExp(`task_reopen\\(task_id=${existingId}\\)`));
                    assert.match(String(out['message']), /pick a new name with branch_id_propose, or call task_provision with base='feat\/dup' to stack on it\./);
                    assert.match(String(out['message']), /No task row or branch was changed\.$/);
                    assert.deepEqual(snapshot(), before);
                }
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('GH 1731: the existing task with no commit_sha reports commit_sha null', async () => {
            const { ws, repoRoot } = makeRepo();
            try {
                const db = tempDB();
                seedIssue(db, repoRoot);
                db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
           VALUES (1, 'feat/no-sha', '', 'd', 'pending', ?, 'app', datetime('now'), datetime('now'))`, [SPEC]);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/no-sha')));
                assert.equal(out['error'], 'branch_id_used_on_issue');
                assert.equal(out['status'], 'pending');
                assert.equal(out['commit_sha'], null);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('GH 1731: the same branch_id used by a different issue still provisions', async () => {
            const { ws, repoRoot } = makeRepo();
            try {
                const db = tempDB();
                seedIssue(db, repoRoot);
                db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
                VALUES (2, 'o2', 'd2', 'open', datetime('now'), datetime('now'))`);
                db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
           VALUES (2, 'feat/shared', '', 'd', 'closed', ?, 'app', datetime('now'), datetime('now'))`, [SPEC]);
                const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
                const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/shared'));
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                assert.equal(parse(r)['git_setup'], 'created');
                assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'feat/shared'`).c, 2);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'task_provision', {
            agent: 'swe',
            issue_id: 1,
            branch_id: 'feat/nope',
            decision_body: 'x',
            task: { description: 'd', spec_body: SPEC, files: ['a'], verification: ['true'] },
        });
        assert.equal(r.isError, true);
        db.close();
    });
    it('world-model-cold + no waiver: registry_cold_violation with zero side effects (#44)', async () => {
        const { ws, repoRoot, git } = makeRepo();
        try {
            const db = tempDB({ seedScan: false });
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/cold-thing',
                decision_body: 'approach: x; trade-off y.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(r.isError, 'a cold world model with no waiver must be a tool error');
            const out = parse(r);
            assert.equal(out['error'], 'registry_cold_violation');
            assert.match(out['message'], /task_provision/, 'message names the tool');
            assert.match(out['message'], /\/scan|scan_run/, 'message points at /scan or scan_run');
            // No side effects: no task row, no discussion row, no branch ref.
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 0, 'no task row');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1`).c, 0, 'no discussion row');
            let branchExists = true;
            try {
                git(repoRoot, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/cold-thing');
            }
            catch {
                branchExists = false;
            }
            assert.equal(branchExists, false, 'no branch ref created');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('world-model-cold + waiver ≥10 chars: proceeds and records registry_gate_waived (#44)', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB({ seedScan: false });
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/waived-thing',
                decision_body: 'approach: x; trade-off y.',
                waive_registry_gate: true,
                waive_registry_gate_reason: 'scan cannot run in this sandbox',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(typeof parse(r)['task_id'], 'number');
            const waived = db.get(`SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'registry_gate_waived'`);
            assert.equal(waived.c, 1, 'registry_gate_waived audit row recorded');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('world-model-cold + waiver <10 chars: rejected the same as task_create_batch (#44)', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB({ seedScan: false });
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/short-reason',
                decision_body: 'approach: x; trade-off y.',
                waive_registry_gate: true,
                waive_registry_gate_reason: 'too short',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(r.isError, 'a short waiver reason must be a tool error');
            assert.match(parse(r)['error'], /waive_registry_gate_reason must be a string ≥10 chars/);
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`).c, 0, 'no task row');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('warm world model (deep_scan_completed present): behavior unchanged, proceeds (#44)', async () => {
        const { ws, repoRoot } = makeRepo();
        try {
            const db = tempDB(); // default seeds a deep_scan_completed audit row
            seedIssue(db, repoRoot);
            const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
            const r = await call(composites.handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/warm-thing',
                decision_body: 'approach: x; trade-off y.',
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(typeof parse(r)['task_id'], 'number');
            assert.equal(db.get(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'registry_gate_waived'`).c, 0, 'no waiver audit row on the warm path');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('task_reopen + task_update_spec', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
    function setup() {
        const ws = mkdtempSync(join(tmpdir(), 'reopen-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        git(repoRoot, 'init', '-q', '-b', 'main');
        git(repoRoot, 'config', 'user.email', 't@t.t');
        git(repoRoot, 'config', 'user.name', 't');
        writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
        git(repoRoot, 'add', '.');
        git(repoRoot, 'commit', '-q', '-m', 'base');
        git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        const handlers = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers;
        return { ws, repoRoot, db, handlers, git };
    }
    async function provision(handlers, branch_id) {
        const out = parse(await call(handlers, 'task_provision', {
            agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: lifecycle fixture.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
        }));
        return out['task_id'];
    }
    const taskRow = (db, id) => db.get(`SELECT status, files, verification, spec_body, completed_at FROM tasks WHERE id = ?`, [id]);
    const auditOf = (db, eventType) => db.all(`SELECT from_node, summary, content_json FROM audit WHERE event_type = ? ORDER BY id`, [eventType]);
    for (const fromStatus of ['closed', 'failed', 'escalated', 'running']) {
        it(`task_reopen: ${fromStatus} → running, fences appended, decision + task_reopened audit`, async () => {
            const { ws, db, handlers } = setup();
            try {
                const id = await provision(handlers, `fix/reopen-${fromStatus}`);
                db.run(`UPDATE tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`, [fromStatus, id]);
                const r = await call(handlers, 'task_reopen', {
                    agent: 'bro', task_id: id, reason: 'review found a missing test',
                    files_add: ['src/y.ts', 'src/x.ts'], verification_add: ['npm test'],
                });
                assert.ok(!r.isError, JSON.stringify(parse(r)));
                const out = parse(r);
                assert.equal(out['from_status'], fromStatus);
                assert.equal(out['status'], 'running');
                const row = taskRow(db, id);
                assert.equal(row.status, 'running');
                assert.equal(row.completed_at, null);
                assert.deepEqual(JSON.parse(row.files), ['src/x.ts', 'src/y.ts'], 'appended, duplicates ignored');
                assert.deepEqual(JSON.parse(row.verification), ['true', 'npm test']);
                const audit = auditOf(db, 'task_reopened');
                assert.equal(audit.length, 1);
                assert.equal(audit[0].from_node, 'bro');
                assert.deepEqual(JSON.parse(audit[0].content_json), {
                    task_id: id, from_status: fromStatus, reason: 'review found a missing test',
                    files_add: ['src/y.ts', 'src/x.ts'], verification_add: ['npm test'],
                });
                const decision = db.get(`SELECT body FROM discussions WHERE kind = 'decision' AND body LIKE 'Task % reopened%'`);
                assert.match(decision.body, new RegExp(`reopened from ${fromStatus}: review found a missing test`));
                assert.match(decision.body, /files\[\] \+= src\/y\.ts, src\/x\.ts/);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
    }
    it('task_provision, task_create_batch, task_reopen and task_retry accept session_id and open no per-task bro row', async () => {
        const { ws, db, handlers } = setup();
        try {
            const perTaskBro = () => db.get(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro' AND task_id IS NOT NULL`).c;
            const SESSION = 'sess-1234abcd';
            const provisioned = parse(await call(handlers, 'task_provision', {
                agent: 'bro', issue_id: 1, branch_id: 'fix/metered', decision_body: 'approach: session metering fixture.', session_id: SESSION,
                task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
            }));
            const id = provisioned['task_id'];
            assert.ok(id > 0, JSON.stringify(provisioned));
            const WAIVE = 'unit test of session metering';
            const created = parseBatch(await call(taskTools(db).handlers, 'task_create_batch', {
                agent: 'bro', issue_id: '1', session_id: SESSION,
                waive_intent_gate: true, waive_intent_gate_reason: WAIVE, waive_decision_gate: true, waive_decision_gate_reason: WAIVE,
                waive_branch_gate: true, waive_branch_gate_reason: WAIVE, waive_scope_gate: true, waive_scope_gate_reason: WAIVE,
                waive_spec_shape: true, waive_spec_shape_reason: WAIVE,
                tasks: [{ branch_id: 'fix/metered-batch', description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' }],
            }));
            const batchId = created[0]['id'];
            db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
            const reopened = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review failed', session_id: SESSION });
            assert.ok(!reopened.isError, JSON.stringify(parse(reopened)));
            const bad = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x', session_id: 'short' });
            assert.equal(bad.isError, true);
            assert.match(String(parse(bad)['error']), /session_id must be 8–64 characters/);
            db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [batchId]);
            const retried = parse(await call(handlers, 'task_retry', {
                agent: 'bro', failed_task_id: String(batchId), new_branch_id: 'fix/metered-retry', corrected_spec_body: SPEC,
                retry_rationale: 'retry for session metering', description: 'd', session_id: SESSION,
            }));
            assert.ok(retried['task_id'] > 0, JSON.stringify(retried));
            assert.equal(perTaskBro(), 0, 'no task tool opens a per-task bro row');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_reopen recreates a missing worktree and leaves an existing one alone', async () => {
        const { ws, repoRoot, db, handlers, git } = setup();
        try {
            const id = await provision(handlers, 'fix/rework');
            const wt = join(repoRoot, '.claude', 'worktrees', 'rework');
            git(repoRoot, 'worktree', 'remove', '--force', wt);
            db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
            const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review failed' }));
            assert.equal(out['worktree_recreated'], true);
            assert.equal(out['worktree_path'], wt);
            assert.match(git(repoRoot, 'worktree', 'list', '--porcelain'), /worktrees\/rework/);
            const again = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'second pass' }));
            assert.equal(again['from_status'], 'running');
            assert.equal(again['worktree_recreated'], false);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_reopen on a pending task moves it to running and creates the missing worktree', async () => {
        const { ws, repoRoot, db, handlers, git } = setup();
        try {
            const id = await provision(handlers, 'fix/undispatched');
            const wt = join(repoRoot, '.claude', 'worktrees', 'undispatched');
            git(repoRoot, 'worktree', 'remove', '--force', wt);
            db.run(`UPDATE tasks SET status = 'pending' WHERE id = ?`, [id]);
            const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'dispatch the planned task' }));
            assert.equal(out['from_status'], 'pending');
            assert.equal(out['status'], 'running');
            assert.equal(out['worktree_recreated'], true);
            assert.equal(out['worktree_path'], wt);
            assert.equal(taskRow(db, id).status, 'running');
            assert.match(git(repoRoot, 'worktree', 'list', '--porcelain'), /worktrees\/undispatched/);
            assert.equal(auditOf(db, 'task_reopened').length, 1);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_reopen refuses completed/needs_validation tasks, a closed issue, and a missing reason', async () => {
        const { ws, db, handlers } = setup();
        try {
            const id = await provision(handlers, 'fix/not-reopenable');
            for (const status of ['completed', 'needs_validation']) {
                db.run(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
                const r = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x' });
                assert.equal(r.isError, true, status);
                assert.match(String(parse(r)['error']), /task_update_spec/);
            }
            db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
            const noReason = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: '  ' });
            assert.equal(noReason.isError, true);
            db.run(`UPDATE issues SET status = 'closed' WHERE id = 1`);
            const closedIssue = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x' });
            assert.equal(closedIssue.isError, true);
            assert.match(String(parse(closedIssue)['error']), /issue 1 is closed/);
            assert.equal(taskRow(db, id).status, 'closed');
            assert.equal(auditOf(db, 'task_reopened').length, 0);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_reopen and task_update_spec reject swe', async () => {
        const { ws, db, handlers } = setup();
        try {
            const id = await provision(handlers, 'fix/role-gate');
            db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
            const reopen = await call(handlers, 'task_reopen', { agent: 'swe', task_id: id, reason: 'x', files_add: ['b'] });
            assert.equal(reopen.isError, true);
            assert.equal(parse(reopen)['error'], 'forbidden');
            const amend = await call(handlers, 'task_update_spec', { agent: 'swe', task_id: id, reason: 'x', files: ['b'] });
            assert.equal(amend.isError, true);
            assert.equal(parse(amend)['error'], 'forbidden');
            assert.deepEqual(JSON.parse(taskRow(db, id).files), ['src/x.ts']);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_update_spec replaces fields and records an old→new summary', async () => {
        const { ws, db, handlers } = setup();
        try {
            const id = await provision(handlers, 'fix/amend');
            const newSpec = `${SPEC}\n- SC2: also this`;
            const r = await call(handlers, 'task_update_spec', {
                agent: 'bro', task_id: id, reason: 'typo in the fence',
                files: ['src/x.ts', 'src/z.ts'], verification: ['npm test'], spec_body: newSpec,
            });
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            assert.deepEqual(parse(r)['changed'], ['files', 'verification', 'spec_body']);
            const row = taskRow(db, id);
            assert.deepEqual(JSON.parse(row.files), ['src/x.ts', 'src/z.ts']);
            assert.deepEqual(JSON.parse(row.verification), ['npm test']);
            assert.equal(row.spec_body, newSpec);
            assert.equal(row.status, 'pending', 'status unchanged');
            const audit = auditOf(db, 'task_spec_amended');
            assert.equal(audit.length, 1);
            assert.match(audit[0].summary, /files \+1\/-0; verification \+1\/-1; spec_body \d+→\d+ chars/);
            const content = JSON.parse(audit[0].content_json);
            assert.equal(content['reason'], 'typo in the fence');
            assert.deepEqual(content['changes']['verification'], { added: ['npm test'], removed: ['true'] });
            const decision = db.get(`SELECT COUNT(*) AS c FROM discussions WHERE kind = 'decision' AND body LIKE 'Task % spec amended%typo in the fence'`);
            assert.equal(decision.c, 1);
            const filesOnly = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'narrow', files: ['src/x.ts'] });
            assert.deepEqual(parse(filesOnly)['changed'], ['files']);
            assert.deepEqual(JSON.parse(taskRow(db, id).verification), ['npm test'], 'untouched field kept');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_update_spec refuses closed/failed/escalated tasks, empty input, and a spec without Success Criteria', async () => {
        const { ws, db, handlers } = setup();
        try {
            const id = await provision(handlers, 'fix/amend-refused');
            const none = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x' });
            assert.equal(none.isError, true);
            const badSpec = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', spec_body: '## Description\nno criteria' });
            assert.equal(badSpec.isError, true);
            assert.match(String(parse(badSpec)['error']), /Success Criteria/);
            const emptyFiles = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', files: [] });
            assert.equal(emptyFiles.isError, true);
            for (const status of ['closed', 'failed', 'escalated']) {
                db.run(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
                const r = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', files: ['b'] });
                assert.equal(r.isError, true, status);
                assert.match(String(parse(r)['error']), /task_reopen/);
            }
            assert.deepEqual(JSON.parse(taskRow(db, id).files), ['src/x.ts']);
            assert.equal(auditOf(db, 'task_spec_amended').length, 0);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_provision, task_reopen and task_update_spec stamp the task id on the decision they write (GH 1741)', async () => {
        const { ws, db, handlers } = setup();
        try {
            const id = await provision(handlers, 'fix/task-scoped-decisions');
            const decisionTaskIds = () => db.all(`SELECT task_id FROM discussions WHERE kind = 'decision' ORDER BY id`).map((r) => r.task_id);
            assert.deepEqual(decisionTaskIds(), [id], 'the provision decision carries the new task id');
            assert.ok(db.get(`SELECT COUNT(*) AS n FROM discussions WHERE kind = 'decision' AND task_id = ?`, [id]).n > 0);
            const amend = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'widen', files: ['src/x.ts', 'src/z.ts'] });
            assert.ok(!amend.isError, JSON.stringify(parse(amend)));
            db.run(`UPDATE tasks SET status = 'closed', completed_at = datetime('now') WHERE id = ?`, [id]);
            const reopen = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review found a gap' });
            assert.ok(!reopen.isError, JSON.stringify(parse(reopen)));
            assert.deepEqual(decisionTaskIds(), [id, id, id]);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('task_retry and task_reopen cut a missing branch and worktree (GH 1781)', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
    function setup(targetBranch = 'main') {
        const ws = mkdtempSync(join(tmpdir(), 'retry-cut-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        git(repoRoot, 'init', '-q', '-b', 'main');
        git(repoRoot, 'config', 'user.email', 't@t.t');
        git(repoRoot, 'config', 'user.name', 't');
        const commit = (file) => {
            writeFileSync(join(repoRoot, file), `${file}\n`);
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', file);
            return git(repoRoot, 'rev-parse', 'HEAD');
        };
        const first = commit('a.txt');
        const tip = commit('b.txt');
        git(repoRoot, 'update-ref', 'refs/remotes/origin/main', tip);
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, ?)`, [repoRoot, targetBranch]);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        const handlers = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers;
        const failedTask = (branch, parent) => {
            db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, repo, files, verification, created_at, updated_at)
         VALUES (1, ?, ?, '', 'd', 'failed', ?, 'app', '["src/x.ts"]', '["true"]', datetime('now'), datetime('now'))`, [branch, parent, SPEC]);
            return db.get(`SELECT id FROM tasks WHERE branch_id = ?`, [branch]).id;
        };
        const retry = (failedId, newBranch) => call(handlers, 'task_retry', {
            agent: 'bro', failed_task_id: String(failedId), new_branch_id: newBranch, corrected_spec_body: SPEC,
            retry_rationale: 'redesigned approach', description: 'd',
        });
        const taskCount = () => db.get('SELECT COUNT(*) AS c FROM tasks').c;
        return { ws, repoRoot, db, handlers, git, commit, first, tip, failedTask, retry, taskCount };
    }
    it('SC1/SC2: task_retry cuts new_branch_id from the base tip and checks it out in a linked worktree', async () => {
        const { ws, repoRoot, db, git, tip, failedTask, retry } = setup();
        try {
            const id = failedTask('fix/orig', 'main');
            const r = await retry(id, 'fix/orig-v2');
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            const out = parse(r);
            const wt = join(repoRoot, '.claude', 'worktrees', 'orig-v2');
            assert.equal(out['git_setup'], 'created');
            assert.equal(out['base_ref'], 'origin/main');
            assert.equal(out['worktree_path'], wt);
            assert.equal(out['diagnostic'], undefined);
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/orig-v2'), tip, 'cut from the base tip');
            assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/orig-v2');
            assert.match(git(repoRoot, 'worktree', 'list', '--porcelain'), /branch refs\/heads\/fix\/orig-v2/);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('SC2: task_retry falls back to the target branch when the parent does not resolve, and reuses a ref behind the base', async () => {
        const { ws, repoRoot, db, git, first, tip, failedTask, retry } = setup();
        try {
            const id = failedTask('fix/gone-parent', 'feat/never-pushed');
            git(repoRoot, 'branch', 'fix/gone-parent-v2', first);
            const out = parse(await retry(id, 'fix/gone-parent-v2'));
            assert.equal(out['git_setup'], 'reused', JSON.stringify(out));
            assert.equal(out['base_ref'], 'origin/main');
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/gone-parent-v2'), tip, 'fast-forwarded to the base tip');
            assert.equal(git(String(out['worktree_path']), 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/gone-parent-v2');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('SC2: task_retry without a resolvable repo path inserts the task and reports a diagnostic', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
            VALUES (1, 'fix/no-repo', '', 'd', 'failed', ?, datetime('now'), datetime('now'))`, [SPEC]);
        const failedId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/no-repo'`).id;
        const out = parse(await call(compositeTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, 'task_retry', {
            agent: 'bro', failed_task_id: String(failedId), new_branch_id: 'fix/no-repo-v2', corrected_spec_body: SPEC,
            retry_rationale: 'redesigned approach', description: 'd',
        }));
        assert.ok(out['task_id'] > 0, JSON.stringify(out));
        assert.equal(out['worktree_path'], null);
        assert.match(String(out['diagnostic']), /cannot resolve a git repo path/);
        assert.equal(out['git_setup'], undefined);
        db.close();
    });
    it('SC3: task_retry refuses an unresolvable base and inserts no task row', async () => {
        const { ws, repoRoot, db, git, failedTask, retry, taskCount } = setup('release');
        try {
            const id = failedTask('fix/no-base', null);
            const before = taskCount();
            const r = await retry(id, 'fix/no-base-v2');
            assert.equal(r.isError, true);
            assert.match(String(parse(r)['error']), /task_retry: base does not resolve as 'origin\/release'.*No task row was created/);
            assert.equal(taskCount(), before, 'no task row');
            assert.throws(() => git(repoRoot, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/no-base-v2'));
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('SC3: task_retry refuses a diverged existing new_branch_id and inserts no task row', async () => {
        const { ws, repoRoot, db, git, first, failedTask, retry, taskCount } = setup();
        try {
            const id = failedTask('fix/stale', 'main');
            git(repoRoot, 'checkout', '-q', '-b', 'fix/stale-v2', first);
            writeFileSync(join(repoRoot, 'side.txt'), 'side\n');
            git(repoRoot, 'add', '.');
            git(repoRoot, 'commit', '-q', '-m', 'side');
            git(repoRoot, 'checkout', '-q', 'main');
            const sideSha = git(repoRoot, 'rev-parse', 'refs/heads/fix/stale-v2');
            const before = taskCount();
            const r = await retry(id, 'fix/stale-v2');
            assert.equal(r.isError, true);
            const out = parse(r);
            assert.equal(out['error'], 'branch_exists_diverged');
            assert.equal(out['base'], 'origin/main');
            assert.match(String(out['message']), /^task_retry: .*new_branch_id.*No task row was created\.$/);
            assert.equal(taskCount(), before, 'no task row');
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/stale-v2'), sideSha, 'ref untouched');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('GH 1731: task_retry refuses a new_branch_id the issue already uses with branch_id_used_on_issue, changing no ref, worktree or row', async () => {
        const { ws, repoRoot, db, git, first, failedTask, retry, taskCount } = setup();
        try {
            const id = failedTask('fix/orig', 'main');
            git(repoRoot, 'branch', 'fix/orig-v2', first);
            db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, repo, commit_sha, created_at, updated_at)
         VALUES (1, 'fix/orig-v2', '', 'd', 'closed', ?, 'app', 'def5678', datetime('now'), datetime('now'))`, [SPEC]);
            const existingId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/orig-v2'`).id;
            const snapshot = () => ({
                ref: git(repoRoot, 'rev-parse', 'refs/heads/fix/orig-v2'),
                worktrees: git(repoRoot, 'worktree', 'list', '--porcelain'),
                tasks: taskCount(),
                discussions: db.get('SELECT COUNT(*) AS c FROM discussions').c,
                audit: db.get('SELECT COUNT(*) AS c FROM audit').c,
            });
            const before = snapshot();
            const r = await retry(id, 'fix/orig-v2');
            assert.equal(r.isError, true);
            const out = parse(r);
            assert.equal(out['error'], 'branch_id_used_on_issue', JSON.stringify(out));
            assert.equal(out['issue_id'], 1);
            assert.equal(out['branch_id'], 'fix/orig-v2');
            assert.equal(out['task_id'], existingId);
            assert.equal(out['status'], 'closed');
            assert.equal(out['commit_sha'], 'def5678');
            assert.match(String(out['message']), /^task_retry: .*new_branch_id from branch_id_propose\. No task row or branch was changed\.$/);
            assert.deepEqual(snapshot(), before);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('SC4: task_reopen creates a branch missing locally and on origin from the base, then its worktree', async () => {
        const { ws, repoRoot, db, handlers, git, tip } = setup();
        try {
            db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, repo, files, verification, created_at, updated_at)
         VALUES (1, 'fix/never-cut', 'main', '', 'd', 'closed', ?, 'app', '["src/x.ts"]', '["true"]', datetime('now'), datetime('now'))`, [SPEC]);
            const id = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/never-cut'`).id;
            const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'branch was never cut' }));
            const wt = join(repoRoot, '.claude', 'worktrees', 'never-cut');
            assert.equal(out['diagnostic'], undefined, JSON.stringify(out));
            assert.equal(out['worktree_recreated'], true);
            assert.equal(out['branch_created'], true);
            assert.equal(out['worktree_path'], wt);
            assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/never-cut'), tip);
            assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/never-cut');
            const again = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'second pass' }));
            assert.equal(again['branch_created'], false);
            assert.equal(again['worktree_recreated'], false);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('task_brief — task-scoped discussions (GH 1741)', () => {
    const insertDecision = (db, issueId, taskId, body, at) => Number(db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, 'bro', 'decision', ?, ?, ?)`, [issueId, body, at, taskId]).lastInsertRowid);
    const insertIntent = (db, issueId, body, at, supersedes = null) => Number(db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at, supersedes) VALUES (?, 'bro', 'intent', ?, ?, ?)`, [issueId, body, at, supersedes]).lastInsertRowid);
    const seedIssueTasks = (db, count) => {
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (55, 'many tasks', 'd', 'open', datetime('now'), datetime('now'))`);
        const ids = [];
        for (let t = 0; t < count; t++) {
            db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
         VALUES (55, ?, 't', 'd', 'pending', 's', datetime('now'), datetime('now'))`, [`fix/55-task-${t}`]);
            ids.push(db.get('SELECT last_insert_rowid() AS id').id);
        }
        return ids;
    };
    const brief = async (db, taskId) => parse((await compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null).handlers['task_brief']({ agent: 'bro', task_id: taskId })));
    const at = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    it('19 decisions over 7 tasks plus issue-level ones: the brief holds this task\'s decisions and the newest issue-level one, under 6000 chars', async () => {
        const db = tempDB();
        const taskIds = seedIssueTasks(db, 7);
        insertDecision(db, 55, null, `older issue-level decision ${'o'.repeat(1000)}`, at(0));
        for (let i = 0; i < 19; i++) {
            insertDecision(db, 55, taskIds[i % 7], `decision ${i} for task ${i % 7}: ${'d'.repeat(1000)}`, at(1 + i));
        }
        insertDecision(db, 55, null, `newest issue-level decision ${'n'.repeat(1000)}`, at(30));
        insertIntent(db, 55, `Human intent verbatim: "${'h'.repeat(1000)}"`, at(0));
        const target = taskIds[3];
        const out = await brief(db, target);
        const disc = out['task_discussions'];
        assert.deepEqual(disc.map((d) => (d.kind === 'intent' ? 'intent' : d.body.replace(/:? [dn]{1000}$/, ''))), ['intent', 'decision 3 for task 3', 'decision 10 for task 3', 'decision 17 for task 3', 'newest issue-level decision']);
        assert.equal(disc[0].truncated, true);
        const size = JSON.stringify(disc).length;
        assert.ok(size < 6000, `task_discussions is ${size} chars`);
        const omitted = out['task_discussions_omitted'];
        assert.equal(omitted.count, 22 - disc.length);
        assert.match(omitted.hint, /discussion_search\(issue_id=55\) returns the full history/);
        db.close();
    });
    it('an old issue whose rows carry no task_id falls back to the newest issue-level decision', async () => {
        const db = tempDB();
        const [taskId] = seedIssueTasks(db, 1);
        insertDecision(db, 55, null, 'first', at(1));
        insertDecision(db, 55, null, 'second', at(2));
        const out = await brief(db, taskId);
        assert.deepEqual(out['task_discussions'].map((d) => d.body), ['second']);
        db.close();
    });
    it('a task on an intent_start issue: the history section carries the Human intent verbatim (GH 1760)', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const started = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'export data',
            intent_verbatim: 'I want to export my data as CSV, never as XLSX',
            branch_id: 'feat/export-csv',
        });
        assert.ok(!started.isError, JSON.stringify(parse(started)));
        const issueId = parse(started)['issue_id'];
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
       VALUES (?, 'feat/export-csv', 't', 'd', 'pending', 's', datetime('now'), datetime('now'))`, [issueId]);
        const taskId = db.get('SELECT last_insert_rowid() AS id').id;
        const r = (await composites.handlers['task_brief']({ agent: 'swe', task_id: taskId, section: 'history' }));
        const disc = parse(r)['task_discussions'];
        const intents = disc.filter((d) => d.kind === 'intent');
        assert.equal(intents.length, 1);
        assert.equal(intents[0].body, 'Human intent verbatim: "I want to export my data as CSV, never as XLSX"');
        assert.equal(intents[0].truncated, undefined);
        db.close();
    });
    it('only the newest unsuperseded issue-level intent reaches the brief (GH 1760)', async () => {
        const db = tempDB();
        const [taskId] = seedIssueTasks(db, 1);
        const first = insertIntent(db, 55, 'Human intent verbatim: "first"', at(1));
        insertIntent(db, 55, 'Human intent verbatim: "first, restated"', at(2), first);
        const intentsOf = async () => (await brief(db, taskId))['task_discussions']
            .filter((d) => d.kind === 'intent')
            .map((d) => d.body);
        assert.deepEqual(await intentsOf(), ['Human intent verbatim: "first, restated"']);
        const newest = insertIntent(db, 55, 'Human intent verbatim: "second ask"', at(3));
        assert.deepEqual(await intentsOf(), ['Human intent verbatim: "second ask"']);
        insertIntent(db, 55, 'Human intent verbatim: "second ask, corrected"', at(4), newest);
        assert.deepEqual(await intentsOf(), ['Human intent verbatim: "second ask, corrected"']);
        db.close();
    });
    it('a long issue-level intent is truncated to 500 chars and does not displace the 8 other-kind rows (GH 1760)', async () => {
        const db = tempDB();
        const [taskId] = seedIssueTasks(db, 1);
        const longIntent = `Human intent verbatim: "${'w'.repeat(800)}"`;
        insertIntent(db, 55, longIntent, at(1));
        for (let i = 0; i < 8; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (55, 'swe', 'note', ?, ?)`, [`note ${i}`, at(10 + i)]);
        }
        const disc = (await brief(db, taskId))['task_discussions'];
        const intent = disc.find((d) => d.kind === 'intent');
        assert.ok(intent);
        assert.equal(intent.truncated, true);
        assert.equal(intent.body, longIntent.slice(0, 500) + '\n… [truncated; discussion_search(issue_id=55) returns the full history]');
        assert.deepEqual(disc.filter((d) => d.kind === 'note').map((d) => d.body), Array.from({ length: 8 }, (_, i) => `note ${i}`));
        db.close();
    });
    it('the task_brief description and src/tools/README.md name the issue-level intent row (GH 1760)', () => {
        const db = tempDB();
        const def = compositeTools(db, '/tmp/.claude/tmb/trajectory.db').definitions.find((d) => d.name === 'task_brief');
        assert.match(def.description, /issue-level decision and intent/);
        const readme = readFileSync(fileURLToPath(new URL('../../src/tools/README.md', import.meta.url)), 'utf8');
        const line = readme.split('\n').find((l) => l.includes('task_discussions'));
        assert.match(line, /issue-level intent/);
        assert.doesNotMatch(readme, /carries only its newest issue-level decision\./);
        db.close();
    });
    it('discussion_append(task_id, supersedes) writes both columns and the brief skips the superseded row', async () => {
        const db = tempDB();
        const [taskId, otherTask] = seedIssueTasks(db, 2);
        const discussions = discussionTools(db);
        const append = async (args) => (await discussions.handlers['discussion_append']({ agent: 'bro', author: 'bro', issue_id: '55', kind: 'decision', ...args }));
        const first = parse(await append({ body: 'use approach A', task_id: String(taskId) }));
        assert.equal(first['task_id'], taskId);
        assert.equal(first['supersedes'], null);
        const second = parse(await append({ body: 'use approach B instead', task_id: String(taskId), supersedes: String(first['id']) }));
        assert.equal(second['supersedes'], first['id']);
        const row = db.get('SELECT supersedes FROM discussions WHERE id = ?', [second['id']]);
        assert.notEqual(row.supersedes, null);
        const issueLevel = parse(await append({ body: 'issue-wide rule' }));
        parse(await append({ body: 'issue-wide rule, revised', supersedes: String(issueLevel['id']) }));
        parse(await append({ body: 'other task decision', task_id: String(otherTask) }));
        const bodies = (await brief(db, taskId))['task_discussions'].map((d) => d.body);
        assert.deepEqual(bodies, ['use approach B instead', 'issue-wide rule, revised']);
        db.close();
    });
    it('discussion_append rejects a task_id or supersedes from another issue, or a missing one', async () => {
        const db = tempDB();
        const [taskId] = seedIssueTasks(db, 1);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (56, 'other', 'd', 'open', datetime('now'), datetime('now'))`);
        const foreign = insertDecision(db, 56, null, 'elsewhere', at(1));
        const discussions = discussionTools(db);
        const append = async (args) => (await discussions.handlers['discussion_append']({ agent: 'bro', author: 'bro', kind: 'decision', body: 'b', ...args }));
        const wrongTask = await append({ issue_id: '56', task_id: String(taskId) });
        assert.equal(wrongTask.isError, true);
        assert.match(String(parse(wrongTask)['error']), /belongs to issue 55/);
        const wrongPrior = await append({ issue_id: '55', supersedes: String(foreign) });
        assert.equal(wrongPrior.isError, true);
        assert.match(String(parse(wrongPrior)['error']), /belongs to issue 56/);
        const missing = await append({ issue_id: '55', task_id: '99999' });
        assert.equal(missing.isError, true);
        assert.match(String(parse(missing)['error']), /Not found: task 99999/);
        const notAnId = await append({ issue_id: '55', supersedes: 'abc' });
        assert.equal(notAnId.isError, true);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM discussions WHERE issue_id = 55').n, 0);
        db.close();
    });
    it('no scope_world_model entry lists its own dir among its children, the root included', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: 's', files: ['README.md', 'src/a.ts'] });
        const node = (path, parent_path) => ({
            key: `app:${path}`, repo: 'app', path, parent_path, summary: path || 'root', summary_source: 'structural', summary_updated_at: null, file_count: 1,
        });
        const stubGraph = {
            allDirectoriesForRepo: () => [node('', null), node('src', ''), node('docs', ''), node('src/lib', 'src')],
        };
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', GraphHolder.fixed(stubGraph));
        const out = parse((await tools.handlers['task_brief']({ agent: 'bro', task_id: id })));
        const scope = out['scope_world_model'];
        assert.deepEqual(scope.map((s) => s.dir).sort(), ['', 'src']);
        for (const entry of scope) {
            assert.ok(!entry.children.some((c) => c.path === entry.dir), `${JSON.stringify(entry.dir)} lists itself as a child`);
        }
        assert.deepEqual(scope.find((s) => s.dir === '').children.map((c) => c.path).sort(), ['docs', 'src']);
        db.close();
    });
});
describe('composite discussions route through insertDiscussion + embedAndStore (#986)', () => {
    // The embed is fired non-blocking after the row is written, so it lands a few
    // event-loop turns later. Poll briefly for the embedding row to appear.
    async function waitForEmbeddings(db, expected, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        let n = 0;
        do {
            n = db.get('SELECT COUNT(*) AS n FROM discussions_embeddings')?.n ?? 0;
            if (n >= expected)
                return n;
            await new Promise((r) => setTimeout(r, 50));
        } while (Date.now() < deadline);
        return n;
    }
    it('intent_start: composite-written intent + note become embedded (semantic discussion_search visible)', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'composite embed test',
            intent_verbatim: 'make composite discussions searchable',
            branch_id: 'feat/composite-embed-test',
        });
        assert.ok(!r.isError, `intent_start must succeed: ${JSON.stringify(parse(r))}`);
        const issueId = parse(r)['issue_id'];
        // The discussion rows themselves always land (transaction committed).
        const discCount = db.get('SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?', [issueId])?.n ?? 0;
        assert.equal(discCount, 2, 'intent_start writes one intent + one note discussion');
        // The embed is the gap #986 closes. Assert the embedding rows appear when a
        // model is available; in a model-less CI embed() returns null so the path is
        // a graceful no-op (composite still succeeded above).
        const probe = await embed('model availability probe');
        const embCount = await waitForEmbeddings(db, probe === null ? 0 : 2);
        if (probe === null) {
            assert.equal(embCount, 0, 'no model → embed degrades to FTS-only, composite still ok');
        }
        else {
            assert.ok(embCount >= 2, `composite discussions must be embedded so semantic search can find them (got ${embCount})`);
        }
        db.close();
    });
    it('embed failure is non-fatal: the composite transaction still commits', async () => {
        // After a first embed attempt the model loader latches loadFailed when no
        // model is present, so subsequent embed() calls return null. Either way the
        // composite must succeed and its discussion rows must persist — an embed
        // failure must never roll back the transaction.
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'embed non-fatal test',
            intent_verbatim: 'embed failure must not roll back',
            branch_id: 'feat/embed-non-fatal',
        });
        assert.ok(!r.isError, `composite must commit even if embedding fails: ${JSON.stringify(parse(r))}`);
        const issueId = parse(r)['issue_id'];
        const discCount = db.get('SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?', [issueId])?.n ?? 0;
        assert.equal(discCount, 2, 'discussion rows persist regardless of embed outcome');
        db.close();
    });
});
describe('agent_runs lifecycle — rows open with their run and close with their task', () => {
    const SPEC = ['## Files', '- `src/a.ts` — edit', '', '## Success Criteria', '- works'].join('\n');
    const runs = (db, taskId) => db.all('SELECT agent_type, started_at, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [taskId]);
    let seq = 0;
    const seed = (db) => {
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        db.run('UPDATE tasks SET branch_id = ? WHERE id = ?', [`fix/runs-${++seq}`, id]);
        return id;
    };
    const openBro = (db, taskId) => {
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'bro', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))`, [taskId]);
    };
    it('task_brief opens one swe row for a swe caller, never a second while it is open, and none for other roles', async () => {
        const db = tempDB();
        const id = seed(db);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'code-reviewer', task_id: id });
        await tools.handlers['task_brief']({ agent: 'bro', task_id: id });
        assert.equal(runs(db, id).length, 0, 'bro / code-reviewer briefs open no swe row');
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const opened = db.all('SELECT agent_type, repo, started_at, completed_at FROM agent_runs WHERE task_id = ?', [id]);
        assert.equal(opened.length, 1, 'exactly one open swe row');
        assert.equal(opened[0].agent_type, 'swe');
        assert.equal(opened[0].repo, 'app');
        assert.match(opened[0].started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.equal(opened[0].completed_at, null);
        db.run('UPDATE agent_runs SET completed_at = ? WHERE task_id = ?', [new Date().toISOString(), id]);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        assert.equal(runs(db, id).length, 2, 'a later spawn opens a fresh row once the first one closed');
        db.close();
    });
    for (const status of ['failed', 'escalated']) {
        it(`task_update_status → ${status} closes every open row of the task (bro and swe)`, async () => {
            const db = tempDB();
            const id = seed(db);
            db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
            const other = seed(db);
            openBro(db, id);
            openBro(db, other);
            const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
            await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
            const tasks = taskTools(db);
            const agent = status === 'failed' ? 'swe' : 'bro';
            const r = await call(tasks.handlers, 'task_update_status', { agent, task_id: String(id), status });
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            const closed = runs(db, id);
            assert.equal(closed.length, 2);
            assert.ok(closed.every((x) => x.completed_at !== null), 'bro and swe rows are closed');
            const ms = db.get(`SELECT duration_ms AS d FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [id]).d;
            assert.ok(ms >= 59_000, `an unmeasured row takes its window length (got ${ms})`);
            assert.equal(runs(db, other)[0].completed_at, null, 'another task keeps its open row');
            db.close();
        });
    }
    it('a non-terminal task_update_status leaves rows open', async () => {
        const db = tempDB();
        const id = seed(db);
        openBro(db, id);
        const tasks = taskTools(db);
        await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'running' });
        assert.equal(runs(db, id)[0].completed_at, null);
        db.close();
    });
    it('bro_atomic_close closes the open bro and swe rows of the task', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [id]);
        openBro(db, id);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const r = (await tools.handlers['bro_atomic_close']({
            agent: 'bro', task_id: String(id), commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
        }));
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const after = runs(db, id);
        assert.deepEqual(after.map((x) => x.agent_type), ['bro', 'swe']);
        assert.ok(after.every((x) => x.completed_at !== null), 'no row stays open once the task is closed');
        db.close();
    });
    it('task_recover sweeps rows left open on tasks that are already terminal', async () => {
        const db = tempDB();
        const done = seed(db);
        const failed = seed(db);
        const live = seed(db);
        db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [done]);
        db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [failed]);
        for (const t of [done, failed, live])
            openBro(db, t);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const out = parse((await tools.handlers['task_recover']({ agent: 'bro', task_id: String(done) })));
        assert.equal(out['action'], 'noop');
        assert.equal(out['runs_swept'], 2);
        assert.notEqual(runs(db, done)[0].completed_at, null);
        assert.notEqual(runs(db, failed)[0].completed_at, null);
        assert.equal(runs(db, live)[0].completed_at, null, 'a live task keeps its open row');
        const again = parse((await tools.handlers['task_recover']({ agent: 'bro', task_id: String(done) })));
        assert.equal(again['runs_swept'], 0, 'the sweep is idempotent');
        db.close();
    });
    const seedLegacyRun = (db, taskId, r) => Number(db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, tokens_out, usage_source, exit_reason)
         VALUES (?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), ?, ?, ?, ?)`, [taskId, r.agentType, r.completedAt, r.tokensOut ?? null, r.usageSource ?? null, r.exitReason ?? null]).lastInsertRowid);
    const usage = (db, id) => ({ ...db.get('SELECT usage_source, tokens_out, completed_at FROM agent_runs WHERE id = ?', [id]) });
    const closedAt = new Date(Date.now() - 86_400_000).toISOString();
    it('task_recover marks closed swe/code-reviewer rows with no usage unmeasured and reports the count (GH 1746)', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
        const swe = seedLegacyRun(db, id, { agentType: 'swe', completedAt: closedAt, tokensOut: 0, exitReason: 'failed' });
        const reviewer = seedLegacyRun(db, id, { agentType: 'code-reviewer', completedAt: closedAt });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const out = parse((await tools.handlers['task_recover']({ agent: 'bro' })));
        assert.equal(out['runs_marked_unmeasured'], 2);
        assert.equal(usage(db, swe).usage_source, 'unmeasured');
        assert.equal(usage(db, reviewer).usage_source, 'unmeasured');
        const again = parse((await tools.handlers['task_recover']({ agent: 'bro' })));
        assert.equal(again['runs_marked_unmeasured'], 0, 'the sweep is idempotent');
        db.close();
    });
    it('task_recover leaves rows with tokens, a usage_source, open rows and bro rows unchanged (GH 1746)', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
        const kept = [
            seedLegacyRun(db, id, { agentType: 'swe', completedAt: closedAt, tokensOut: 42 }),
            seedLegacyRun(db, id, { agentType: 'swe', completedAt: closedAt, tokensOut: 0, usageSource: 'subagent_stop' }),
            seedLegacyRun(db, id, { agentType: 'swe', completedAt: null }),
            seedLegacyRun(db, id, { agentType: 'bro', completedAt: closedAt }),
        ];
        const before = kept.map((k) => usage(db, k));
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const out = parse((await tools.handlers['task_recover']({ agent: 'bro' })));
        assert.equal(out['runs_marked_unmeasured'], 0);
        assert.deepEqual(kept.map((k) => usage(db, k)), before);
        db.close();
    });
    it('task_recover clears swe_runs_metered for a pre-GH-1673 failed swe row with no transcript (GH 1746)', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [id]);
        seedLegacyRun(db, id, { agentType: 'swe', completedAt: closedAt, exitReason: 'failed' });
        const metered = () => {
            const contract = DATA_CONTRACTS.filter(isSqlContract).find((c) => c.id === 'swe_runs_metered');
            const report = runDataContracts(trajectoryDbReader(db), [contract], { env: {} });
            assert.deepEqual(report.skipped, []);
            return report.violations.find((v) => v.id === 'swe_runs_metered')?.actual ?? 0;
        };
        assert.equal(metered(), 1, 'the legacy row trips the contract');
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_recover']({ agent: 'bro' });
        assert.equal(metered(), 0);
        db.close();
    });
    const stamps = (db, taskId) => db
        .all('SELECT agent_type, root_dir, host, exit_reason FROM agent_runs WHERE task_id = ? ORDER BY id', [taskId])
        .map((r) => ({ ...r }));
    it('task_brief stamps the swe row with the task worktree and host', async () => {
        const db = tempDB();
        const id = seed(db);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null, { host: 'codex', projectRoot: '/tmp' });
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const branch = db.get('SELECT branch_id AS b FROM tasks WHERE id = ?', [id]).b;
        assert.deepEqual(stamps(db, id), [
            { agent_type: 'swe', root_dir: `/tmp/app/.claude/worktrees/${branch.replace(/^[^/]+\//, '')}`, host: 'codex', exit_reason: null },
        ]);
        db.close();
    });
    it('task_create_batch and task_retry accept session_id, reject an invalid one writing nothing, and open no bro row', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        const tasks = taskTools(db);
        const WAIVE = 'unit test of session_id validation';
        const batch = (branches, extra) => call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: '1',
            waive_intent_gate: true, waive_intent_gate_reason: WAIVE, waive_decision_gate: true, waive_decision_gate_reason: WAIVE,
            waive_branch_gate: true, waive_branch_gate_reason: WAIVE, waive_scope_gate: true, waive_scope_gate_reason: WAIVE,
            waive_spec_shape: true, waive_spec_shape_reason: WAIVE,
            tasks: branches.map((branch_id) => ({ branch_id, description: 'd', spec_body: SPEC, files: ['src/a.ts'], verification: ['true'] })),
            ...extra,
        });
        const stamped = parseBatch(await batch(['fix/sess-a', 'fix/sess-b'], { session_id: 'sess-0001-batch' }));
        assert.equal(stamped.length, 2);
        const legacy = parseBatch(await batch(['fix/sess-d'], {}));
        const legacyId = legacy[0]['id'];
        const rejected = await batch(['fix/sess-e'], { session_id: 'bad id!' });
        assert.equal(rejected.isError, true);
        assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'fix/sess-e'`).c, 0, 'nothing written');
        await call(tasks.handlers, 'task_update_status', { agent: 'bro', task_id: String(legacyId), status: 'escalated' });
        const composites = compositeTools(db, '', null);
        const retry = (new_branch_id, extra) => composites.handlers['task_retry']({
            agent: 'bro', failed_task_id: String(legacyId), new_branch_id, corrected_spec_body: SPEC,
            retry_rationale: 'retry for session_id validation', description: 'd', ...extra,
        });
        const badRetry = await retry('fix/sess-retry-bad', { session_id: 'tiny' });
        assert.equal(badRetry.isError, true);
        assert.equal(db.get(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'fix/sess-retry-bad'`).c, 0);
        const retried = parse(await retry('fix/sess-retry', { session_id: 'sess-0002-retry' }));
        assert.ok(retried['task_id'] > 0, JSON.stringify(retried));
        assert.equal(db.get(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`).c, 0);
        db.close();
    });
    for (const status of ['failed', 'escalated']) {
        it(`task_update_status → ${status} stamps exit_reason ${status} on every row it closes`, async () => {
            const db = tempDB();
            const id = seed(db);
            db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
            openBro(db, id);
            const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
            await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
            const agent = status === 'failed' ? 'swe' : 'bro';
            await call(taskTools(db).handlers, 'task_update_status', { agent, task_id: String(id), status });
            assert.deepEqual(stamps(db, id).map((r) => r.exit_reason), [status, status]);
            db.close();
        });
    }
    it('bro_atomic_close stamps exit_reason completed', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [id]);
        openBro(db, id);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        await tools.handlers['bro_atomic_close']({
            agent: 'bro', task_id: String(id), commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
        });
        assert.deepEqual(stamps(db, id).map((r) => r.exit_reason), ['completed', 'completed']);
        db.close();
    });
    it('task_recover sweeps an unmeasured row as swept_orphan and a measured one as swept_stale', async () => {
        const db = tempDB();
        const done = seed(db);
        db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [done]);
        openBro(db, done);
        openBro(db, done);
        db.run(`UPDATE agent_runs SET usage_source = 'transcript', tokens_in = 5 WHERE id = (SELECT MAX(id) FROM agent_runs WHERE task_id = ?)`, [done]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_recover']({ agent: 'bro', task_id: String(done) });
        assert.deepEqual(stamps(db, done).map((r) => r.exit_reason), ['swept_orphan', 'swept_stale']);
        db.close();
    });
    it('task_brief closes an earlier spawn\'s orphaned open swe row as swept_orphan and opens a fresh one', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'))`, [id]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const rows = db.all('SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [id]);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].exit_reason, 'swept_orphan');
        assert.notEqual(rows[0].completed_at, null);
        assert.equal(rows[1].completed_at, null, 'the new spawn has an open row');
        db.close();
    });
    it('task_brief stamps the swept orphan with its window length and exit_reason swept_orphan', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'))`, [id]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const orphan = db.get('SELECT exit_reason, duration_ms FROM agent_runs WHERE task_id = ? ORDER BY id LIMIT 1', [id]);
        assert.equal(orphan.exit_reason, 'swept_orphan');
        assert.ok(orphan.duration_ms >= 11 * 60 * 1000, `the orphan takes its window length (got ${orphan.duration_ms})`);
        db.close();
    });
    it('task_brief reuses an open swe row younger than 10 minutes', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 minutes'))`, [id]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const rows = db.all('SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [id]);
        assert.equal(rows.length, 1, 'no new row opens');
        assert.equal(rows[0].completed_at, null, 'the young row stays open');
        assert.equal(rows[0].exit_reason, null);
        db.close();
    });
    it('task_brief sweeps an unbound spawn row (spawn_id tool_use:*) older than 10 minutes', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'), 'tool_use:toolu_1')`, [id]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const rows = db.all('SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [id]);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].exit_reason, 'swept_orphan');
        assert.equal(rows[1].completed_at, null, 'the new spawn has an open row');
        db.close();
    });
    it('task_brief keeps an open swe row bound to an agent_id however old it is', async () => {
        const db = tempDB();
        const id = seed(db);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'), 'agent-live')`, [id]);
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        await tools.handlers['task_brief']({ agent: 'swe', task_id: id });
        const rows = db.all('SELECT spawn_id, exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [id]);
        assert.equal(rows.length, 1, 'no new row opens');
        assert.equal(rows[0].spawn_id, 'agent-live');
        assert.equal(rows[0].completed_at, null, 'the live spawn row stays open');
        assert.equal(rows[0].exit_reason, null, 'a bound row is never swept_orphan');
        db.close();
    });
});
describe('scopeSurface', () => {
    it('groups by first path segment, root files under <root>', () => {
        assert.equal(scopeSurface('src/a.ts'), 'src');
        assert.equal(scopeSurface('README.md'), '<root>');
        assert.equal(scopeSurface('a/b/c'), 'a');
    });
});
describe('review findings across task_reopen and task_retry (GH 1783)', () => {
    const SPEC = ['## Description', 'd', '', '## Success Criteria', '- SC1: works'].join('\n');
    function setup(status) {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
            VALUES (1, 'fix/findings', '', 'd', ?, ?, datetime('now'), datetime('now'))`, [status, SPEC]);
        const taskId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/findings'`).id;
        const seed = (n, attempt, findingStatus, criterion) => db.run(`INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'exit 0', ?, ?, '2026-01-01T00:00:00.000Z', ?)`, [`F${taskId}-${n}`, taskId, attempt, criterion, `exit ${n}`, `exit ${n} seen`, findingStatus, findingStatus === 'open' ? null : '2026-01-02T00:00:00.000Z']);
        seed(1, 1, 'fixed', 'SC1');
        seed(2, 1, 'open', 'SC1');
        seed(3, 1, 'wontfix', null);
        seed(10, 2, 'open', null);
        seed(4, 2, 'open', 'SC1');
        return { db, handlers: compositeTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, taskId };
    }
    const findings = (db, taskId) => db.all(`SELECT * FROM review_findings WHERE task_id = ? ORDER BY CAST(substr(id, instr(id, '-') + 1) AS INTEGER)`, [taskId]).map((r) => ({ ...r }));
    const auditRows = (db, eventType) => db.all(`SELECT from_node, content_json FROM audit WHERE event_type = ? ORDER BY id`, [eventType])
        .map((r) => ({ from_node: r.from_node, content: JSON.parse(r.content_json) }));
    it('SC2: task_reopen wontfix sets the findings to wontfix with resolved_at, one audit row each, and drops them from open_findings and the probes', async () => {
        const { db, handlers, taskId } = setup('failed');
        const r = await call(handlers, 'task_reopen', {
            agent: 'bro', task_id: taskId, reason: 'review failed',
            wontfix: [
                { finding_id: `F${taskId}-2`, reason: 'Human accepts the legacy output' },
                { finding_id: `F${taskId}-10`, reason: 'out of scope per the Human' },
            ],
        });
        assert.equal(r.isError, undefined, JSON.stringify(parse(r)));
        const out = parse(r);
        assert.deepEqual(out['wontfixed'], [`F${taskId}-2`, `F${taskId}-10`]);
        assert.equal(out['status'], 'running');
        const rows = findings(db, taskId);
        for (const id of [`F${taskId}-2`, `F${taskId}-10`]) {
            const row = rows.find((f) => f.id === id);
            assert.equal(row.status, 'wontfix', id);
            assert.match(String(row.resolved_at), /^\d{4}-\d{2}-\d{2}T/, id);
        }
        assert.equal(rows.find((f) => f.id === `F${taskId}-4`).status, 'open');
        assert.deepEqual(auditRows(db, 'review_finding_wontfix'), [
            { from_node: 'bro', content: { task_id: taskId, finding_id: `F${taskId}-2`, reason: 'Human accepts the legacy output' } },
            { from_node: 'bro', content: { task_id: taskId, finding_id: `F${taskId}-10`, reason: 'out of scope per the Human' } },
        ]);
        const brief = parse(await call(handlers, 'task_brief', { agent: 'swe', task_id: taskId }));
        assert.deepEqual(brief.open_findings.map((f) => f.id), [`F${taskId}-4`]);
        assert.deepEqual(activeFindingProbes(db, taskId).map((p) => p.id), [`F${taskId}-1`, `F${taskId}-4`]);
        db.close();
    });
    it('SC2: task_reopen without wontfix returns wontfixed [] and writes no wontfix audit row', async () => {
        const { db, handlers, taskId } = setup('failed');
        const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: taskId, reason: 'review failed' }));
        assert.deepEqual(out['wontfixed'], []);
        assert.equal(auditRows(db, 'review_finding_wontfix').length, 0);
        db.close();
    });
    it('SC3: task_reopen refuses a bad wontfix list whole and writes nothing', async () => {
        const { db, handlers, taskId } = setup('failed');
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
            VALUES (1, 'fix/other', '', 'd', 'failed', ?, datetime('now'), datetime('now'))`, [SPEC]);
        const otherId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/other'`).id;
        db.run(`INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, status, created_at)
            VALUES (?, ?, 1, 'false', 'exit 0', 'exit 1', 'open', '2026-01-01T00:00:00.000Z')`, [`F${otherId}-1`, otherId]);
        const good = { finding_id: `F${taskId}-2`, reason: 'Human accepts this one' };
        const before = findings(db, taskId);
        const cases = [
            ['agent is not bro', { agent: 'swe', wontfix: [good] }, /forbidden/],
            ['finding of another task', { wontfix: [good, { finding_id: `F${otherId}-1`, reason: 'Human accepts this one' }] }, /not a review finding of task/],
            ['unknown finding', { wontfix: [{ finding_id: `F${taskId}-99`, reason: 'Human accepts this one' }] }, /not a review finding of task/],
            ['fixed finding', { wontfix: [good, { finding_id: `F${taskId}-1`, reason: 'Human accepts this one' }] }, /'fixed'; only an open finding/],
            ['wontfix finding', { wontfix: [{ finding_id: `F${taskId}-3`, reason: 'Human accepts this one' }] }, /'wontfix'; only an open finding/],
            ['short reason', { wontfix: [good, { finding_id: `F${taskId}-4`, reason: ' too short ' }] }, /at least 10 characters/],
            ['duplicate id', { wontfix: [good, good] }, /more than once/],
        ];
        for (const [label, args, pattern] of cases) {
            const r = await call(handlers, 'task_reopen', { agent: 'bro', task_id: taskId, reason: 'review failed', ...args });
            assert.equal(r.isError, true, label);
            assert.match(String(parse(r)['error']), pattern, label);
            assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', [taskId]).status, 'failed', label);
            assert.deepEqual(findings(db, taskId), before, label);
            assert.equal(auditRows(db, 'review_finding_wontfix').length, 0, label);
            assert.equal(auditRows(db, 'task_reopened').length, 0, label);
        }
        assert.equal(db.get('SELECT status FROM review_findings WHERE id = ?', [`F${otherId}-1`]).status, 'open');
        db.close();
    });
    it('SC4: task_retry copies the open findings in id order onto the new task, leaves the source rows, and audits the carry', async () => {
        const { db, handlers, taskId } = setup('failed');
        const before = findings(db, taskId);
        const r = await call(handlers, 'task_retry', {
            agent: 'bro', failed_task_id: String(taskId), new_branch_id: 'fix/findings-v2', corrected_spec_body: SPEC,
            retry_rationale: 'second approach', description: 'd',
        });
        assert.equal(r.isError, undefined, JSON.stringify(parse(r)));
        const out = parse(r);
        const newId = out['task_id'];
        const expectedCarry = [
            { from: `F${taskId}-2`, id: `F${newId}-1` },
            { from: `F${taskId}-4`, id: `F${newId}-2` },
            { from: `F${taskId}-10`, id: `F${newId}-3` },
        ];
        assert.deepEqual(out['carried_findings'], expectedCarry);
        assert.deepEqual(findings(db, taskId), before, 'the failed task\'s rows are unchanged');
        const copies = findings(db, newId);
        assert.deepEqual(copies.map(({ id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, resolved_at }) => ({
            id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, resolved_at,
        })), expectedCarry.map(({ from, id }) => {
            const src = before.find((f) => f.id === from);
            return {
                id, task_id: newId, attempt_n: 0, criterion_id: src.criterion_id, probe_cmd: src.probe_cmd,
                expected: src.expected, observed: src.observed, status: 'open', resolved_at: null,
            };
        }));
        for (const c of copies)
            assert.notEqual(c.created_at, '2026-01-01T00:00:00.000Z', 'created_at is the retry time');
        assert.deepEqual(auditRows(db, 'review_findings_carried'), [
            { from_node: 'bro', content: { from_task_id: taskId, to_task_id: newId, findings: expectedCarry } },
        ]);
        const brief = parse(await call(handlers, 'task_brief', { agent: 'swe', task_id: newId }));
        assert.deepEqual(brief.open_findings.map((f) => f.id), expectedCarry.map((c) => c.id));
        seedReviewerObservation(db, newId, 1, { agentId: 'reviewer-agent-0001' });
        const recorded = await call(validationTools(db).handlers, 'validation_record', {
            agent: 'code-reviewer', task_id: newId, attempt_n: 1, verdict: 'fail', feedback: '# Review', mcp_available: true,
            findings: [{ probe_cmd: 'npm test', expected: 'exit 0', observed: 'exit 1' }],
        });
        assert.ok(!recorded.isError, JSON.stringify(parse(recorded)));
        assert.deepEqual(findings(db, newId).map((f) => [f.id, f.attempt_n]), [
            [`F${newId}-1`, 0], [`F${newId}-2`, 0], [`F${newId}-3`, 0], [`F${newId}-4`, 1],
        ]);
        db.close();
    });
    it('SC4: task_retry with no open findings returns carried_findings [] and writes no carry audit row', async () => {
        const { db, handlers, taskId } = setup('failed');
        db.run(`UPDATE review_findings SET status = 'fixed', resolved_at = '2026-01-02T00:00:00.000Z' WHERE task_id = ? AND status = 'open'`, [taskId]);
        const out = parse(await call(handlers, 'task_retry', {
            agent: 'bro', failed_task_id: String(taskId), new_branch_id: 'fix/findings-v3', corrected_spec_body: SPEC,
            retry_rationale: 'second approach', description: 'd',
        }));
        assert.deepEqual(out['carried_findings'], []);
        assert.equal(findings(db, out['task_id']).length, 0);
        assert.equal(auditRows(db, 'review_findings_carried').length, 0);
        db.close();
    });
});
//# sourceMappingURL=composites.test.js.map