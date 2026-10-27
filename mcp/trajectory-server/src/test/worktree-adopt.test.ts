/**
 * adoptTaskWorktree (GH 2032): records a linked session worktree as a task's
 * worktree after four checks, each refusal writing nothing, and stays refused
 * behind ADOPT_WORKTREE_ENABLED until the enabling PR flips it. Tests reach it
 * through the `{ enabled: true }` options seam.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { ADOPT_WORKTREE_ENABLED, adoptTaskWorktree, taskWorktreePath } from '../tools/composites.js';
import { tempDB } from './helpers.js';

const NOW = '2026-10-27T10:00:00.000Z';
const ENABLED = { enabled: true } as const;

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function initRepo(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
}

describe('adoptTaskWorktree (GH 2032)', () => {
  let ws: string;
  let repo: string;
  let otherRepo: string;
  let session: string;
  let db: TrajectoryDB;

  const seedTask = (id: number, branch: string, status = 'running'): void => {
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
       VALUES (?, 2, ?, 'd', ?, ?, ?, 'app')`,
      [id, branch, status, NOW, NOW],
    );
    git(repo, 'branch', branch);
  };

  const state = (): unknown => ({
    tasks: db.all('SELECT * FROM tasks ORDER BY id').map((r) => ({ ...(r as object) })),
    discussions: db.get<{ n: number }>('SELECT count(*) AS n FROM discussions')?.n,
    audit: db.get<{ n: number }>('SELECT count(*) AS n FROM audit')?.n,
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
      if (b) git(repo, 'branch', '-q', '-D', b);
    }
  });

  it('is refused by default: adopt_worktree_unavailable, naming GH 2032, and nothing written', () => {
    assert.equal(ADOPT_WORKTREE_ENABLED, false);
    seedTask(7, 'fix/off');
    const before = state();
    const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, 'adopt_worktree_unavailable');
    assert.match(!r.ok ? r.message : '', /GH 2032/);
    assert.match(!r.ok ? r.message : '', /ensure-swe-worktree/);
    assert.deepEqual(state(), before);
  });

  it('records realpath(W) and worktree_adopted=1, checks the task branch out in W, and creates no slug worktree', () => {
    seedTask(7, 'fix/adopt-a');
    const viaSymlink = join(ws, 'session-link');
    if (!existsSync(viaSymlink)) symlinkSync(session, viaSymlink);
    const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: viaSymlink }, ENABLED);
    assert.deepEqual(r, { ok: true, task_id: 7, branch_id: 'fix/adopt-a', worktree_path: session, git_setup: 'switched' });
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT worktree_path, worktree_adopted FROM tasks WHERE id = 7') },
      { worktree_path: session, worktree_adopted: 1 },
    );
    assert.equal(git(session, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/adopt-a');
    assert.equal(existsSync(taskWorktreePath(repo, 'fix/adopt-a')), false);
    assert.equal(existsSync(join(repo, '.claude')), false);
  });

  it('keeps the record and reports git_setup error with a diagnostic when git switch fails', () => {
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
       VALUES (7, 2, 'fix/no-such-branch', 'd', 'running', ?, ?, 'app')`,
      [NOW, NOW],
    );
    const r = adoptTaskWorktree(db, { taskId: 7, repoPath: repo, worktreePath: session }, ENABLED);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.git_setup, 'error');
    assert.ok(r.ok && typeof r.diagnostic === 'string' && r.diagnostic.length > 0);
    assert.equal(db.get<{ worktree_path: string }>('SELECT worktree_path FROM tasks WHERE id = 7')?.worktree_path, session);
  });

  const refusals: Array<{ name: string; error: string; setup: () => { worktreePath: string; cleanup?: () => void } }> = [
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
      } finally {
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
    } finally {
      rmSync(join(session, 'scratch.txt'));
    }
  });

  it('refuses an unknown task with adopt_worktree_task_not_found', () => {
    const before = state();
    const r = adoptTaskWorktree(db, { taskId: 99, repoPath: repo, worktreePath: session }, ENABLED);
    assert.equal(!r.ok && r.error, 'adopt_worktree_task_not_found');
    assert.deepEqual(state(), before);
  });

  for (const holding of ['pending', 'running', 'needs_validation'] as const) {
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
      assert.deepEqual(
        { ...db.get<Record<string, unknown>>('SELECT worktree_path, worktree_adopted FROM tasks WHERE id = 8') },
        { worktree_path: session, worktree_adopted: 1 },
      );
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
        assert.equal(db.get<{ worktree_path: string | null }>('SELECT worktree_path FROM tasks WHERE id = 8')?.worktree_path, null);
        assert.equal(git(slug, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
        assert.equal(git(slug, 'rev-parse', 'HEAD'), slugHead);
      } finally {
        git(repo, 'worktree', 'remove', '--force', slug);
      }
    });
  }
});
