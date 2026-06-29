import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { compositeTools, filesToDirs, scopeCheckCommit } from '../tools/composites.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
import { embed } from '../embeddings/model.js';
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
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro',
                task_id: taskId,
                commit_sha: 'abc1234',
                verification_summary: 'ok',
                close_issue_if_last_task: true,
                waive_scope_gate: true,
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
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
                close_issue_if_last_task: true, waive_scope_gate: true, _spawnFn: spawnFn,
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
describe('scopeCheckCommit (#157)', () => {
    it('covers exact paths and dir-prefix entries; flags the rest', () => {
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
            assert.deepEqual(res.outOfScope, ['rogue.ts'], 'dist/ covers dist/index.js; rogue.ts is out');
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
    async function setup(taskFiles, changedFiles) {
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
        git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', git(repoRoot, 'rev-parse', 'HEAD'));
        for (const rel of changedFiles) {
            const abs = join(repoRoot, rel);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, `${rel}\n`);
        }
        git(repoRoot, 'add', '.');
        git(repoRoot, 'commit', '-q', '-m', 'work');
        const sha = git(repoRoot, 'rev-parse', 'HEAD');
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
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
        db.run(`UPDATE tasks SET parent_branch_id='dev', files=? WHERE id=?`, [JSON.stringify(taskFiles), taskId]);
        await call(tasks.handlers, 'task_update_status', {
            agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha.slice(0, 12),
        });
        return {
            db, composites, taskId, issueId, sha,
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
                waive_scope_gate: true,
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
describe('pr_monitor_worktree', () => {
    it('rejects non-pr-reviewer caller', async () => {
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
            agent: 'pr-reviewer', commit_sha: 'not-a-sha', repo_path: '/tmp', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /hex SHA/);
    });
    it('rejects relative repo_path', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: 'relative/path', command: 'echo ok',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /absolute path/);
    });
    it('rejects empty command', async () => {
        const db = tempDB();
        const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
        const r = await call(composites.handlers, 'pr_monitor_worktree', {
            agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: '/tmp', command: '   ',
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /non-empty/);
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
    db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'open', ?, ?, 'abc123def', ?, datetime('now'), datetime('now'))`, [opts.spec, JSON.stringify(opts.files ?? []), opts.repo ?? null]);
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
        const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id }));
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
describe('task_provision (#157)', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');
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
            // Decision discussion written.
            const decision = db.get(`SELECT body, author FROM discussions WHERE issue_id = 1 AND kind = 'decision' LIMIT 1`);
            assert.ok(decision);
            assert.match(decision.body, /Chosen approach/);
            assert.equal(decision.author, 'bro');
            // Task row written with typed fields.
            const task = db.get(`SELECT id, status, files, verification, repo FROM tasks WHERE id = ?`, [out['task_id']]);
            assert.ok(task);
            assert.equal(task.status, 'pending');
            assert.deepEqual(JSON.parse(task.files), ['src/x.ts']);
            assert.deepEqual(JSON.parse(task.verification), ['bun run build']);
            // planning_complete audit + bro agent_run row written.
            const audit = db.get(`SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'planning_complete'`);
            assert.equal(audit.c, 1);
            const run = db.get(`SELECT COUNT(*) AS c FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [out['task_id']]);
            assert.equal(run.c, 1);
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
            const second = parse(await call(composites.handlers, 'task_provision', { ...baseArgs, issue_id: 2 }));
            assert.equal(second['git_setup'], 'reused', 'existing branch + worktree reused, not error');
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
//# sourceMappingURL=composites.test.js.map