/**
 * adoptTaskWorktree (GH 2032): records a linked session worktree as a task's
 * worktree after four checks, each refusal writing nothing; ADOPT_WORKTREE_ENABLED
 * is on, and the `{ enabled }` options seam still reaches the off path. Then
 * task_provision, task_reopen and task_retry with adopt_worktree: each adopts
 * the session worktree without a slug worktree, and each refusal is checked
 * before the branch is cut and writes nothing.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADOPT_WORKTREE_ENABLED, adoptTaskWorktree, compositeTools, taskWorktreePath } from '../tools/composites.js';
import { tempDB } from './helpers.js';
const NOW = '2026-10-27T10:00:00.000Z';
const ENABLED = { enabled: true };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function initRepo(root) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.t');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
}
describe('adoptTaskWorktree (GH 2032)', () => {
    let ws;
    let repo;
    let otherRepo;
    let session;
    let db;
    const seedTask = (id, branch, status = 'running') => {
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
       VALUES (?, 2, ?, 'd', ?, ?, ?, 'app')`, [id, branch, status, NOW, NOW]);
        git(repo, 'branch', branch);
    };
    const state = () => ({
        tasks: db.all('SELECT * FROM tasks ORDER BY id').map((r) => ({ ...r })),
        discussions: db.get('SELECT count(*) AS n FROM discussions')?.n,
        audit: db.get('SELECT count(*) AS n FROM audit')?.n,
        refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
        head: git(session, 'rev-parse', '--abbrev-ref', 'HEAD'),
    });
    before(() => {
        ws = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-wt-adopt-')));
        repo = join(ws, 'app');
        otherRepo = join(ws, 'other');
        for (const r of [repo, otherRepo]) {
            mkdirSync(r, { recursive: true });
            initRepo(r);
        }
        session = join(ws, 'session-wt');
        git(repo, 'worktree', 'add', '-q', '-b', 'claude/session', session);
    });
    after(() => {
        rmSync(ws, { recursive: true, force: true });
    });
    beforeEach(() => {
        db?.close();
        db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repo]);
        db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'o', 'open', ?, ?)`, [NOW, NOW]);
        git(session, 'switch', '-q', 'claude/session');
        for (const b of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/fix/').split('\n')) {
            if (b)
                git(repo, 'branch', '-q', '-D', b);
        }
    });
    it('is on by default; turned off through the seam it refuses with adopt_worktree_unavailable, naming GH 2032, and writes nothing', () => {
        assert.equal(ADOPT_WORKTREE_ENABLED, true);
        seedTask(7, 'fix/off');
        const before = state();
        const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session }, { enabled: false });
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.error, 'adopt_worktree_unavailable');
        assert.match(!r.ok ? r.message : '', /GH 2032/);
        assert.deepEqual(state(), before);
        const on = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session });
        assert.equal(on.ok, true);
        assert.equal(on.ok && on.worktree_path, session);
    });
    it('records realpath(W) and worktree_adopted=1, checks the task branch out in W, and creates no slug worktree', () => {
        seedTask(7, 'fix/adopt-a');
        const viaSymlink = join(ws, 'session-link');
        if (!existsSync(viaSymlink))
            symlinkSync(session, viaSymlink);
        const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: viaSymlink }, ENABLED);
        assert.deepEqual(r, { ok: true, task_id: 7, branch_id: 'fix/adopt-a', worktree_path: session, git_setup: 'switched' });
        assert.deepEqual({ ...db.get('SELECT worktree_path, worktree_adopted FROM tasks WHERE id = 7') }, { worktree_path: session, worktree_adopted: 1 });
        assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/adopt-a');
        assert.equal(existsSync(taskWorktreePath(repo, 'fix/adopt-a')), false);
        assert.equal(existsSync(join(repo, '.claude')), false);
    });
    it('keeps the record and reports git_setup error with a diagnostic when git switch fails', () => {
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
       VALUES (7, 2, 'fix/no-such-branch', 'd', 'running', ?, ?, 'app')`, [NOW, NOW]);
        const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session }, ENABLED);
        assert.equal(r.ok, true);
        assert.equal(r.ok && r.git_setup, 'error');
        assert.ok(r.ok && typeof r.diagnostic === 'string' && r.diagnostic.length > 0);
        assert.equal(db.get('SELECT worktree_path FROM tasks WHERE id = 7')?.worktree_path, session);
    });
    const refusals = [
        {
            name: 'a worktree of another repo',
            error: 'adopt_worktree_repo_mismatch',
            setup: () => ({ worktreePath: otherRepo }),
        },
        {
            name: 'a path that is not a git worktree',
            error: 'adopt_worktree_repo_mismatch',
            setup: () => ({ worktreePath: ws }),
        },
        {
            name: 'a path that does not exist',
            error: 'adopt_worktree_repo_mismatch',
            setup: () => ({ worktreePath: join(ws, 'missing') }),
        },
        {
            name: 'a subdirectory of the linked worktree',
            error: 'adopt_worktree_repo_mismatch',
            setup: () => {
                mkdirSync(join(session, 'sub'), { recursive: true });
                return { worktreePath: join(session, 'sub'), cleanup: () => rmSync(join(session, 'sub'), { recursive: true }) };
            },
        },
        {
            name: 'the main checkout',
            error: 'adopt_worktree_main_checkout',
            setup: () => ({ worktreePath: repo }),
        },
        {
            name: 'a worktree with tracked changes',
            error: 'adopt_worktree_dirty',
            setup: () => {
                writeFileSync(join(session, 'seed.txt'), 'edited\n');
                return { worktreePath: session, cleanup: () => git(session, 'checkout', '--', 'seed.txt') };
            },
        },
    ];
    for (const c of refusals) {
        it(`refuses ${c.name} with ${c.error}, leaving the task row, discussions and refs unchanged`, () => {
            seedTask(7, 'fix/refused');
            const { worktreePath, cleanup } = c.setup();
            try {
                const before = state();
                const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath }, ENABLED);
                assert.equal(r.ok, false);
                assert.equal(!r.ok && r.error, c.error);
                assert.ok(!r.ok && r.message.length > 0);
                assert.deepEqual(state(), before);
            }
            finally {
                cleanup?.();
            }
        });
    }
    it('an untracked file does not make the worktree dirty', () => {
        seedTask(7, 'fix/untracked');
        writeFileSync(join(session, 'scratch.txt'), 'x\n');
        try {
            const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session }, ENABLED);
            assert.equal(r.ok, true);
        }
        finally {
            rmSync(join(session, 'scratch.txt'));
        }
    });
    it('refuses an unknown task with adopt_worktree_task_not_found', () => {
        const before = state();
        const r = adoptTaskWorktree(db, { taskId: 99, repoPath: repo, worktreePath: session }, ENABLED);
        assert.equal(!r.ok && r.error, 'adopt_worktree_task_not_found');
        assert.deepEqual(state(), before);
    });
    for (const holding of ['pending', 'running', 'needs_validation']) {
        it(`a second adoption of W while the first task is ${holding} returns worktree_in_use naming it, then succeeds once it is closed`, () => {
            seedTask(7, 'fix/first');
            seedTask(8, 'fix/second');
            assert.equal(adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session }, ENABLED).ok, true);
            db.run('UPDATE tasks SET status = ? WHERE id = 7', [holding]);
            const before = state();
            const r = adoptTaskWorktree(db, { taskId: 8, repoPath: repo, worktreePath: session }, ENABLED);
            assert.equal(!r.ok && r.error, 'worktree_in_use');
            assert.equal(!r.ok && r.task_id, 7);
            assert.match(!r.ok ? r.message : '', /task 7/);
            assert.deepEqual(state(), before);
            db.run(`UPDATE tasks SET status = 'closed' WHERE id = 7`);
            const again = adoptTaskWorktree(db, { taskId: 8, repoPath: repo, worktreePath: session }, ENABLED);
            assert.equal(again.ok, true);
            assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/second');
            assert.deepEqual({ ...db.get('SELECT worktree_path, worktree_adopted FROM tasks WHERE id = 8') }, { worktree_path: session, worktree_adopted: 1 });
        });
        it(`adopting a ${holding} task's slug worktree (worktree_path NULL) returns worktree_in_use naming it and switches nothing`, () => {
            seedTask(7, 'fix/b', holding);
            seedTask(8, 'fix/a');
            const slug = taskWorktreePath(repo, 'fix/b');
            git(repo, 'worktree', 'add', '-q', '--detach', slug, 'fix/b');
            try {
                const slugHead = git(slug, 'rev-parse', 'HEAD');
                const before = state();
                const r = adoptTaskWorktree(db, { taskId: 8, repoPath: repo, worktreePath: slug }, ENABLED);
                assert.equal(!r.ok && r.error, 'worktree_in_use');
                assert.equal(!r.ok && r.task_id, 7);
                assert.match(!r.ok ? r.message : '', /task 7/);
                assert.deepEqual(state(), before);
                assert.equal(db.get('SELECT worktree_path FROM tasks WHERE id = 8')?.worktree_path, null);
                assert.equal(git(slug, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
                assert.equal(git(slug, 'rev-parse', 'HEAD'), slugHead);
            }
            finally {
                git(repo, 'worktree', 'remove', '--force', slug);
            }
        });
    }
});
describe('task_provision, task_reopen and task_retry adopt_worktree (GH 2032)', () => {
    const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
    let ws;
    let repo;
    let otherRepo;
    let session;
    let db;
    let handlers;
    const call = async (name, args) => {
        const r = (await handlers[name](args));
        const text = r.content[0].text;
        const out = text.startsWith('{') ? JSON.parse(text) : { text };
        return { isError: r.isError === true, out };
    };
    const provision = (branch, adopt) => call('task_provision', {
        agent: 'bro', issue_id: 2, branch_id: branch, decision_body: 'Chosen approach: adopt the session worktree.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
        adopt_worktree: adopt,
    });
    const failedTask = (branch) => {
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, repo, files, verification, created_at, updated_at)
       VALUES (2, ?, 'main', '', 'd', 'failed', ?, 'app', '["src/x.ts"]', '["true"]', ?, ?)`, [branch, SPEC, NOW, NOW]);
        return db.get('SELECT id FROM tasks WHERE branch_id = ?', [branch]).id;
    };
    const retry = (failedId, branch, adopt) => call('task_retry', {
        agent: 'bro', failed_task_id: String(failedId), new_branch_id: branch, corrected_spec_body: SPEC,
        retry_rationale: 'redesigned approach', description: 'd', adopt_worktree: adopt,
    });
    const closedTask = (branch) => {
        const id = failedTask(branch);
        db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
        git(repo, 'branch', branch, 'main');
        return id;
    };
    const reopen = (id, adopt) => call('task_reopen', { agent: 'bro', task_id: id, reason: 'review failed', files_add: ['src/y.ts'], adopt_worktree: adopt });
    const state = () => ({
        tasks: db.all('SELECT * FROM tasks ORDER BY id').map((r) => ({ ...r })),
        discussions: db.get('SELECT count(*) AS n FROM discussions')?.n,
        audit: db.get('SELECT count(*) AS n FROM audit')?.n,
        refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
        head: git(session, 'rev-parse', '--abbrev-ref', 'HEAD'),
    });
    const adoptedRow = (id) => ({ ...db.get('SELECT worktree_path, worktree_adopted FROM tasks WHERE id = ?', [id]) });
    const noSlugWorktree = (branch) => {
        assert.equal(existsSync(taskWorktreePath(repo, branch)), false);
        assert.equal(existsSync(join(repo, '.claude', 'worktrees')), false);
    };
    before(() => {
        ws = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-wt-adopt-tools-')));
        repo = join(ws, 'app');
        otherRepo = join(ws, 'other');
        for (const r of [repo, otherRepo]) {
            mkdirSync(r, { recursive: true });
            initRepo(r);
        }
        git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
        session = join(ws, 'session-wt');
        git(repo, 'worktree', 'add', '-q', '-b', 'claude/session', session);
    });
    after(() => {
        db?.close();
        rmSync(ws, { recursive: true, force: true });
    });
    beforeEach(() => {
        db?.close();
        db = tempDB();
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repo]);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (2, 'o', 'd', 'open', ?, ?)`, [NOW, NOW]);
        handlers = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers;
        git(session, 'switch', '-q', 'claude/session');
        for (const b of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/fix/').split('\n')) {
            if (b)
                git(repo, 'branch', '-q', '-D', b);
        }
    });
    it('task_provision adopts the session worktree: branch checked out there, realpath recorded, worktree_adopted 1, no slug worktree', async () => {
        const viaSymlink = join(ws, 'session-link');
        if (!existsSync(viaSymlink))
            symlinkSync(session, viaSymlink);
        const { isError, out } = await provision('fix/prov-adopt', viaSymlink);
        assert.equal(isError, false, JSON.stringify(out));
        assert.equal(out['worktree_path'], session);
        assert.equal(out['worktree_adopted'], true);
        assert.equal(out['diagnostic'], undefined);
        assert.deepEqual(adoptedRow(out['task_id']), { worktree_path: session, worktree_adopted: 1 });
        assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/prov-adopt');
        noSlugWorktree('fix/prov-adopt');
    });
    it('task_retry adopts the session worktree for the new task: branch checked out there, no slug worktree', async () => {
        const id = failedTask('fix/orig');
        const { isError, out } = await retry(id, 'fix/orig-v2', session);
        assert.equal(isError, false, JSON.stringify(out));
        assert.equal(out['worktree_path'], session);
        assert.equal(out['worktree_adopted'], true);
        assert.equal(out['diagnostic'], undefined);
        assert.deepEqual(adoptedRow(out['task_id']), { worktree_path: session, worktree_adopted: 1 });
        assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/orig-v2');
        noSlugWorktree('fix/orig-v2');
    });
    it('task_reopen adopts the session worktree: branch checked out there, fences appended, no slug worktree', async () => {
        const id = closedTask('fix/rework');
        const { isError, out } = await reopen(id, session);
        assert.equal(isError, false, JSON.stringify(out));
        assert.equal(out['status'], 'running');
        assert.equal(out['worktree_path'], session);
        assert.equal(out['worktree_adopted'], true);
        assert.equal(out['worktree_recreated'], false);
        assert.equal(out['diagnostic'], undefined);
        assert.deepEqual(out['files'], ['src/x.ts', 'src/y.ts']);
        assert.deepEqual(adoptedRow(id), { worktree_path: session, worktree_adopted: 1 });
        assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/rework');
        noSlugWorktree('fix/rework');
    });
    const refusals = [
        { name: 'a worktree of another repo', error: 'adopt_worktree_repo_mismatch', setup: () => ({ worktreePath: otherRepo }) },
        { name: 'the main checkout', error: 'adopt_worktree_main_checkout', setup: () => ({ worktreePath: repo }) },
        {
            name: 'a worktree with tracked changes',
            error: 'adopt_worktree_dirty',
            setup: () => {
                writeFileSync(join(session, 'seed.txt'), 'edited\n');
                return { worktreePath: session, cleanup: () => git(session, 'checkout', '--', 'seed.txt') };
            },
        },
        {
            name: 'a worktree a live task holds',
            error: 'worktree_in_use',
            setup: () => {
                db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, worktree_path, worktree_adopted)
           VALUES (50, 2, 'fix/holder', 'd', 'running', ?, ?, 'app', ?, 1)`, [NOW, NOW, session]);
                return { worktreePath: session };
            },
        },
    ];
    for (const c of refusals) {
        it(`task_provision refuses ${c.name} with ${c.error} before the branch is cut: no task row, discussion, audit row or ref`, async () => {
            const { worktreePath, cleanup } = c.setup();
            try {
                const before = state();
                const { isError, out } = await provision('fix/prov-refused', worktreePath);
                assert.equal(isError, true);
                assert.equal(out['error'], c.error);
                assert.ok(typeof out['message'] === 'string' && out['message'].length > 0);
                assert.deepEqual(state(), before);
                assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/heads/fix/prov-refused'));
            }
            finally {
                cleanup?.();
            }
        });
        it(`task_retry refuses ${c.name} with ${c.error} before the branch is cut: no task row, discussion, audit row or ref`, async () => {
            const id = failedTask('fix/retry-src');
            const { worktreePath, cleanup } = c.setup();
            try {
                const before = state();
                const { isError, out } = await retry(id, 'fix/retry-refused', worktreePath);
                assert.equal(isError, true);
                assert.equal(out['error'], c.error);
                assert.ok(typeof out['message'] === 'string' && out['message'].length > 0);
                assert.deepEqual(state(), before);
                assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/heads/fix/retry-refused'));
            }
            finally {
                cleanup?.();
            }
        });
        it(`task_reopen refuses ${c.name} with ${c.error}, leaving the task's status and fences unchanged`, async () => {
            const id = closedTask('fix/reopen-refused');
            const { worktreePath, cleanup } = c.setup();
            try {
                const before = state();
                const { isError, out } = await reopen(id, worktreePath);
                assert.equal(isError, true);
                assert.equal(out['error'], c.error);
                assert.ok(typeof out['message'] === 'string' && out['message'].length > 0);
                assert.deepEqual(state(), before);
                assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', [id])?.status, 'closed');
            }
            finally {
                cleanup?.();
            }
        });
    }
    it('worktree_in_use names the holding task', async () => {
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, worktree_path, worktree_adopted)
       VALUES (51, 2, 'fix/holder', 'd', 'pending', ?, ?, 'app', ?, 1)`, [NOW, NOW, session]);
        const { out } = await provision('fix/second', session);
        assert.equal(out['error'], 'worktree_in_use');
        assert.equal(out['task_id'], 51);
        assert.match(out['message'], /task 51/);
    });
    it('a relative adopt_worktree is refused as a typed argument error', async () => {
        const before = state();
        const { isError, out } = await provision('fix/relative', 'session-wt');
        assert.equal(isError, true);
        assert.match(JSON.stringify(out), /adopt_worktree must be an absolute path/);
        assert.deepEqual(state(), before);
    });
});
//# sourceMappingURL=worktree-adopt.test.js.map