/**
 * The swe-atomic-close l3 bash suite in node:test (GH 1692), part 2: one fresh
 * repo per case. The gate runs as `node dist/hooks.js swe-atomic-close` from
 * that repo, CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set. Covers the
 * no-worktree checkout, transcript binding over parallel tasks and cwd slugs,
 * an injected task id, the nested repo-rooted worktree (#169), the empty
 * parent_branch_id base (#18) and commits counted by ancestry against the
 * local and origin parent tips (GH 1511).
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { git, has, sql } from './git-push-guard-l3.js';
import { commitIn, execDb, hook, initRepo, newMinDb, NO_COMMITS, q, recordRun, skippedCount, spawnInput } from './swe-atomic-close-l3.js';

describe('swe-atomic-close l3: one repo per case', () => {
  let sb: Sandbox;

  before(() => {
    sb = makeSandbox('swe-atomic-close-repos');
  });
  after(() => sb.remove());

  /** A repo under the sandbox on dev with a `base` commit and its min-schema DB. */
  function repoWithDb(name: string): { repo: string; db: string } {
    const repo = join(sb.dir, name);
    initRepo(sb.env, repo);
    return { repo, db: newMinDb(repo) };
  }

  function addWorktree(repo: string, branch: string, slug: string): string {
    const wt = join(repo, '.claude/worktrees', slug);
    git(sb.env, repo, 'branch', branch, 'HEAD');
    git(sb.env, repo, 'worktree', 'add', '-q', wt, branch);
    return wt;
  }

  const status = (db: string, task: number) => q(db, 'SELECT status FROM tasks WHERE id=?', task);
  const sha = (db: string, task: number) => q(db, 'SELECT commit_sha FROM tasks WHERE id=?', task);

  it('no-worktree: REPO_ROOT on task branch + commits ahead → auto-completed', () => {
    const { repo, db } = repoWithDb('nw-repo');
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (100, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));");
    git(sb.env, repo, 'checkout', '-q', '-b', 'feat/test-branch');
    writeFileSync(join(repo, 'work.txt'), 'swe work\n');
    git(sb.env, repo, 'add', '.');
    git(sb.env, repo, 'commit', '-qm', 'feat: swe work');
    const head = git(sb.env, repo, 'rev-parse', 'HEAD');
    recordRun(db, 100, head);
    assert.equal(hook(sb, repo, db, spawnInput(sb.dir, 100, 'tmb:swe')), '', 'no additionalContext on auto-close');
    assert.equal(status(db, 100), 'completed', 'task auto-closed');
    assert.equal(sha(db, 100), head, 'commit_sha written from REPO_ROOT HEAD');
  });

  it('no-worktree: REPO_ROOT on wrong branch → warn-no-commits, task stays pending', () => {
    const { repo, db } = repoWithDb('nw2-repo');
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (101, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));");
    writeFileSync(join(repo, 'devwork.txt'), 'dev work\n');
    git(sb.env, repo, 'add', '.');
    git(sb.env, repo, 'commit', '-qm', 'chore: dev commit');
    has(hook(sb, repo, db, spawnInput(sb.dir, 101, 'tmb:swe')), NO_COMMITS, 'warn body present');
    assert.equal(status(db, 101), 'pending', 'task stays pending');
  });

  it('no-worktree: REPO_ROOT on task branch but no commits ahead → warn-no-commits, task stays pending', () => {
    const { repo, db } = repoWithDb('nw3-repo');
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (102, 'feat/test-branch', 'dev', 'pending', datetime('now', '+1 second'));");
    git(sb.env, repo, 'checkout', '-q', '-b', 'feat/test-branch');
    has(hook(sb, repo, db, spawnInput(sb.dir, 102, 'tmb:swe')), NO_COMMITS, 'warn body present');
    assert.equal(status(db, 102), 'pending', 'task stays pending');
  });

  describe('#202/#369: transcript task_id extraction targets the correct task', () => {
    let repo: string;
    let db: string;
    let headA = '';
    before(() => {
      ({ repo, db } = repoWithDb('parallel-repo'));
      execDb(
        db,
        `INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (200, 'fix/swe-a-task', 'dev', 'pending', datetime('now', '+1 second'));
         INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (201, 'fix/swe-b-task', 'dev', 'pending', datetime('now', '+99 seconds'));`,
      );
      const wtA = addWorktree(repo, 'fix/swe-a-task', 'swe-a-task');
      addWorktree(repo, 'fix/swe-b-task', 'swe-b-task');
      writeFileSync(join(wtA, 'swe-a.txt'), 'swe-a work\n');
      git(sb.env, wtA, 'add', 'swe-a.txt');
      git(sb.env, wtA, 'commit', '-qm', 'feat: swe-a work');
      headA = git(sb.env, wtA, 'rev-parse', 'HEAD');
      recordRun(db, 200, headA);
    });

    it('#202/#369: transcript task_id extraction: auto-completes SWE-A task (200), not most-recent (201)', () => {
      const tp = join(sb.dir, 'par-transcript.jsonl');
      writeFileSync(
        tp,
        '{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=200 worktree=/tmp/swe-a You are SWE. Implement fix for task 200."}]}}\n' +
          '{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[]}}\n',
      );
      assert.equal(hook(sb, repo, db, { agent_type: 'tmb:swe', hook_event_name: 'SubagentStop', agent_transcript_path: tp }), '', 'no additionalContext on auto-close');
      assert.equal(status(db, 200), 'completed', 'task 200 (SWE-A) auto-closed via transcript extraction');
      assert.equal(sha(db, 200), headA, 'commit_sha from SWE-A worktree written to task 200');
    });

    it('#202/#369: task 201 (SWE-B) NOT touched by SWE-A SubagentStop', () => {
      assert.equal(status(db, 201), 'pending', 'task 201 (SWE-B) stays pending — not auto-closed');
    });
  });

  describe('injection in transcript task_id treated as missing (no SQL error)', () => {
    let db: string;
    before(() => {
      let repo: string;
      ({ repo, db } = repoWithDb('inj-repo'));
      execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (300, 'fix/inj-branch', 'dev', 'pending', datetime('now', '+99 seconds'));");
      const tp = join(sb.dir, 'inj-transcript.jsonl');
      writeFileSync(
        tp,
        '{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=1; DROP TABLE tasks;-- You are SWE."}]}}\n' +
          '{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":10,"output_tokens":5},"content":[]}}\n',
      );
      hook(sb, repo, db, { agent_type: 'tmb:swe', hook_event_name: 'SubagentStop', agent_transcript_path: tp });
    });

    it('injection in transcript task_id: tasks table not dropped', () => {
      assert.equal(q(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tasks'"), '1', 'tasks table must survive injection attempt');
    });

    it('injection in transcript task_id: binds task 1 (no row) → capture skipped, task 300 untouched', () => {
      assert.equal(status(db, 300), 'pending', 'no fallback to the most recently updated task');
      assert.equal(skippedCount(db), '1', 'capture-skipped audit row');
      assert.equal(q(db, 'SELECT COUNT(*) FROM agent_runs'), '0', 'no agent_runs row');
    });
  });

  it('no transcript + matching worktree cwd → task 500 stays pending, capture skipped', () => {
    const { repo, db } = repoWithDb('slug-repo');
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (500, 'fix/slug-task', 'dev', 'pending', datetime('now', '+1 second'));");
    const wt = addWorktree(repo, 'fix/slug-task', 'slug-task');
    commitIn(sb.env, wt, 'slug-work.txt', 'feat: slug work');
    assert.equal(hook(sb, repo, db, { agent_type: 'tmb:swe', hook_event_name: 'SubagentStop', cwd: wt }), '', 'no additionalContext');
    assert.equal(status(db, 500), 'pending', 'task 500 not resolved from the cwd slug');
    assert.equal(q(db, "SELECT COALESCE(commit_sha, '') FROM tasks WHERE id=500"), '', 'no commit_sha written');
    assert.equal(skippedCount(db), '1', 'capture-skipped audit row');
  });

  describe('transcript task_id binds even when cwd names another worktree', () => {
    let repo: string;
    let db: string;
    let wt: string;
    let head = '';
    before(() => {
      ({ repo, db } = repoWithDb('txfirst-repo'));
      execDb(
        db,
        `INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (600, 'fix/tx-task', 'dev', 'pending', datetime('now', '+1 second'));
         INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (601, 'fix/slug-other-task', 'dev', 'pending', datetime('now', '+2 seconds'));`,
      );
      wt = join(repo, '.claude/worktrees/tx-task');
      git(sb.env, repo, 'branch', 'fix/tx-task', 'HEAD');
      git(sb.env, repo, 'branch', 'fix/slug-other-task', 'HEAD');
      git(sb.env, repo, 'worktree', 'add', '-q', wt, 'fix/tx-task');
      head = commitIn(sb.env, wt, 'tx-work.txt', 'feat: tx work');
      recordRun(db, 600, head);
    });

    it('transcript binds task 600 (auto-completed) despite a cwd naming task 601', () => {
      const tp = join(sb.dir, 'txfirst-transcript.jsonl');
      writeFileSync(
        tp,
        `{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=600 worktree=${wt} You are SWE."}]}}\n` +
          '{"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[]}}\n',
      );
      const payload = { agent_type: 'tmb:swe', hook_event_name: 'SubagentStop', agent_transcript_path: tp, cwd: join(repo, '.claude/worktrees/slug-other-task') };
      assert.equal(hook(sb, repo, db, payload), '', 'no additionalContext on auto-close');
      assert.equal(status(db, 600), 'completed', 'task 600 auto-closed via transcript');
      assert.equal(sha(db, 600), head, 'commit_sha from task 600 worktree HEAD');
    });

    it('task 601 NOT touched by the cwd', () => {
      assert.equal(status(db, 601), 'pending', 'task 601 untouched when transcript resolves task 600');
    });
  });

  describe('nested-repo: worktree repo-rooted under <ws>/plugin → auto-completed (#169)', () => {
    let ws: string;
    let inner: string;
    let wsDb: string;
    let head = '';
    before(() => {
      ws = join(sb.dir, 'nested-ws');
      inner = join(ws, 'plugin');
      wsDb = join(ws, '.claude/tmb/trajectory.db');
      initRepo(sb.env, inner);
      const innerRoot = git(sb.env, inner, 'rev-parse', '--show-toplevel');
      newMinDb(ws);
      sql(wsDb, "INSERT INTO repos (name, path) VALUES ('plugin', ?)", innerRoot);
      execDb(wsDb, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, repo, updated_at) VALUES (700, 'fix/ws-task', 'dev', 'pending', 'plugin', datetime('now', '+1 second'));");
      const wt = addWorktree(inner, 'fix/ws-task', 'ws-task');
      head = commitIn(sb.env, wt, 'ws-work.txt', 'feat: ws work');
      recordRun(wsDb, 700, head);
    });

    it('nested-repo: repo-rooted worktree under <ws>/plugin → no workspace-rooted path exists', () => {
      const wrong = join(ws, '.claude/worktrees/ws-task');
      assert.ok(!existsSync(wrong), `workspace-rooted path unexpectedly exists: ${wrong}`);
    });

    it('nested-repo: repo-rooted worktree → pending task auto-completed (#169 repo-rooted resolver)', () => {
      assert.equal(hook(sb, inner, wsDb, spawnInput(sb.dir, 700, 'tmb:swe')), '', 'no additionalContext on auto-close');
      assert.equal(status(wsDb, 700), 'completed', 'task 700 auto-closed via repo-rooted worktree path');
      assert.equal(sha(wsDb, 700), head, 'commit_sha written from repo-rooted worktree HEAD');
    });
  });

  it('empty parent_branch_id + attached-worktree commit → auto-completed (#18)', () => {
    const { repo, db } = repoWithDb('empty-parent-repo');
    const root = git(sb.env, repo, 'rev-parse', '--show-toplevel');
    sql(db, "INSERT INTO repos (name, path, target_branch) VALUES ('empty-parent-repo', ?, 'dev')", root);
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, repo, updated_at) VALUES (800, 'fix/ep-task', NULL, 'pending', 'empty-parent-repo', datetime('now', '+1 second'));");
    const head = commitIn(sb.env, addWorktree(repo, 'fix/ep-task', 'ep-task'), 'ep-work.txt', 'feat: ep work');
    recordRun(db, 800, head);
    assert.equal(hook(sb, repo, db, spawnInput(sb.dir, 800, 'tmb:swe')), '', 'no additionalContext on auto-close');
    assert.equal(status(db, 800), 'completed', 'task 800 auto-closed despite empty parent_branch_id');
    assert.equal(sha(db, 800), head, 'commit_sha written from attached-worktree HEAD');
  });

  it('empty parent_branch_id + no commit ahead → warn-no-commits, task stays pending', () => {
    const { repo, db } = repoWithDb('empty-parent-nocommit-repo');
    const root = git(sb.env, repo, 'rev-parse', '--show-toplevel');
    sql(db, "INSERT INTO repos (name, path, target_branch) VALUES ('empty-parent-nocommit-repo', ?, 'dev')", root);
    execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status, repo, updated_at) VALUES (801, 'fix/ep2-task', NULL, 'pending', 'empty-parent-nocommit-repo', datetime('now', '+1 second'));");
    addWorktree(repo, 'fix/ep2-task', 'ep2-task');
    has(hook(sb, repo, db, spawnInput(sb.dir, 801, 'tmb:swe')), NO_COMMITS, 'warn body present');
    assert.equal(status(db, 801), 'pending', 'task 801 stays pending (no false-positive auto-close)');
  });

  describe('GH 1511: commits counted by ancestry against the local and origin parent tips', () => {
    /** A repo on dev with a bare origin, dev pushed, and its min-schema DB. */
    function ancRepo(name: string): { repo: string; db: string } {
      const remote = join(sb.dir, `${name}-remote.git`);
      git(sb.env, sb.dir, 'init', '-q', '--bare', remote);
      const r = repoWithDb(name);
      git(sb.env, r.repo, 'remote', 'add', 'origin', remote);
      git(sb.env, r.repo, 'push', '-q', 'origin', 'dev');
      return r;
    }

    function ancCommits(repo: string, n: number): void {
      for (let i = 1; i <= n; i += 1) commitIn(sb.env, repo, `dev-${i}.txt`, `dev ${i}`);
    }

    const autoCompletedRows = (db: string, task: number) =>
      q(db, "SELECT COUNT(*) FROM audit WHERE event_type='swe_atomic_close_auto_completed' AND json_extract(content_json, '$.task_id')=?", task);

    describe('local parent 3 behind origin, worktree from origin/<parent>', () => {
      let repo: string;
      let db: string;
      let wt: string;
      let localTip = '';
      let originTip = '';
      before(() => {
        ({ repo, db } = ancRepo('stale-parent-repo'));
        ancCommits(repo, 3);
        git(sb.env, repo, 'push', '-q', 'origin', 'dev');
        git(sb.env, repo, 'reset', '-q', '--hard', 'HEAD~3');
        localTip = git(sb.env, repo, 'rev-parse', 'refs/heads/dev');
        originTip = git(sb.env, repo, 'rev-parse', 'refs/remotes/origin/dev');
        execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status) VALUES (900, 'fix/stale-task', 'dev', 'running');");
        wt = join(repo, '.claude/worktrees/stale-task');
        git(sb.env, repo, 'branch', '-q', '--no-track', 'fix/stale-task', 'origin/dev');
        git(sb.env, repo, 'worktree', 'add', '-q', wt, 'fix/stale-task');
      });

      it('GH 1511 (a): fixture — local dev is 3 commits behind origin/dev', () => {
        assert.equal(git(sb.env, repo, 'rev-list', '--count', `${localTip}..${originTip}`), '3', 'origin/dev 3 ahead of local dev');
        assert.equal(git(sb.env, repo, 'rev-list', '--count', `${originTip}..${localTip}`), '0', 'local dev not ahead');
      });

      it('GH 1511 (a): zero swe commits → warn-no-commits, task stays running, no commit_sha, no audit row', () => {
        has(hook(sb, repo, db, spawnInput(sb.dir, 900, 'tmb:swe')), NO_COMMITS, 'bro warning emitted');
        assert.equal(status(db, 900), 'running', 'task not completed');
        assert.equal(q(db, 'SELECT commit_sha IS NULL FROM tasks WHERE id=900'), '1', 'commit_sha stays NULL');
        assert.equal(autoCompletedRows(db, 900), '0', 'no swe_atomic_close_auto_completed row');
      });

      it('GH 1511 (b): one swe commit on the same setup → completed at that commit, one audit row', () => {
        const head = commitIn(sb.env, wt, 'stale-work.txt', 'feat: stale work');
        recordRun(db, 900, head);
        assert.equal(hook(sb, repo, db, spawnInput(sb.dir, 900, 'tmb:swe')), '', 'no additionalContext on auto-close');
        assert.equal(status(db, 900), 'completed', 'task auto-completed');
        assert.equal(sha(db, 900), head, 'commit_sha is the swe commit');
        assert.equal(autoCompletedRows(db, 900), '1', 'one swe_atomic_close_auto_completed row');
        assert.equal(
          q(
            db,
            "SELECT json_extract(content_json, '$.commit_sha') || '|' || json_extract(content_json, '$.parent_tip_local') || '|' || json_extract(content_json, '$.parent_tip_origin') || '|' || from_node || '|' || branch_id || '|' || issue_id FROM audit WHERE event_type='swe_atomic_close_auto_completed'",
          ),
          `${head}|${localTip}|${originTip}|hook:swe-atomic-close|fix/stale-task|1`,
          'content_json carries the commit sha and both parent tips',
        );
      });
    });

    it('GH 1511 (c): local dev ahead of origin/dev + zero swe commits → not completed', () => {
      const { repo, db } = ancRepo('ahead-parent-repo');
      ancCommits(repo, 2);
      execDb(db, "INSERT INTO tasks (id, branch_id, parent_branch_id, status) VALUES (901, 'fix/ahead-task', 'dev', 'running');");
      git(sb.env, repo, 'branch', '-q', '--no-track', 'fix/ahead-task', 'origin/dev');
      git(sb.env, repo, 'worktree', 'add', '-q', join(repo, '.claude/worktrees/ahead-task'), 'fix/ahead-task');
      assert.equal(git(sb.env, repo, 'rev-list', '--count', 'origin/dev..dev'), '2', 'fixture: local dev 2 ahead of origin');
      has(hook(sb, repo, db, spawnInput(sb.dir, 901, 'tmb:swe')), NO_COMMITS, 'bro warning emitted');
      assert.equal(status(db, 901), 'running', 'task not completed');
      assert.equal(q(db, 'SELECT commit_sha IS NULL FROM tasks WHERE id=901'), '1', 'commit_sha stays NULL');
      assert.equal(autoCompletedRows(db, 901), '0', 'no swe_atomic_close_auto_completed row');
    });
  });
});
