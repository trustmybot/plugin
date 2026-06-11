import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { compositeTools, parseFilesDirs } from '../tools/composites.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
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
        const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId,
            waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
            waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
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
    it('#474: repo override lands on the new task; omitted repo inherits from failed task', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const tasks = taskTools(db);
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        const issueId = String((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'repo override test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_log', {
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
        const retryWithOverride = await call(composites.handlers, 'task_retry_batch', {
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
        const retryInherited = await call(composites.handlers, 'task_retry_batch', {
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
        const r = await call(composites.handlers, 'task_retry_batch', {
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
        const r = await call(composites.handlers, 'task_retry_batch', {
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
            agent: 'bro', objective: 'retry cap test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        const mkBranch = async (branch) => {
            await call(audit.handlers, 'audit_log', {
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
            const r = await call(composites.handlers, 'task_retry_batch', {
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
        const denied = await call(composites.handlers, 'task_retry_batch', {
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
            agent: 'bro', objective: 'test', description: 'x',
        }))['id']));
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
        });
        await call(audit.handlers, 'audit_log', {
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
                agent: 'bro', objective: 'closed_at regression', description: 'x',
            }))['id']));
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_log', {
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
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: taskId,
                commit_sha: 'abc1234',
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
    it('#277: mirrors the auto-close to the linked remote (no local/remote drift)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'bac-remote-'));
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
        // Record every spawn so we can assert the remote close actually fired.
        const spawnCalls = [];
        const spawnFn = (cmd, args) => {
            spawnCalls.push({ cmd, args });
            return { status: 0, stdout: '', stderr: '' };
        };
        try {
            const issueId = String((parse(await call(issues.handlers, 'issue_create', {
                agent: 'bro', objective: 'remote close mirror', description: 'x',
            }))['id']));
            // Simulate an issue already synced to a GitHub remote (iid 42).
            db.run(`UPDATE issues SET gh_iid = 42, remote_kind = 'github' WHERE id = ?`, [issueId]);
            await call(discussions.handlers, 'discussion_append', {
                agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
            });
            await call(audit.handlers, 'audit_log', {
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
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
                close_issue_if_last_task: true, _spawnFn: spawnFn,
            });
            assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
            assert.equal(parse(r)['issue_closed'], true);
            const closeCall = spawnCalls.find((c) => c.args.includes('issue') && c.args.includes('close'));
            assert.ok(closeCall, `expected a remote 'issue close' spawn; got ${JSON.stringify(spawnCalls)}`);
            assert.equal(closeCall.cmd, 'gh', 'github remote closes via gh');
            assert.ok(closeCall.args.includes('42'), 'remote close must target gh_iid 42');
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
    it('surfaces a missing task as isError with the raw id preserved (#283)', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'reap_and_review_prep', {
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
        // Poison the audit table so the 4th write (audit_log) throws.
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
});
describe('headless_fallback_record (#426)', () => {
    it('writes audit + note atomically; defaults to most recent open issue', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const issueId = Number((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'headless fallback target', description: 'x',
        }))['id']));
        const r = await call(composites.handlers, 'headless_fallback_record', {
            agent: 'bro',
            question: 'Should we use feat/ or fix/ prefix?',
            chosen_default: 'feat/',
            skill: 'tmb_planning',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out.issue_id, issueId);
        assert.deepEqual(out.written, ['audit', 'note']);
        const auditRows = db.all(`SELECT event_type, content_json FROM audit WHERE issue_id = ?`, [issueId]);
        const fallbackRow = auditRows.find((a) => a.event_type === 'headless_fallback');
        assert.ok(fallbackRow, 'headless_fallback audit row must exist');
        const content = JSON.parse(fallbackRow.content_json);
        assert.equal(content.skill, 'tmb_planning');
        assert.equal(content.chosen_default, 'feat/');
        const notes = db.all(`SELECT kind, body FROM discussions WHERE issue_id = ? AND kind = 'note'`, [issueId]);
        assert.ok(notes.some((n) => n.body.includes('tmb_planning') && n.body.includes('feat/')));
        db.close();
    });
    it('falls back to system issue (-1) when no open issue exists', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'headless_fallback_record', {
            agent: 'bro',
            question: 'Which base branch?',
            chosen_default: 'dev',
            skill: 'tmb_recovery',
        });
        assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
        const out = parse(r);
        assert.equal(out.issue_id, -1, 'must target system issue when no open issues exist');
        db.close();
    });
    it('respects explicit issue_id override', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'issue A', description: 'x' });
        const issueB = Number((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'issue B', description: 'x',
        }))['id']));
        // Pass an explicit issue_id pointing to B even though there's a newer issue.
        const r = await call(composites.handlers, 'headless_fallback_record', {
            agent: 'bro',
            question: 'Which branch?',
            chosen_default: 'fix/',
            skill: 'tmb_recovery',
            issue_id: issueB,
        });
        assert.ok(!r.isError);
        const out = parse(r);
        assert.equal(out.issue_id, issueB);
        db.close();
    });
    it('rolls back when the second write (note) fails', async () => {
        const db = tempDB();
        const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const issueId = Number((parse(await call(issues.handlers, 'issue_create', {
            agent: 'bro', objective: 'rollback test', description: 'x',
        }))['id']));
        // Poison discussions so the second write throws mid-transaction.
        db.run(`DROP TABLE discussions`);
        const r = await call(composites.handlers, 'headless_fallback_record', {
            agent: 'bro',
            question: 'Which branch?',
            chosen_default: 'feat/',
            skill: 'tmb_planning',
            issue_id: issueId,
        });
        assert.equal(r.isError, true);
        // The audit row must also be absent (rolled back).
        const auditRows = db.all(`SELECT id FROM audit WHERE issue_id = ? AND event_type = 'headless_fallback'`, [issueId]);
        assert.equal(auditRows.length, 0, 'transaction must roll back: no audit row must survive');
        db.close();
    });
    it('rejects non-bro caller', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'headless_fallback_record', {
            agent: 'swe', question: 'q', chosen_default: 'x', skill: 'tmb_planning',
        });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
});
describe('intent_start + headless_intent_start non-duplication (#426)', () => {
    it('calling intent_start then headless_intent_start on same issue produces no duplicate intent rows', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        // First: intent_start (interactive path) creates the issue + intent row.
        const r1 = await call(composites.handlers, 'intent_start', {
            agent: 'bro',
            objective: 'dup guard test',
            intent_verbatim: 'add CSV export',
            branch_id: 'feat/dup-guard-test',
        });
        assert.ok(!r1.isError);
        const { issue_id } = parse(r1);
        // Second: headless_intent_start on the same issue with the same verbatim.
        const r2 = await call(composites.handlers, 'headless_intent_start', {
            agent: 'bro',
            issue_id,
            branch_id: 'feat/dup-guard-test',
            intent_verbatim: 'add CSV export',
            fallback_summary: 'headless retry',
        });
        assert.ok(!r2.isError);
        // The written array must NOT include 'intent' (it was de-duped).
        const out2 = parse(r2);
        assert.ok(!out2.written.includes('intent'), `intent must not be re-written; got: ${JSON.stringify(out2.written)}`);
        // Exactly one intent row with this verbatim must exist.
        const intentRows = db.all(`SELECT id FROM discussions
        WHERE issue_id = ? AND kind = 'intent' AND body = ?`, [issue_id, 'Human intent verbatim: "add CSV export"']);
        assert.equal(intentRows.length, 1, 'exactly one intent row must exist after both calls');
        db.close();
    });
});
describe('parseFilesDirs (#300)', () => {
    it('derives unique dirs from a spec ## Files section', () => {
        const spec = [
            '## Description', 'do a thing', '',
            '## Files',
            '- `src/api/handler.ts` — edit',
            '- `src/api/util.ts` — add',
            '- `docs/guide.md` — update',
            '- `README.md` — touch',
            '',
            '## Success Criteria', '- `src/other.ts` must not be listed (wrong section)',
        ].join('\n');
        assert.deepEqual(parseFilesDirs(spec).sort(), ['', 'docs', 'src/api']);
    });
});
function seedTask(db, opts) {
    db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'brief test obj', 'd', 'open', datetime('now'), datetime('now'))`);
    db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'open', ?, 'abc123def', ?, datetime('now'), datetime('now'))`, [opts.spec, opts.repo ?? null]);
    const row = db.get('SELECT last_insert_rowid() AS id');
    db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
     VALUES (1, 'bro', 'decision', 'Use approach B', datetime('now'))`);
    return row.id;
}
describe('task_brief (#300)', () => {
    const SPEC = ['## Files', '- `src/api/handler.ts` — edit', '', '## Success Criteria', '- works'].join('\n');
    it('bundles task meta + spec + discussions; flags world model unavailable when graph is null', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id }));
        const out = parse(r);
        assert.equal(out['task_id'], id);
        assert.equal(out['branch_id'], 'fix/1-brief');
        assert.equal(out['spec_body'], SPEC);
        assert.equal(out['commit_sha'], 'abc123def', 'commit_sha in brief (pr-reviewer needs it for the diff)');
        assert.equal(out['world_model_warning'], 'world-model-unavailable');
        const disc = out['task_discussions'];
        assert.ok(disc.some((d) => d.kind === 'decision' && d.body === 'Use approach B'));
        db.close();
    });
    it('populates scope_world_model from the spec dirs via the graph', async () => {
        const db = tempDB();
        const id = seedTask(db, { repo: 'app', spec: SPEC });
        // Stub graph: only allDirectoriesForRepo is exercised by task_brief.
        const stubGraph = {
            allDirectoriesForRepo: () => [
                { key: 'app:src/api', repo: 'app', path: 'src/api', parent_path: 'src', summary: 'api layer', summary_source: 'readme', summary_updated_at: null, file_count: 3 },
                { key: 'app:src/api/v2', repo: 'app', path: 'src/api/v2', parent_path: 'src/api', summary: 'v2 handlers', summary_source: 'llm', summary_updated_at: null, file_count: 1 },
            ],
        };
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', stubGraph);
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id }));
        const out = parse(r);
        assert.equal(out['world_model_warning'], undefined);
        const scope = out['scope_world_model'];
        const apiDir = scope.find((sc) => sc.dir === 'src/api');
        assert.ok(apiDir, 'src/api in scope');
        assert.equal(apiDir.summary, 'api layer');
        assert.ok(apiDir.children.some((c) => c.path === 'src/api/v2'), 'child surfaced');
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
});
//# sourceMappingURL=composites.test.js.map