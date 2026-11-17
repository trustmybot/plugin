/**
 * An issue closes once its task commits reach the target branch (GH 3234,
 * decision #245). Each fixture is a real git repo: a local-only one, where a
 * `git merge` into the local target closes the issue, and one with an origin,
 * where a merge-queue merge (the task commit an ancestor of origin/<target>)
 * and a web-UI squash (patch-equivalent only) close it once the checkpoint's
 * fetch brings them in. Live or unreviewed tasks hold the issue open; the
 * remote close follows only when sync is on.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUDIT_EVENT_TYPES } from '../audit-events.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { closeIssuesReachedTarget } from '../issue-merge-close.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';
import { compositeTools } from '../tools/composites.js';
import { worldModelTools } from '../tools/world_model.js';
import { catchUpRepos, reindexIdle, reindexOnRefMove } from '../world-model/freshness.js';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';

type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  await reindexIdle();
});

const GIT_TIMEOUT_MS = 30_000;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS })
    .toString()
    .trim();
}

interface Fx {
  base: string;
  root: string;
  origin: string | null;
  dbPath: string;
  db: TrajectoryDB;
  // A commit on a new branch cut from main; main stays checked out.
  taskCommit: (branch: string, file: string) => string;
  cleanup: () => void;
}

function fixture(opts: { origin: boolean }): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'issue-target-reach-')));
  const root = join(base, 'app');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  let origin: string | null = null;
  if (opts.origin) {
    origin = join(base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: GIT_TIMEOUT_MS });
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-q', '-u', 'origin', 'main');
  }
  const dbPath = join(base, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [root]);
  return {
    base,
    root,
    origin,
    dbPath,
    db,
    taskCommit: (branch, file) => {
      git(root, 'checkout', '-q', '-b', branch, 'main');
      writeFileSync(join(root, file), `export const ${file.replace(/\W/g, '_')} = 2;\n`);
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', `task ${branch}`);
      const sha = git(root, 'rev-parse', 'HEAD');
      git(root, 'checkout', '-q', 'main');
      return sha;
    },
    cleanup: () => {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedIssue(db: TrajectoryDB, ghIid: number | null = null): number {
  db.run(
    `INSERT INTO issues (objective, status, created_at, updated_at, repo, gh_iid) VALUES ('reach', 'open', datetime('now'), datetime('now'), 'app', ?)`,
    [ghIid],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

// Each task of an issue gets its own branch_id (one task per issue and branch).
function seedTask(db: TrajectoryDB, issueId: number, status: string, commitSha: string | null): number {
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, commit_sha, repo, created_at, updated_at)
     VALUES (?, 'fix/reach-' || (SELECT COUNT(*) FROM tasks), 'd', ?, ?, 'app', datetime('now'), datetime('now'))`,
    [issueId, status, commitSha],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

// A bro waiver for the task's commit: the task counts as reviewed.
function review(db: TrajectoryDB, issueId: number, taskId: number, commitSha: string): void {
  db.run(
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
     VALUES (?, 'bro', 'review_gate_waived', 'waived', ?, datetime('now'))`,
    [issueId, JSON.stringify({ task_id: taskId, commit_sha: commitSha })],
  );
}

function closeTask(db: TrajectoryDB, taskId: number, commitSha: string): void {
  db.run(`UPDATE tasks SET status = 'closed', commit_sha = ? WHERE id = ?`, [commitSha, taskId]);
}

const issueStatus = (db: TrajectoryDB, issueId: number): string =>
  db.get<{ status: string }>('SELECT status FROM issues WHERE id = ?', [issueId])!.status;
const auditCount = (db: TrajectoryDB, issueId: number, eventType: string): number =>
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit WHERE issue_id = ? AND event_type = ?', [issueId, eventType])!.n;
const reachRows = (db: TrajectoryDB, issueId: number): number => auditCount(db, issueId, 'issue_closed_on_target_reach');

describe('local-only repo: a git merge into the local target closes the issue', () => {
  it('stays open before the merge and closes at the next checkpoint after it, once', async () => {
    const fx = fixture({ origin: false });
    try {
      const sha = fx.taskCommit('fix/reach', 'b.ts');
      const issueId = seedIssue(fx.db);
      const taskId = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, taskId, sha);

      await reindexOnRefMove(fx.db, new WorldModelGraph(fx.db), 'app', { dbPath: fx.dbPath });
      assert.equal(issueStatus(fx.db, issueId), 'open');
      assert.equal(reachRows(fx.db, issueId), 0);

      git(fx.root, 'merge', '-q', '--no-ff', '-m', 'merge fix/reach', 'fix/reach');
      await reindexOnRefMove(fx.db, new WorldModelGraph(fx.db), 'app', { dbPath: fx.dbPath });
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(reachRows(fx.db, issueId), 1);
      const row = fx.db.get<{ from_node: string; content_json: string }>(
        `SELECT from_node, content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_closed_on_target_reach'`,
        [issueId],
      )!;
      assert.equal(row.from_node, 'trajectory-server');
      assert.deepEqual(JSON.parse(row.content_json), { target_ref: 'refs/heads/main', task_ids: [taskId], commit_shas: [sha] });

      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath }), []);
      assert.equal(reachRows(fx.db, issueId), 1, 'an already-closed issue is not closed again');
    } finally {
      fx.cleanup();
    }
  });

  it('a world-model read closes it for bro, never for swe or code-reviewer', async () => {
    const fx = fixture({ origin: false });
    try {
      const sha = fx.taskCommit('fix/reach', 'b.ts');
      const issueId = seedIssue(fx.db);
      const taskId = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, taskId, sha);
      git(fx.root, 'merge', '-q', '--ff-only', 'fix/reach');
      const handlers = worldModelTools(fx.db, GraphHolder.fixed(new WorldModelGraph(fx.db)), fx.root).handlers as Handlers;

      for (const agent of ['swe', 'code-reviewer']) {
        const r = (await handlers['world_model_get']({ agent, repo: 'app', depth: 1 })) as Raw;
        assert.ok(!r.isError, r.content[0]?.text);
        assert.equal(issueStatus(fx.db, issueId), 'open', `${agent} read`);
      }
      const r = (await handlers['world_model_get']({ agent: 'bro', repo: 'app', depth: 1 })) as Raw;
      assert.ok(!r.isError, r.content[0]?.text);
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(reachRows(fx.db, issueId), 1);
    } finally {
      fx.cleanup();
    }
  });
});

describe('remote repo: the checkpoint fetch brings the merge in', () => {
  it('a merge-queue merge (task commit an ancestor of origin/main) closes it after the fetch', async () => {
    const fx = fixture({ origin: true });
    try {
      const sha = fx.taskCommit('fix/reach', 'b.ts');
      const issueId = seedIssue(fx.db);
      const taskId = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, taskId, sha);

      git(fx.root, 'merge', '-q', '--ff-only', 'fix/reach');
      await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath });
      assert.equal(issueStatus(fx.db, issueId), 'open', 'a local merge not on origin/main is not a merge');

      // The forge moves main on the remote only; the local tracking ref is stale.
      const clone = join(fx.base, 'queue');
      execFileSync('git', ['clone', '-q', fx.origin!, clone], { timeout: GIT_TIMEOUT_MS });
      git(clone, 'fetch', '-q', fx.root, 'fix/reach');
      git(clone, 'merge', '-q', '--no-ff', '-m', 'merge queue', 'FETCH_HEAD');
      git(clone, 'push', '-q', 'origin', 'main');
      await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath });
      assert.equal(issueStatus(fx.db, issueId), 'open', 'origin/main not fetched yet');

      await reindexOnRefMove(fx.db, new WorldModelGraph(fx.db), 'app', { dbPath: fx.dbPath, fetch: true });
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(reachRows(fx.db, issueId), 1);
    } finally {
      fx.cleanup();
    }
  });

  it('a web-UI squash merge (patch-equivalent, not an ancestor) closes it at the catch-up fetch', async () => {
    const fx = fixture({ origin: true });
    try {
      const first = fx.taskCommit('fix/reach', 'b.ts');
      git(fx.root, 'checkout', '-q', 'fix/reach');
      writeFileSync(join(fx.root, 'c.ts'), 'export const c = 3;\n');
      git(fx.root, 'add', '-A');
      git(fx.root, 'commit', '-qm', 'second task');
      const second = git(fx.root, 'rev-parse', 'HEAD');
      git(fx.root, 'checkout', '-q', 'main');
      git(fx.root, 'push', '-q', 'origin', 'fix/reach');
      const issueId = seedIssue(fx.db);
      const t1 = seedTask(fx.db, issueId, 'closed', first);
      const t2 = seedTask(fx.db, issueId, 'closed', second);
      review(fx.db, issueId, t1, first);
      review(fx.db, issueId, t2, second);

      const web = join(fx.base, 'web');
      execFileSync('git', ['clone', '-q', fx.origin!, web], { timeout: GIT_TIMEOUT_MS });
      writeFileSync(join(web, 'z.ts'), 'export const z = 9;\n');
      git(web, 'add', '-A');
      git(web, 'commit', '-qm', 'unrelated');
      git(web, 'fetch', '-q', 'origin', 'fix/reach');
      git(web, 'merge', '-q', '--squash', 'FETCH_HEAD');
      git(web, 'commit', '-qm', 'squash fix/reach');
      git(web, 'push', '-q', 'origin', 'main');

      await catchUpRepos(fx.db, new WorldModelGraph(fx.db), { dbPath: fx.dbPath, trigger: 'startup_catchup' });
      assert.throws(() => git(fx.root, 'merge-base', '--is-ancestor', second, 'origin/main'), 'the squash leaves the task commit off origin/main');
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(reachRows(fx.db, issueId), 1);
    } finally {
      fx.cleanup();
    }
  });
});

describe('rework after an exit-5 integrate holds the issue open until the reworked commit lands', () => {
  it('a live retry, then an unreviewed close, keep it open though the old commit is in the target', async () => {
    const fx = fixture({ origin: false });
    try {
      const old = fx.taskCommit('fix/old', 'b.ts');
      git(fx.root, 'merge', '-q', '--ff-only', 'fix/old');
      const issueId = seedIssue(fx.db);
      const oldTask = seedTask(fx.db, issueId, 'closed', old);
      review(fx.db, issueId, oldTask, old);
      // An escalated attempt with an unmerged commit is ignored.
      const abandoned = fx.taskCommit('fix/abandoned', 'x.ts');
      seedTask(fx.db, issueId, 'escalated', abandoned);
      const retry = seedTask(fx.db, issueId, 'running', null);

      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath }), []);
      assert.equal(issueStatus(fx.db, issueId), 'open', 'a live task holds it open');

      const reworked = fx.taskCommit('fix/rework', 'c.ts');
      closeTask(fx.db, retry, reworked);
      git(fx.root, 'merge', '-q', '--no-ff', '-m', 'merge rework', 'fix/rework');
      await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath });
      assert.equal(issueStatus(fx.db, issueId), 'open', 'a closed task without review holds it open');

      review(fx.db, issueId, retry, reworked);
      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath }), [issueId]);
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(reachRows(fx.db, issueId), 1);
    } finally {
      fx.cleanup();
    }
  });

  it('a reviewed rework commit not yet in the target keeps it open', async () => {
    const fx = fixture({ origin: false });
    try {
      const old = fx.taskCommit('fix/old', 'b.ts');
      git(fx.root, 'merge', '-q', '--ff-only', 'fix/old');
      const issueId = seedIssue(fx.db);
      const oldTask = seedTask(fx.db, issueId, 'closed', old);
      review(fx.db, issueId, oldTask, old);
      const reworked = fx.taskCommit('fix/rework', 'c.ts');
      const retry = seedTask(fx.db, issueId, 'closed', reworked);
      review(fx.db, issueId, retry, reworked);

      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath }), []);
      assert.equal(issueStatus(fx.db, issueId), 'open');
      git(fx.root, 'merge', '-q', '--no-ff', '-m', 'merge rework', 'fix/rework');
      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath }), [issueId]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('task_provision under an issue whose earlier tasks all merged (F69-1)', () => {
  it('leaves the issue open with the new pending task, reopening what its own checkpoint closed', async () => {
    const fx = fixture({ origin: false });
    try {
      const sha = fx.taskCommit('fix/first', 'b.ts');
      git(fx.root, 'merge', '-q', '--ff-only', 'fix/first');
      const issueId = seedIssue(fx.db);
      const firstTask = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, firstTask, sha);

      const r = (await compositeTools(fx.db, fx.dbPath).handlers['task_provision']({
        agent: 'bro',
        issue_id: issueId,
        branch_id: 'fix/follow-up',
        decision_body: 'Chosen approach: a follow-up task on the merged issue.',
        task: {
          description: 'd',
          spec_body: ['## Description', 'follow up', '', '## Success Criteria', '- SC1: works'].join('\n'),
          files: ['a.ts'],
          verification: ['true'],
          repo: 'app',
        },
      })) as Raw;
      assert.ok(!r.isError, r.content[0]?.text);
      const out = JSON.parse(r.content[0].text) as Record<string, unknown>;

      assert.equal(reachRows(fx.db, issueId), 1, 'the provision checkpoint closed the merged issue');
      assert.equal(out['issue_reopened'], true);
      assert.equal(issueStatus(fx.db, issueId), 'open');
      assert.equal(fx.db.get<{ closed_at: string | null }>('SELECT closed_at FROM issues WHERE id = ?', [issueId])!.closed_at, null);
      const task = fx.db.get<{ issue_id: number; status: string }>('SELECT issue_id, status FROM tasks WHERE id = ?', [Number(out['task_id'])])!;
      assert.deepEqual({ ...task }, { issue_id: issueId, status: 'pending' });
      const reopened = fx.db.get<{ from_node: string; content_json: string }>(
        `SELECT from_node, content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_reopened'`,
        [issueId],
      )!;
      assert.equal(reopened.from_node, 'bro');
      assert.equal((JSON.parse(reopened.content_json) as { cause: string }).cause, 'task_provision');

      const again = await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath });
      assert.deepEqual(again, [], 'the live task holds the reopened issue open');
    } finally {
      fx.cleanup();
    }
  });

  it('on an issue with unmerged work it stays open and reports no reopen', async () => {
    const fx = fixture({ origin: false });
    try {
      const sha = fx.taskCommit('fix/first', 'b.ts');
      const issueId = seedIssue(fx.db);
      const firstTask = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, firstTask, sha);

      const r = (await compositeTools(fx.db, fx.dbPath).handlers['task_provision']({
        agent: 'bro',
        issue_id: issueId,
        branch_id: 'fix/follow-up',
        decision_body: 'Chosen approach: a follow-up task.',
        task: {
          description: 'd',
          spec_body: ['## Description', 'follow up', '', '## Success Criteria', '- SC1: works'].join('\n'),
          files: ['a.ts'],
          verification: ['true'],
          repo: 'app',
        },
      })) as Raw;
      assert.ok(!r.isError, r.content[0]?.text);
      const out = JSON.parse(r.content[0].text) as Record<string, unknown>;
      assert.equal(out['issue_reopened'], undefined);
      assert.equal(issueStatus(fx.db, issueId), 'open');
      assert.equal(auditCount(fx.db, issueId, 'issue_reopened'), 0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the remote close follows only when sync is on', () => {
  it('with sync off the issue closes locally, issue_close_remote_skipped is written and nothing is spawned', async () => {
    const fx = fixture({ origin: false });
    try {
      upsertRepoRemotes(fx.db, 'app', [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
      setRemoteSync(fx.db, 'app', ['github']);
      const sha = fx.taskCommit('fix/reach', 'b.ts');
      git(fx.root, 'merge', '-q', '--ff-only', 'fix/reach');
      const issueId = seedIssue(fx.db, 42);
      const taskId = seedTask(fx.db, issueId, 'closed', sha);
      review(fx.db, issueId, taskId, sha);
      const spawned: string[][] = [];
      const spawnFn = (cmd: string, args: string[]) => {
        spawned.push([cmd, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      };

      assert.deepEqual(await closeIssuesReachedTarget(fx.db, 'app', { dbPath: fx.dbPath, spawnFn }), [issueId]);
      assert.equal(issueStatus(fx.db, issueId), 'closed');
      assert.equal(auditCount(fx.db, issueId, 'issue_close_remote_skipped'), 1);
      assert.deepEqual(spawned, []);
    } finally {
      fx.cleanup();
    }
  });
});

describe('issue_closed_on_target_reach registration', () => {
  it('is a server-written audit event', () => {
    const def = AUDIT_EVENT_TYPES.find((e) => e.type === 'issue_closed_on_target_reach');
    assert.ok(def);
    assert.deepEqual([...def.writers], ['server']);
  });
});
