/**
 * git-push-guard on a branch's first push (GH 1692), the l3 first-push and
 * bro-skip-detection bash cases in node:test: with no @{u} the gated range
 * falls back to origin/<target>..HEAD, so a first push is reviewed like any
 * other (!2899, bro skipping code-reviewer on a new branch). An unresolvable
 * base fails closed (H4), a leading cd scopes the base to its repo, and the
 * target comes from this repo's repos row, else the sole registered repo,
 * else the remote's default branch, else main. Each case runs
 * `node dist/hooks.js git-push-guard` from a temp repo with a bare upstream.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { commit, DENY, git, has, hasNot, initRepo, insertRepo, insertTask, newDb, NO_DB, push, signTask, tryGit } from './git-push-guard-l3.js';

interface FirstPush {
  sb: Sandbox;
  repo: string;
  sha: string;
}

/** dev pushed with tracking, then <branch> with one commit and no upstream. */
function setupFirstPush(branch: string, file: string): FirstPush {
  const sb = makeSandbox('first-push');
  const repo = join(sb.dir, 'repo');
  initRepo(sb.env, repo, 'dev');
  commit(sb.env, repo, 'init', { 'README.md': 'init\n' });
  git(sb.env, repo, 'push', '-qu', 'origin', 'dev');
  git(sb.env, repo, 'switch', '-q', '-c', branch);
  const sha = commit(sb.env, repo, `work on ${branch}`, { [file]: 'work\n' });
  return { sb, repo, sha };
}

describe('git-push-guard l3: !2899 bro atomic-close then a first push with no code-reviewer verdict', () => {
  const BRANCH = 'chore/audit-fix-42';
  let f: FirstPush;
  let db: string;
  beforeEach(() => {
    f = setupFirstPush(BRANCH, 'fix.txt');
    db = newDb(f.repo);
    insertRepo(db, 'fixture', git(f.sb.env, f.repo, 'rev-parse', '--show-toplevel'), 'dev');
    insertTask(db, 42, f.sha, BRANCH);
  });
  afterEach(() => f.sb.remove());
  const run = () => push(f.sb, `git push -u origin ${BRANCH}`, { cwd: f.repo, db });

  it('no code-reviewer verdict → BLOCKED', () => {
    const out = run();
    has(out, DENY, 'push without code-reviewer verdict must be blocked');
    has(out, 'task_id=42', 'block message must name the unsigned task');
    has(out, 'review before push', 'block message must direct to review path');
  });

  it('a code-reviewer pass → ALLOWED', () => {
    signTask(db, 42);
    hasNot(run(), DENY, 'push with code-reviewer pass verdict must be allowed');
  });

  it('multiple unsigned tasks on the new branch → all blocked', () => {
    insertTask(db, 43, commit(f.sb.env, f.repo, 'chore: audit fix 43', { 'fix2.txt': 'fix2\n' }), 'chore/audit-fix-43');
    const out = run();
    has(out, DENY, 'multiple unsigned tasks must block');
    has(out, 'task_id=42', 'must list task 42');
    has(out, 'task_id=43', 'must list task 43');
  });
});

