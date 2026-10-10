import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { auditTools, insertAudit } from '../tools/audit.js';
import { discussionTools, insertDiscussion } from '../tools/discussions.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { compositeTools } from '../tools/composites.js';
import { validationTools } from '../tools/validation.js';
import { cheatcodeTools } from '../tools/cheatcode.js';
import { scanTools } from '../tools/scan.js';
import { backfillMissing } from '../embeddings/backfill.js';
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
    return (await h(args));
}
const GATE_WAIVERS = {
    waive_scope_gate: true,
    waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
    waive_spec_shape: true,
    waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
};
let modelAvailable = false;
async function waitForCount(db, sql, params, expected) {
    const deadline = Date.now() + 5000;
    let n = 0;
    do {
        n = db.get(sql, params)?.n ?? 0;
        if (n >= expected)
            return n;
        await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    return n;
}
async function assertAuditEmbedded(db, auditId) {
    const n = await waitForCount(db, 'SELECT COUNT(*) AS n FROM audit_embeddings WHERE audit_id = ?', [auditId], modelAvailable ? 1 : 0);
    assert.equal(n, modelAvailable ? 1 : 0, modelAvailable ? 'audit row embedded at write time' : 'no model → FTS-only');
}
function seedRepoIssue(db, repo = 'app', repoPath = '/tmp/app', issueId = 1) {
    db.run(`INSERT OR IGNORE INTO repos (name, path, target_branch) VALUES (?, ?, 'main')`, [repo, repoPath]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at, repo)
     VALUES (?, 'o', 'd', 'open', datetime('now'), datetime('now'), ?)`, [issueId, repo]);
    return issueId;
}
before(async () => {
    modelAvailable = (await embed('model availability probe')) !== null;
});
describe('insertAudit — single audit write path', () => {
    it('writes repo resolved from the parent issue', () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        const id = insertAudit(db, { issue_id: issueId, from_node: 'bro', event_type: 'probe', summary: 's' });
        const row = db.get('SELECT repo, content_json FROM audit WHERE id = ?', [id]);
        assert.equal(row?.repo, 'app');
        assert.equal(row?.content_json, '{}');
        db.close();
    });
    it('an explicit repo wins over the issue repo', () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        db.run(`INSERT INTO repos (name, path) VALUES ('other', '/tmp/other')`);
        const id = insertAudit(db, { issue_id: issueId, from_node: 'bro', event_type: 'probe', summary: 's', repo: 'other' });
        assert.equal(db.get('SELECT repo FROM audit WHERE id = ?', [id])?.repo, 'other');
        db.close();
    });
    it('system issue -1 keeps repo NULL', () => {
        const db = tempDB();
        seedRepoIssue(db);
        const id = insertAudit(db, { issue_id: -1, from_node: 'bro', event_type: 'probe', summary: 's' });
        assert.equal(db.get('SELECT repo FROM audit WHERE id = ?', [id])?.repo, null);
        db.close();
    });
    it('embeds the row after the write returns', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        const id = insertAudit(db, {
            issue_id: issueId,
            from_node: 'bro',
            event_type: 'probe',
            summary: 'embedded at write time',
            content_json: JSON.stringify({ k: 'v' }),
        });
        await assertAuditEmbedded(db, id);
        db.close();
    });
    it('inside db.transaction() the row commits and is still embedded', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        const id = db.transaction(() => insertAudit(db, { issue_id: issueId, from_node: 'bro', event_type: 'probe', summary: 'in a transaction' }));
        const row = db.get('SELECT repo FROM audit WHERE id = ?', [id]);
        assert.equal(row?.repo, 'app', 'row committed with repo');
        await assertAuditEmbedded(db, id);
        db.close();
    });
    it('audit_append routes through insertAudit (repo populated, same row shape)', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        const r = await call(auditTools(db).handlers, 'audit_append', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'append_probe',
            summary: 'via audit_append',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const row = parse(r);
        assert.equal(row['event_type'], 'append_probe');
        assert.equal(row['repo'], 'app');
        await assertAuditEmbedded(db, row['id']);
        db.close();
    });
    it('audit_append still rejects content_json over 1 MB', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        const r = await call(auditTools(db).handlers, 'audit_append', {
            agent: 'bro',
            issue_id: String(issueId),
            from_node: 'bro',
            event_type: 'too_big',
            summary: 's',
            content_json: JSON.stringify({ x: 'a'.repeat(1_000_001) }),
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'], /exceeds 1MB/);
        db.close();
    });
});
describe('insertDiscussion — repo populated', () => {
    it('resolves repo from the issue; explicit repo wins; system issue stays NULL', () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        db.run(`INSERT INTO repos (name, path) VALUES ('other', '/tmp/other')`);
        const a = insertDiscussion(db, { issue_id: issueId, author: 'bro', kind: 'note', body: 'a' });
        const b = insertDiscussion(db, { issue_id: issueId, author: 'bro', kind: 'note', body: 'b', repo: 'other' });
        const c = insertDiscussion(db, { issue_id: -1, author: 'bro', kind: 'note', body: 'c' });
        const repoOf = (id) => db.get('SELECT repo FROM discussions WHERE id = ?', [id])?.repo;
        assert.equal(repoOf(a), 'app');
        assert.equal(repoOf(b), 'other');
        assert.equal(repoOf(c), null);
        db.close();
    });
});
describe('composite audit writers populate audit.repo', () => {
    async function seedTaskForIssue(db, issueId, branch) {
        const discussions = discussionTools(db);
        const audit = auditTools(db);
        await call(discussions.handlers, 'discussion_append', {
            agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'scope?',
        });
        await call(audit.handlers, 'audit_append', {
            agent: 'bro', issue_id: issueId, event_type: 'branch_id_proposed', from_node: 'bro', branch_id: branch, summary: 's',
        });
        const created = parseBatch(await call(taskTools(db).handlers, 'task_create_batch', {
            agent: 'bro',
            issue_id: issueId,
            emit_planning_complete: true,
            ...GATE_WAIVERS,
            tasks: [{ branch_id: branch, description: 'd', spec_body: 's', repo: 'app' }],
        }));
        return String(created[0].id);
    }
    function auditRepos(db, issueId, eventType) {
        return db
            .all('SELECT repo FROM audit WHERE issue_id = ? AND event_type = ?', [issueId, eventType])
            .map((r) => r.repo);
    }
    it('task_create_batch: planning_complete + gate-waiver rows carry the issue repo; bro agent_runs row carries the task repo', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const issueId = String(parse(await call(issueTools(db).handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'repo-scoped',
        }))['id']);
        const taskId = await seedTaskForIssue(db, issueId, 'fix/batch');
        const events = ['planning_complete', 'scope_gate_waived', 'branch_gate_waived', 'intent_gate_waived', 'decision_gate_waived', 'spec_shape_gate_waived'];
        for (const e of events)
            assert.deepEqual(auditRepos(db, issueId, e), ['app'], `${e} repo`);
        const run = db.get(`SELECT repo FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [taskId]);
        assert.equal(run?.repo, 'app');
        db.close();
    });
    it('intent_start: branch_id_proposed carries the issue repo', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const r = await call(compositeTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, 'intent_start', {
            agent: 'bro', objective: 'intent repo', intent_verbatim: 'do it', branch_id: 'feat/intent-repo',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const issueId = parse(r)['issue_id'];
        assert.deepEqual(auditRepos(db, issueId, 'branch_id_proposed'), ['app']);
        const discRepos = db.all('SELECT repo FROM discussions WHERE issue_id = ?', [issueId]);
        assert.ok(discRepos.length > 0 && discRepos.every((d) => d.repo === 'app'), 'intent_start discussions carry repo');
        db.close();
    });
    it('task_retry: task_retry_attempted carries the issue repo; the new bro agent_runs row carries the task repo', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const issueId = String(parse(await call(issueTools(db).handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'retry repo',
        }))['id']);
        const failedId = await seedTaskForIssue(db, issueId, 'fix/retry-src');
        await call(taskTools(db).handlers, 'task_update_status', { agent: 'swe', task_id: failedId, status: 'failed' });
        const r = await call(compositeTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, 'task_retry', {
            agent: 'bro',
            failed_task_id: failedId,
            new_branch_id: 'fix/retry-v2',
            corrected_spec_body: 'fixed',
            retry_rationale: 'use approach B',
            description: 'retry',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const newTaskId = parse(r)['task_id'];
        assert.deepEqual(auditRepos(db, issueId, 'task_retry_attempted'), ['app']);
        const run = db.get(`SELECT repo FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [newTaskId]);
        assert.equal(run?.repo, 'app');
        db.close();
    });
    it('bro_atomic_close + bro_verification_fail_record: audit rows carry the issue repo', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'audit-repo-close-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
        const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
        const db = tempDB();
        try {
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
            const issueId = String(parse(await call(issueTools(db, dbPath).handlers, 'issue_create', {
                labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'close repo',
            }))['id']);
            const taskId = await seedTaskForIssue(db, issueId, 'fix/close-repo');
            const composites = compositeTools(db, dbPath);
            const fail = await call(composites.handlers, 'bro_verification_fail_record', {
                agent: 'bro', task_id: taskId, which_check: 'V1', details: 'missing test',
            });
            assert.ok(!fail.isError, JSON.stringify(parse(fail)));
            await call(taskTools(db).handlers, 'task_update_status', {
                agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
            });
            const r = await call(composites.handlers, 'bro_atomic_close', {
                agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true,
            });
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            for (const e of ['bro_verification_fail', 'bro_verification_pass', 'scope_gate_waived']) {
                const repos = auditRepos(db, issueId, e);
                assert.ok(repos.length > 0 && repos.every((x) => x === 'app'), `${e} repo: ${JSON.stringify(repos)}`);
            }
        }
        finally {
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('task_provision: planning_complete audit, decision discussion and bro agent_runs row carry repo', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'audit-repo-provision-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@t.t');
        git('config', 'user.name', 't');
        writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
        git('add', '.');
        git('commit', '-q', '-m', 'base');
        git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
        const db = tempDB();
        try {
            seedRepoIssue(db, 'app', repoRoot);
            const r = await call(compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers, 'task_provision', {
                agent: 'bro',
                issue_id: 1,
                branch_id: 'feat/provision-repo',
                decision_body: 'Chosen approach: X because Y.',
                task: {
                    title: 'X',
                    description: 'implement X',
                    spec_body: ['## Description', 'x', '', '## Success Criteria', '- works'].join('\n'),
                    files: ['a.txt'],
                    verification: ['true'],
                    repo: 'app',
                },
            });
            assert.ok(!r.isError, JSON.stringify(parse(r)));
            const taskId = parse(r)['task_id'];
            assert.deepEqual(auditRepos(db, 1, 'planning_complete'), ['app']);
            const decision = db.get(`SELECT repo FROM discussions WHERE issue_id = 1 AND kind = 'decision'`);
            assert.equal(decision?.repo, 'app');
            const run = db.get(`SELECT repo FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [taskId]);
            assert.equal(run?.repo, 'app');
        }
        finally {
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('cheatcode_approve: system-issue audit row goes through insertAudit (repo NULL, embedded)', async () => {
        const db = tempDB();
        const r = await call(cheatcodeTools(db).handlers, 'cheatcode_approve', {
            agent: 'bro',
            candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf' },
        });
        assert.notEqual(r.isError, true);
        const row = db.get(`SELECT id, repo FROM audit WHERE event_type = 'cheatcode_approved' ORDER BY id DESC LIMIT 1`);
        assert.ok(row);
        assert.equal(row.repo, null);
        await assertAuditEmbedded(db, row.id);
        db.close();
    });
    it('scan_run: deep_scan_completed goes through insertAudit (system issue, embedded)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'audit-repo-scan-'));
        try {
            const root = join(ws, 'app');
            mkdirSync(root, { recursive: true });
            execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
            execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
            execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
            writeFileSync(join(root, 'README.md'), 'app\n');
            execFileSync('git', ['add', '.'], { cwd: root });
            execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
            const db = tempDB({ seedScan: false });
            const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            assert.ok(!r.isError, JSON.stringify(r));
            const row = db.get(`SELECT id, repo FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1`);
            assert.ok(row);
            assert.equal(row.repo, null);
            await assertAuditEmbedded(db, row.id);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('validation_record — validation_attempts.repo', () => {
    it('writes the task repo', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
        const issueId = String(parse(await call(issueTools(db).handlers, 'issue_create', {
            labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'va repo',
        }))['id']);
        const created = parseBatch(await call(taskTools(db).handlers, 'task_create_batch', {
            agent: 'bro', issue_id: issueId, ...GATE_WAIVERS,
            tasks: [{ branch_id: 'fix/va-repo', description: 'd', spec_body: 's', repo: 'app' }],
        }));
        const taskId = String(created[0].id);
        const r = await call(validationTools(db).handlers, 'validation_record', {
            agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: 'ok',
            subagent_session_id: 'sess-1', mcp_available: true,
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const row = db.get('SELECT repo FROM validation_attempts WHERE task_id = ?', [taskId]);
        assert.equal(row?.repo, 'app');
        db.close();
    });
    it('falls back to the issue repo when the task has none', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, created_at, updated_at)
       VALUES (?, 'fix/no-task-repo', 'main', 't', 'd', 'completed', datetime('now'), datetime('now'))`, [issueId]);
        const taskId = db.get(`SELECT id FROM tasks WHERE branch_id = 'fix/no-task-repo'`).id;
        const r = await call(validationTools(db).handlers, 'validation_record', {
            agent: 'pr-reviewer', task_id: String(taskId), attempt_n: 1, verdict: 'pass', feedback: 'ok',
            subagent_session_id: 'sess-2', mcp_available: true,
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(db.get('SELECT repo FROM validation_attempts WHERE task_id = ?', [taskId])?.repo, 'app');
        db.close();
    });
});
describe('lazy embed backfill tick on search', () => {
    it('backfillMissing embeds at most `limit` rows per call', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        for (let i = 0; i < 3; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'note', ?, datetime('now'))`, [issueId, `raw row ${i}`]);
        }
        const attempted = await backfillMissing(db, 'discussions', 2);
        assert.equal(attempted, 2);
        const embedded = db.get('SELECT COUNT(*) AS n FROM discussions_embeddings')?.n ?? 0;
        assert.equal(embedded, modelAvailable ? 2 : 0);
        db.close();
    });
    it('audit_search embeds un-embedded rows and returns them after one call', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'hook', 'hook_written', 'zebra crossing hook event', '{}', datetime('now'))`, [issueId]);
        const auditId = db.get(`SELECT id FROM audit WHERE event_type = 'hook_written'`).id;
        assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_embeddings WHERE audit_id = ?', [auditId])?.n, 0);
        const r = await call(auditTools(db).handlers, 'audit_search', {
            agent: 'bro', query: 'zebra crossing hook event', mode: 'semantic', k: 20,
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const ids = parse(r)['results'].map((x) => x.id);
        if (modelAvailable) {
            assert.ok(ids.includes(auditId), `lazily embedded row must be returned: ${JSON.stringify(ids)}`);
        }
        else {
            assert.deepEqual(ids, [], 'no model → semantic_unavailable, tool still ok');
        }
        db.close();
    });
    it('discussion_search embeds un-embedded rows and returns them after one call', async () => {
        const db = tempDB();
        const issueId = seedRepoIssue(db);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (?, 'bro', 'note', 'giraffe migration discussion', datetime('now'))`, [issueId]);
        const discId = db.get(`SELECT id FROM discussions WHERE body = 'giraffe migration discussion'`).id;
        const r = await call(discussionTools(db).handlers, 'discussion_search', {
            agent: 'bro', query: 'giraffe migration discussion', mode: 'semantic', k: 20,
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const ids = parse(r)['results'].map((x) => x.id);
        if (modelAvailable) {
            assert.ok(ids.includes(discId), `lazily embedded row must be returned: ${JSON.stringify(ids)}`);
        }
        else {
            assert.deepEqual(ids, []);
        }
        db.close();
    });
});
//# sourceMappingURL=audit.test.js.map