/**
 * git-push-guard on rebased task commits whose generated dist was rebuilt
 * (GH 1627, the l3 bash cases ported to node:test for GH 1692). feat/t
 * holds task 7's reviewed commit TSHA, cut from origin/main; main moves on and
 * feat/t-rebased replays TSHA onto it with mcp/trajectory-server/dist/index.js
 * rebuilt, so REBASED keeps TSHA's source change but not its patch-id. The
 * gate pairs them on the source-only patch-id and wants a passing,
 * not-timed-out verification run on REBASED itself.
 */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { commit, DENY, git, has, hasNot, initRepo, insertTask, INTEGRATE, newDb, push, recordRun, signTask, sql, tryGit } from './git-push-guard-l3.js';

const DIST = 'mcp/trajectory-server/dist/index.js';

describe('git-push-guard l3: GH 1627 rebased task commits with a regenerated dist', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  let tsha: string;
  let rebased: string;

  const commitFiles = (msg: string, ...files: string[]) => commit(sb.env, repo, msg, Object.fromEntries(files.map((f) => [f, `${msg} ${f}\n`])));

  /** Task 7's commit touches <files> on feat/t; feat/t-rebased replays it onto a moved main and rebuilds DIST. */
  const setupRebased = (...files: string[]) => {
    commitFiles('base moved', 'src/base.ts', DIST);
    git(sb.env, repo, 'checkout', '-q', '-b', 'feat/t', 'origin/main');
    tsha = commitFiles('feat: T', ...files);
    git(sb.env, repo, 'checkout', '-q', '-b', 'feat/t-rebased', 'main');
    git(sb.env, repo, 'cherry-pick', '-X', 'theirs', tsha);
    appendFileSync(join(repo, DIST), 'rebuilt\n');
    git(sb.env, repo, 'add', '--', DIST);
    git(sb.env, repo, 'commit', '-q', '--amend', '--no-edit');
    rebased = git(sb.env, repo, 'rev-parse', 'HEAD');
    insertTask(db, 7, tsha);
    signTask(db, 7);
  };
  const run = (branch: string) => push(sb, `git push origin ${branch}`, { cwd: repo, db });
  const patchId = (sha: string) => {
    const diff = git(sb.env, repo, 'diff-tree', '-p', sha);
    return tryGit(sb.env, repo, ['patch-id', '--stable'], `${diff}\n`).stdout.split(' ')[0];
  };

  beforeEach(() => {
    sb = makeSandbox('push-guard-dist');
    repo = join(sb.dir, 'repo');
    initRepo(sb.env, repo, 'main');
    commitFiles('init', 'README.md', 'src/base.ts', DIST);
    git(sb.env, repo, 'push', '-qu', 'origin', 'main');
    db = newDb(repo);
  });
  afterEach(() => sb.remove());

  it('fixture: the rebuilt rebase keeps the source change but not the patch-id', () => {
    setupRebased('src/t.ts', DIST);
    assert.equal(git(sb.env, repo, 'diff', tsha, rebased, '--', 'src/t.ts'), '', 'src/t.ts is unchanged by the rebase');
    const a = patchId(tsha);
    assert.ok(a !== '' && a !== patchId(rebased), 'the full patch-ids differ');
  });

  it('rebase with regenerated dist and no verification run → BLOCKED', () => {
    setupRebased('src/t.ts', DIST);
    const out = run('feat/t-rebased');
    has(out, DENY, 'an unverified rebase with rebuilt dist must block');
    has(out, rebased, 'the deny names the rebased SHA');
    has(out, 'task_id=7', 'the deny names the task');
    has(out, 'regenerated dist', 'the deny says the dist was regenerated');
    has(out, INTEGRATE, 'the deny points at cli.js integrate');
  });

  it('the same rebase after a passing verification run on its SHA → allowed', () => {
    setupRebased('src/t.ts', DIST);
    recordRun(db, 7, rebased, 0, { source: 'gate' });
    hasNot(run('feat/t-rebased'), DENY, 'a passing run on the rebased SHA covers it');
  });

  it('a failing run on the rebased SHA → BLOCKED', () => {
    setupRebased('src/t.ts', DIST);
    recordRun(db, 7, rebased, 1, { source: 'gate' });
    has(run('feat/t-rebased'), DENY, 'a failing run does not cover the rebase');
  });

  it('a timed-out run on the rebased SHA → BLOCKED', () => {
    setupRebased('src/t.ts', DIST);
    recordRun(db, 7, rebased, 0, { source: 'gate', timedOut: 1 });
    has(run('feat/t-rebased'), DENY, 'a timed-out run does not cover the rebase');
  });

  it('a passing run on the original task SHA does not cover the rebase', () => {
    setupRebased('src/t.ts', DIST);
    recordRun(db, 7, tsha, 0, { source: 'gate' });
    has(run('feat/t-rebased'), DENY, 'the run must name the pushed SHA');
  });

  it('a source-only task commit rebased with a dist rebuild added → BLOCKED', () => {
    setupRebased('src/t.ts');
    const out = run('feat/t-rebased');
    has(out, DENY, 'a changed path set still pairs on source paths');
    has(out, 'task_id=7', 'the deny names the task');
  });

  it("an unreviewed task's rebuilt rebase → BLOCKED even with a passing run", () => {
    setupRebased('src/t.ts', DIST);
    sql(db, 'DELETE FROM validation_attempts WHERE task_id = 7');
    recordRun(db, 7, rebased, 0, { source: 'gate' });
    const out = run('feat/t-rebased');
    has(out, DENY, "an unreviewed task's rebase must block");
    has(out, 'no passing review', 'the deny says the task is unreviewed');
  });

  it('a different source change with rebuilt dist stays untracked → allowed', () => {
    setupRebased('src/t.ts', DIST);
    git(sb.env, repo, 'checkout', '-q', '-b', 'feat/u', 'main');
    commitFiles('feat: U', 'src/t.ts', DIST);
    hasNot(run('feat/u'), DENY, "no source-only match keeps today's behaviour");
  });

  it('a dist-only commit with no task stays untracked → allowed', () => {
    setupRebased('src/t.ts', DIST);
    git(sb.env, repo, 'checkout', '-q', '-b', 'chore/dist', 'main');
    commitFiles('chore: rebuild dist', DIST);
    hasNot(run('chore/dist'), DENY, 'a dist-only commit matches no task');
  });

  it('an empty source patch never matches a dist-only task commit → allowed', () => {
    git(sb.env, repo, 'checkout', '-q', '-b', 'chore/dist-task', 'origin/main');
    insertTask(db, 8, commitFiles('chore: dist task', DIST, 'dashboard/dist/app.js'));
    signTask(db, 8);
    git(sb.env, repo, 'checkout', '-q', '-b', 'chore/dist', 'main');
    commitFiles('chore: other dist', DIST, 'dashboard/dist/app.js');
    hasNot(run('chore/dist'), DENY, 'two dist-only commits share no source patch-id');
  });
});