describe('git-push-guard l3: first-push fallback to origin/<target>', () => {
  const BRANCH = 'feat/my-feature';
  let f: FirstPush;
  beforeEach(() => {
    f = setupFirstPush(BRANCH, 'feature.txt');
  });
  afterEach(() => f.sb.remove());
  const registered = (target: string) => {
    const db = newDb(f.repo);
    insertRepo(db, 'repo', git(f.sb.env, f.repo, 'rev-parse', '--show-toplevel'), target);
    return db;
  };
  const run = (db: string) => push(f.sb, `git push -u origin ${BRANCH}`, { cwd: f.repo, db });

  it('unsigned task: BLOCKED (no @{u} fallback uses origin/dev)', () => {
    const db = registered('dev');
    insertTask(db, 1, f.sha, BRANCH);
    const out = run(db);
    has(out, DENY, 'first push of unsigned task must be blocked');
    has(out, 'task_id=1', 'block message must list the unsigned task');
  });

  it('signed task: ALLOWED (pass verdict satisfies gate)', () => {
    const db = registered('dev');
    insertTask(db, 1, f.sha, BRANCH);
    signTask(db, 1);
    hasNot(run(db), DENY, 'first push with pass verdict must be allowed');
  });

  it('no task row: ALLOWED (untracked commit, TMB not managing it)', () => hasNot(run(registered('dev')), DENY, 'untracked first push must be allowed'));

  it('no DB: ALLOWED (TMB not active)', () => hasNot(run(NO_DB), DENY, 'missing DB must not block first push'));

  it("H4: target_branch='main' but origin/main missing → FAIL CLOSED, unsigned task BLOCKED", () => {
    const db = registered('main');
    insertTask(db, 1, f.sha, BRANCH);
    const out = run(db);
    has(out, DENY, 'unresolved base must fail closed, not bypass the gate');
    has(out, 'task_id=1', 'block message must list the unsigned task');
  });

  it('H4: unresolvable base but SIGNED task → ALLOWED (gate satisfied, not a blanket block)', () => {
    const db = registered('main');
    insertTask(db, 1, f.sha, BRANCH);
    signTask(db, 1);
    hasNot(run(db), DENY, 'signed task must pass even when the base is unresolved');
  });

  it("H4: multi-repo 'cd <repo> && git push' scopes the base resolution to the cd target", () => {
    const db = registered('dev');
    insertTask(db, 1, f.sha, BRANCH);
    const elsewhere = join(f.sb.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const out = push(f.sb, `cd ${f.repo} && git push -u origin ${BRANCH}`, { cwd: elsewhere, db });
    has(out, DENY, 'cd target must be resolved for the first-push base');
    has(out, 'task_id=1', 'block message must list the unsigned task');
  });
});

describe('git-push-guard l3: first-push target with no repos row for this repo', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  beforeEach(() => {
    sb = makeSandbox('first-push-target');
    repo = join(sb.dir, 'repo');
    initRepo(sb.env, repo, 'dev');
    commit(sb.env, repo, 'init', { 'README.md': 'init\n' });
    git(sb.env, repo, 'branch', '-q', 'main');
    git(sb.env, repo, 'push', '-q', 'origin', 'main', 'dev');
    const devSha = commit(sb.env, repo, 'dev work', { 'dev.txt': 'd\n' });
    git(sb.env, repo, 'push', '-q', 'origin', 'dev');
    git(sb.env, repo, 'switch', '-q', '-c', 'feat/my-feature');
    const featureSha = commit(sb.env, repo, 'feat: add feature', { 'feature.txt': 'feature work\n' });
    db = newDb(repo);
    insertTask(db, 1, featureSha, 'feat/my-feature');
    insertTask(db, 2, devSha, 'feat/dev-work');
  });
  afterEach(() => sb.remove());
  const run = () => push(sb, 'git push -u origin feat/my-feature', { cwd: repo, db });

  it("the sole registered repo's target_branch", () => {
    insertRepo(db, 'other', '/elsewhere/other', 'main');
    const out = run();
    has(out, 'task_id=1', 'the feature commit is gated');
    has(out, 'task_id=2', "the sole repo's target main also gates the dev commit");
  });

  it("no repos rows → the remote's default branch", () => {
    git(sb.env, repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
    const out = run();
    has(out, 'task_id=1', 'the feature commit is gated');
    hasNot(out, 'task_id=2', 'origin/HEAD → dev: the dev commit is the base, not gated');
  });

  it('no repos rows, no origin/HEAD → main', () => {
    tryGit(sb.env, repo, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    const out = run();
    has(out, 'task_id=1', 'the feature commit is gated');
    has(out, 'task_id=2', 'main is the base, so the dev commit is gated too');
  });
});
