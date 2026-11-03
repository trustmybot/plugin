/**
 * The worktree readers resolve a task's recorded tasks.worktree_path (schema
 * v54, GH 2032) and fall back to <repo>/.claude/worktrees/<slug> when it is
 * NULL: taskWorktreeDir on the server, taskLocation in the hook libs, and the
 * swe-boundary and containment-guard gates that read taskLocation.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { taskWorktreeDir, taskWorktreePath } from '../tools/composites.js';
import { taskLocation } from '../hooks/lib/agent-context.js';
import { sweBoundary } from '../hooks/swe-boundary.js';
import { containmentGuard } from '../hooks/containment-guard.js';
const SCHEMA = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src/schema.sql'), 'utf8');
const NOW = '2026-10-27T10:00:00.000Z';
function reason(stdout) {
    if (stdout === '')
        return null;
    return JSON.parse(stdout).hookSpecificOutput
        .permissionDecisionReason ?? null;
}
describe('taskWorktreeDir (GH 2032)', () => {
    it('returns the recorded worktree_path when set', () => {
        assert.equal(taskWorktreeDir('/r', { branch_id: 'fix/x', worktree_path: '/w/session' }), '/w/session');
    });
    it('returns the slug path when worktree_path is NULL or absent', () => {
        assert.equal(taskWorktreeDir('/r', { branch_id: 'fix/x', worktree_path: null }), '/r/.claude/worktrees/x');
        assert.equal(taskWorktreeDir('/r', { branch_id: 'fix/x' }), taskWorktreePath('/r', 'fix/x'));
    });
});
describe('hook readers resolve tasks.worktree_path (GH 2032)', () => {
    let dir;
    let project;
    let sessionWt;
    let adoptedSlug;
    let plainSlug;
    let db;
    let env;
    const payload = (taskId, tool, input) => {
        const transcript = join(dir, `spawn-${taskId}.jsonl`);
        return JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'unit',
            cwd: project,
            tool_name: tool,
            tool_input: input,
            agent_type: 'swe',
            agent_transcript_path: transcript,
        });
    };
    const write = (taskId, path) => payload(taskId, 'Write', { file_path: path, content: 'x' });
    const deniedRoots = () => {
        const d = new DatabaseSync(db, { readOnly: true });
        try {
            return d.prepare("SELECT content_json AS c FROM audit WHERE event_type = 'containment_denied' ORDER BY id").all().map((r) => JSON.parse(r.c).root);
        }
        finally {
            d.close();
        }
    };
    before(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-wt-readers-')));
        project = join(dir, 'project');
        sessionWt = join(dir, 'session-wt');
        adoptedSlug = join(project, '.claude/worktrees/adopted');
        plainSlug = join(project, '.claude/worktrees/plain');
        for (const d of [sessionWt, adoptedSlug, plainSlug])
            mkdirSync(join(d, 'src'), { recursive: true });
        db = join(project, '.claude/tmb/trajectory.db');
        mkdirSync(dirname(db), { recursive: true });
        const d = new DatabaseSync(db);
        try {
            d.exec(SCHEMA);
            d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
            d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'o', 'open', ?, ?)").run(NOW, NOW);
            const task = d.prepare(`INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, files, worktree_path, worktree_adopted)
         VALUES (?, 2, ?, 'd', 'running', ?, ?, 'project', '["src"]', ?, ?)`);
            task.run(7, 'fix/adopted', NOW, NOW, sessionWt, 1);
            task.run(8, 'fix/plain', NOW, NOW, null, 0);
        }
        finally {
            d.close();
        }
        for (const id of [7, 8]) {
            writeFileSync(join(dir, `spawn-${id}.jsonl`), `{"message":{"content":[{"type":"text","text":"task_id=${id}"}]}}\n`);
        }
        env = {
            ...process.env,
            TRAJECTORY_DB_PATH: db,
            CLAUDE_PROJECT_DIR: project,
            TMB_MODEL_CACHE_DIR: join(dir, 'cache'),
        };
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    it('taskLocation returns the recorded worktree, else the slug path', () => {
        assert.equal(taskLocation(db, '7', env).worktree, sessionWt);
        assert.equal(taskLocation(db, '8', env).worktree, plainSlug);
        assert.equal(taskLocation(db, '7', env).code, 0);
    });
    it('taskLocation keeps a "|" in the recorded path intact', () => {
        const odd = join(dir, 'a|b');
        const d = new DatabaseSync(db);
        try {
            d.prepare('UPDATE tasks SET worktree_path = ? WHERE id = 7').run(odd);
            const loc = taskLocation(db, '7', env);
            assert.deepEqual({ worktree: loc.worktree, repo: loc.repo, repoRoot: loc.repoRoot }, { worktree: odd, repo: 'project', repoRoot: project });
        }
        finally {
            d.prepare('UPDATE tasks SET worktree_path = ? WHERE id = 7').run(sessionWt);
            d.close();
        }
    });
    it('taskLocation falls back to the slug path on a DB without the v54 column', () => {
        const v53 = join(dir, 'v53.db');
        const d = new DatabaseSync(v53);
        try {
            d.exec(SCHEMA);
            d.exec('ALTER TABLE tasks DROP COLUMN worktree_adopted; ALTER TABLE tasks DROP COLUMN worktree_path;');
            d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
            d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'o', 'open', ?, ?)").run(NOW, NOW);
            d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (7, 2, 'fix/adopted', 'd', 'running', ?, ?, 'project')").run(NOW, NOW);
        }
        finally {
            d.close();
        }
        const loc = taskLocation(v53, '7', env);
        assert.equal(loc.code, 0);
        assert.equal(loc.worktree, adoptedSlug);
    });
    it('swe-boundary admits a Write under the recorded worktree and denies one under the slug path', async () => {
        const inside = await sweBoundary(write(7, join(sessionWt, 'src/a.ts')), env);
        assert.equal(reason(inside.stdout), null);
        const slug = await sweBoundary(write(7, join(adoptedSlug, 'src/a.ts')), env);
        assert.match(reason(slug.stdout) ?? '', /^BLOCKED: SWE may only edit files inside its assigned worktree/);
        assert.ok((reason(slug.stdout) ?? '').includes(`(${sessionWt})`));
    });
    it('swe-boundary keeps the slug path for a task with no recorded worktree', async () => {
        const inside = await sweBoundary(write(8, join(plainSlug, 'src/a.ts')), env);
        assert.equal(reason(inside.stdout), null);
        const elsewhere = await sweBoundary(write(8, join(sessionWt, 'src/a.ts')), env);
        assert.match(reason(elsewhere.stdout) ?? '', /^BLOCKED: SWE may only edit files inside its assigned worktree/);
    });
    it('containment-guard roots the swe at the recorded worktree, else at the slug path', async () => {
        const realGetuid = process.getuid;
        process.getuid = () => 4242424;
        const cgEnv = { ...env, TMPDIR: join(dir, 'host-tmp') };
        try {
            assert.deepEqual(await containmentGuard(write(7, join(sessionWt, 'src/a.ts')), cgEnv), { stdout: '', code: 0 });
            const before = deniedRoots().length;
            const slug = await containmentGuard(write(7, join(adoptedSlug, 'src/a.ts')), cgEnv);
            assert.notEqual(reason(slug.stdout), null);
            assert.deepEqual(deniedRoots().slice(before), [sessionWt]);
            assert.deepEqual(await containmentGuard(write(8, join(plainSlug, 'src/a.ts')), cgEnv), { stdout: '', code: 0 });
            const plain = await containmentGuard(write(8, join(sessionWt, 'src/a.ts')), cgEnv);
            assert.notEqual(reason(plain.stdout), null);
            assert.deepEqual(deniedRoots().slice(before + 1), [plainSlug]);
        }
        finally {
            process.getuid = realGetuid;
        }
    });
});
//# sourceMappingURL=worktree-readers.test.js.map