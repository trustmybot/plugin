/**
 * The cleanup-worktree-on-task-close l3 bash suite in node:test (GH 1692): the
 * gate runs as `node dist/hooks.js cleanup-worktree-on-task-close` from a temp
 * repo, CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set. A bro close, or a
 * passing review of a closed task's current commit, removes the task's
 * worktree (matched by branch slug) and resets HEAD to the repo's target
 * branch; bro_atomic_close and every unmet condition leave it in place.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';
import { gateEnv, git, has, sql, tryGit } from './git-push-guard-l3.js';

const UPDATE = 'mcp__plugin_tmb_trajectory-server__task_update_status';
const CLEANED = 'cleaned up worktree';

function execDb(path: string, statements: string): void {
  const d = new DatabaseSync(path);
  try {
    d.exec(statements);
  } finally {
    d.close();
  }
}

describe('cleanup-worktree-on-task-close l3', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;

  const input = (tool: string, agent: string, status: string, task: number) => ({ tool_name: tool, tool_input: { agent, status, task_id: task } });
  const close = (task: number) => input(UPDATE, 'bro', 'closed', task);
  const atomicClose = (tool: string, agent: string, task: number) => ({ tool_name: tool, tool_input: { agent, task_id: task } });
  const validation = (verdict: string, task: number) => ({
    tool_name: 'mcp__plugin_tmb_trajectory-server__validation_record',
    tool_input: { agent: 'code-reviewer', task_id: task, attempt_n: 1, verdict, feedback: 'x' },
  });

  /** The gate's stdout + stderr (a `2>&1`) for <payload>, run from <cwd>. */
  function runHook(payload: object, extra: NodeJS.ProcessEnv = {}, cwd = repo): string {
    const r = runGate('cleanup-worktree-on-task-close', { cwd, input: JSON.stringify(payload), env: { ...gateEnv(sb, cwd), TRAJECTORY_DB_PATH: db, ...extra } });
    return r.stdout + r.stderr;
  }

  const wt = (slug: string) => join(repo, '.claude/worktrees', slug);
  const worktreeExists = () => existsSync(wt('foo'));

  function addWorktree(branch: string): void {
    git(sb.env, repo, 'branch', branch, 'HEAD');
    git(sb.env, repo, 'worktree', 'add', '-q', `.claude/worktrees/${branch.slice(branch.indexOf('/') + 1)}`, branch);
  }

  const head = () => git(sb.env, repo, 'rev-parse', '--abbrev-ref', 'HEAD');

  function onScratch(name: string): void {
    git(sb.env, repo, 'branch', '-f', name, 'HEAD');
    git(sb.env, repo, 'checkout', '-q', name);
  }

  before(() => {
    sb = makeSandbox('cleanup-worktree-on-task-close');
    repo = join(sb.dir, 'repo');
    mkdirSync(repo);
    git(sb.env, repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(sb.env, repo, 'add', '.');
    git(sb.env, repo, 'commit', '-qm', 'init');
    db = join(repo, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    execDb(
      db,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT);
       INSERT INTO tasks (id, branch_id, status) VALUES (1, 'fix/foo', 'completed');
       INSERT INTO tasks (id, branch_id, status) VALUES (2, 'fix/bar', 'completed');
       INSERT INTO tasks (id, branch_id, status) VALUES (3, 'fix/second', 'completed');`,
    );
    addWorktree('fix/foo');
    addWorktree('fix/second');
  });
  after(() => sb.remove());

  it('wrong tool name: silent no-op, worktree intact', () => {
    assert.equal(runHook(input('mcp__plugin_tmb_trajectory-server__task_get', 'bro', 'closed', 1)), '', 'silent on wrong tool');
    assert.ok(worktreeExists(), 'worktree gone');
  });

  it('agent != bro: silent no-op, worktree intact', () => {
    assert.equal(runHook(input(UPDATE, 'swe', 'closed', 1)), '', 'silent on non-bro agent');
    assert.ok(worktreeExists(), 'worktree gone');
  });

  it('status != closed: silent no-op, worktree intact', () => {
    assert.equal(runHook(input(UPDATE, 'bro', 'completed', 1)), '', 'silent on non-closed status');
    assert.ok(worktreeExists(), 'worktree gone');
  });

  it('TMB_KEEP_CLOSED_WORKTREES=1 bypass: worktree intact', () => {
    assert.equal(runHook(close(1), { TMB_KEEP_CLOSED_WORKTREES: '1' }), '', 'env bypass silent');
    assert.ok(worktreeExists(), 'worktree gone');
  });

  it('task without worktree: silent no-op', () => {
    runHook(close(2));
    assert.ok(worktreeExists(), 'task 1 worktree gone');
  });

  it('second worktree: removed by slug match', () => {
    assert.ok(existsSync(wt('second')), 'second worktree missing before test');
    has(runHook(close(3)), CLEANED, 'report message for second worktree');
    assert.ok(!existsSync(wt('second')), 'second worktree still present');
  });

  it('bro closes task 1: worktree removed (slug-based path match)', () => {
    has(runHook(close(1)), CLEANED, 'report message');
    assert.ok(!worktreeExists(), 'worktree still present');
  });

  it('RC channel tool name also matches', () => {
    addWorktree('fix/bar');
    runHook(input('mcp__plugin_tmb-rc_trajectory-server__task_update_status', 'bro', 'closed', 2));
    assert.ok(!existsSync(wt('bar')), "rc-channel match didn't fire");
  });

  it('#169 nested-repo shape: workspace DB + tasks.repo=plugin + repo-rooted worktree → worktree removed', () => {
    const workspace = join(sb.dir, 'ws');
    const inner = join(workspace, 'plugin');
    mkdirSync(inner, { recursive: true });
    git(sb.env, inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'README.md'), 'init\n');
    git(sb.env, inner, 'add', '.');
    git(sb.env, inner, 'commit', '-qm', 'init');
    const innerRoot = git(sb.env, inner, 'rev-parse', '--show-toplevel');
    const wsDb = join(workspace, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(wsDb), { recursive: true });
    execDb(
      wsDb,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, repo TEXT, status TEXT);
       INSERT INTO tasks (id, branch_id, repo, status) VALUES (20, 'fix/ws-test', 'plugin', 'completed');
       CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, target_branch TEXT, protected_branches TEXT);`,
    );
    sql(wsDb, "INSERT INTO repos (name, path) VALUES ('plugin', ?)", innerRoot);
    const nestedWt = join(innerRoot, '.claude/worktrees/ws-test');
    git(sb.env, inner, 'branch', 'fix/ws-test', 'HEAD');
    git(sb.env, inner, 'worktree', 'add', '-q', nestedWt, 'fix/ws-test');
    assert.ok(existsSync(nestedWt), 'worktree not created');
    assert.ok(!existsSync(join(workspace, '.claude/worktrees/ws-test')), 'unexpected workspace-rooted worktree');
    has(runHook(close(20), { TRAJECTORY_DB_PATH: wsDb }, inner), CLEANED, 'nested-repo shape: worktree should be cleaned up');
    assert.ok(!existsSync(nestedWt), 'repo-rooted worktree still present in nested-repo shape');
  });

  describe('the review runs on the completed task; bro_atomic_close after the pass removes the worktree', () => {
    const ATOMIC_CLOSE = 'mcp__plugin_tmb_trajectory-server__bro_atomic_close';

    before(() => {
      execDb(
        db,
        `ALTER TABLE tasks ADD COLUMN commit_sha TEXT;
         CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, verdict TEXT, created_at TEXT);
         CREATE TABLE audit (id INTEGER PRIMARY KEY, from_node TEXT, event_type TEXT, content_json TEXT, created_at TEXT);`,
      );
    });

    it('failing validation_record on a handed-off completed task: silent, worktree kept for rework', () => {
      addWorktree('fix/atomic');
      execDb(
        db,
        `INSERT INTO tasks (id, branch_id, status, commit_sha) VALUES (10, 'fix/atomic', 'completed', 'abc1234');
         INSERT INTO audit (event_type, content_json, created_at)
           VALUES ('review_handoff', '{"task_id":10,"commit_sha":"abc1234"}', '2026-10-11T10:00:00.000Z');
         INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (10, 'fail', '2026-10-11T10:05:00.000Z');`,
      );
      assert.equal(runHook(validation('fail', 10)), '', 'a failing verdict must not trigger cleanup');
      assert.ok(existsSync(wt('atomic')), 'worktree removed on a failing review');
    });

    it('passing validation_record on a completed task: silent, bro has not closed it yet', () => {
      sql(db, "INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (10, 'pass', '2026-10-11T10:10:00.000Z')");
      assert.equal(runHook(validation('pass', 10)), '', 'a pass before the close must not trigger cleanup');
      assert.ok(existsSync(wt('atomic')), 'worktree removed before bro_atomic_close');
    });

    it('bro_atomic_close on a closed task whose pass is for an older commit: silent', () => {
      sql(db, "UPDATE tasks SET status = 'closed', commit_sha = 'def5678' WHERE id = 10");
      assert.equal(runHook(atomicClose(ATOMIC_CLOSE, 'bro', 10)), '', 'a stale pass must not trigger cleanup');
      assert.ok(existsSync(wt('atomic')), 'worktree removed for a stale pass');
    });

    it('bro_atomic_close on a task closed after its pass: worktree removed', () => {
      sql(db, "UPDATE tasks SET commit_sha = 'abc1234' WHERE id = 10");
      has(runHook(atomicClose(ATOMIC_CLOSE, 'bro', 10)), CLEANED, 'the close after a pass triggers cleanup');
      assert.ok(!existsSync(wt('atomic')), 'worktree still present after bro_atomic_close');
    });

    it('legacy order: passing validation_record on a task closed before its review: worktree removed', () => {
      addWorktree('fix/legacy');
      execDb(
        db,
        `INSERT INTO tasks (id, branch_id, status, commit_sha) VALUES (12, 'fix/legacy', 'closed', 'abc1234');
         INSERT INTO audit (event_type, content_json, created_at)
           VALUES ('bro_verification_pass', '{"task_id":12,"commit_sha":"abc1234"}', '2026-10-11T10:00:00.000Z');
         INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (12, 'pass', '2026-10-11T10:05:00.000Z');`,
      );
      has(runHook(validation('pass', 12)), CLEANED, 'a pass on a legacy closed task triggers cleanup');
      assert.ok(!existsSync(wt('legacy')), 'legacy worktree still present after its passing review');
    });

    it('passing validation_record with TMB_KEEP_CLOSED_WORKTREES=1: worktree intact', () => {
      addWorktree('fix/atomic2');
      execDb(
        db,
        `INSERT INTO tasks (id, branch_id, status, commit_sha) VALUES (11, 'fix/atomic2', 'closed', 'abc1234');
         INSERT INTO audit (event_type, content_json, created_at)
           VALUES ('bro_verification_pass', '{"task_id":11,"commit_sha":"abc1234"}', '2026-10-11T10:00:00.000Z');
         INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (11, 'pass', '2026-10-11T10:05:00.000Z');`,
      );
      assert.equal(runHook(validation('pass', 11), { TMB_KEEP_CLOSED_WORKTREES: '1' }), '', 'bypass env var silences review cleanup');
      assert.ok(existsSync(wt('atomic2')), 'atomic2 worktree was removed despite bypass');
    });

    it('passing validation_record on a reopened (running) task: worktree intact', () => {
      sql(db, "UPDATE tasks SET status = 'running' WHERE id = 11");
      assert.equal(runHook(validation('pass', 11)), '', 'a running task keeps its worktree');
      assert.equal(runHook(atomicClose(ATOMIC_CLOSE, 'bro', 11)), '', 'a refused close on a running task keeps its worktree');
      assert.ok(existsSync(wt('atomic2')), 'worktree removed from a running task');
    });
  });

  describe('#559: per-repo HEAD-reset target resolution', () => {
    let repoReal: string;

    before(() => {
      repoReal = git(sb.env, repo, 'rev-parse', '--show-toplevel');
      execDb(
        db,
        `CREATE TABLE IF NOT EXISTS repos (
           name              TEXT PRIMARY KEY,
           path              TEXT NOT NULL,
           file_count        INTEGER NOT NULL DEFAULT 0,
           last_scanned_at   TEXT NOT NULL DEFAULT (datetime('now')),
           target_branch     TEXT,
           branching_model   TEXT,
           protected_branches TEXT
         );`,
      );
    });

    const setTarget = (target: string | null) =>
      sql(db, "INSERT OR REPLACE INTO repos (name, path, target_branch) VALUES ('fixture', ?, ?)", repoReal, target);

    it("#559: registered repo with target_branch='main' → HEAD reset to main (not global dev)", () => {
      tryGit(sb.env, repo, ['branch', '-f', 'dev', 'HEAD']);
      onScratch('scratch-50');
      setTarget('main');
      addWorktree('fix/per-repo-main');
      sql(db, "INSERT INTO tasks (id, branch_id, status) VALUES (50, 'fix/per-repo-main', 'completed')");
      has(runHook(close(50)), CLEANED, 'worktree removed');
      assert.equal(head(), 'main', 'HEAD reset to main (per-repo target_branch honored)');
    });

    it("#559: registered repo with NULL target_branch → falls back to the default 'dev'", () => {
      setTarget(null);
      addWorktree('fix/per-repo-null');
      sql(db, "INSERT INTO tasks (id, branch_id, status) VALUES (51, 'fix/per-repo-null', 'completed')");
      onScratch('scratch-51');
      has(runHook(close(51)), CLEANED, 'worktree removed');
      assert.equal(head(), 'dev', 'HEAD reset to dev (NULL target_branch default fallback honored)');
    });

    it('#559: TMB_KEEP_HEAD_ON_CLOSE=1 still skips the reset', () => {
      setTarget('main');
      addWorktree('fix/per-repo-bypass');
      sql(db, "INSERT INTO tasks (id, branch_id, status) VALUES (52, 'fix/per-repo-bypass', 'completed')");
      onScratch('scratch-52');
      has(runHook(close(52), { TMB_KEEP_HEAD_ON_CLOSE: '1' }), CLEANED, 'worktree removed');
      assert.equal(head(), 'scratch-52', 'HEAD unchanged when TMB_KEEP_HEAD_ON_CLOSE=1');
    });

    it('GH 2032: a worktree the task adopted (worktree_adopted=1) is kept', () => {
      execDb(
        db,
        `ALTER TABLE tasks ADD COLUMN repo TEXT;
         ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
         ALTER TABLE tasks ADD COLUMN worktree_adopted INTEGER NOT NULL DEFAULT 0;`,
      );
      addWorktree('fix/adopted-2032');
      const adopted = join(repoReal, '.claude/worktrees/adopted-2032');
      sql(
        db,
        "INSERT INTO tasks (id, branch_id, status, repo, worktree_path, worktree_adopted) VALUES (60, 'fix/adopted-2032', 'closed', 'fixture', ?, 1)",
        adopted,
      );
      const out = runHook(close(60), { TMB_KEEP_HEAD_ON_CLOSE: '1' });
      has(out, `kept adopted worktree ${adopted} after task #60 closed (GH 2032)`, 'the gate names the kept worktree');
      assert.ok(existsSync(adopted), 'adopted worktree removed');
    });

    it('GH 2032: worktree_adopted=0 is removed', () => {
      addWorktree('fix/provisioned-2032');
      sql(db, "INSERT INTO tasks (id, branch_id, status, repo) VALUES (61, 'fix/provisioned-2032', 'closed', 'fixture')");
      has(runHook(close(61), { TMB_KEEP_HEAD_ON_CLOSE: '1' }), CLEANED, 'worktree removed');
      assert.ok(!existsSync(wt('provisioned-2032')), 'provisioned worktree still present');
    });
  });
});
