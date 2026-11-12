/**
 * git-push-guard's three fail-open paths of GH 3102, end to end: the commits a
 * push sends come from each statement's refspec, not from the checkout's HEAD;
 * a task's short commit_sha (7+ hex) matches the full SHAs git lists; and a
 * forced push is judged like any push. Each case runs `node dist/hooks.js
 * git-push-guard` against a repo on dev whose feature branch holds the task
 * commit, with a bare upstream as origin.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { commit, DENY, git, has, hasNot, initRepo, insertRepo, insertTask, newDb, push, recordRun, signTask } from './git-push-guard-l3.js';

const FEATURE = 'feat/a';

interface Fixture {
  sb: Sandbox;
  repo: string;
  db: string;
  sha: string;
}

/** A repo on dev tracking origin/dev, a feature branch one commit (sha) ahead, and the checkout back on dev. */
function setup(): Fixture {
  const sb = makeSandbox('push-guard-refspec');
  const repo = join(sb.dir, 'repo');
  initRepo(sb.env, repo, 'dev');
  commit(sb.env, repo, 'init', { 'README.md': 'init\n' });
  git(sb.env, repo, 'push', '-qu', 'origin', 'dev');
  git(sb.env, repo, 'checkout', '-q', '-b', FEATURE);
  const sha = commit(sb.env, repo, 'feat: A', { 'a.txt': 'feat A\n' });
  git(sb.env, repo, 'checkout', '-q', 'dev');
  const db = newDb(repo);
  insertRepo(db, 'fixture', repo, 'dev');
  return { sb, repo, db, sha };
}

describe('git-push-guard refspec l3: the refspec decides the commits, not HEAD (GH 3102)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });
  afterEach(() => f.sb.remove());
  const run = (cmd: string, cwd = f.repo) => push(f.sb, cmd, { cwd, db: f.db });

  it('an unreviewed feature pushed with -C from a checkout on dev → BLOCKED', () => {
    insertTask(f.db, 1, f.sha);
    has(run(`git -C ${f.repo} push origin ${FEATURE}`, f.sb.dir), 'task_id=1', 'the refspec names the unreviewed commit even though HEAD is dev');
  });

  it('an unreviewed feature pushed from a checkout on dev → BLOCKED', () => {
    insertTask(f.db, 1, f.sha);
    has(run(`git push origin ${FEATURE}`), 'task_id=1', 'a plain refspec push from dev must be judged');
  });

  for (const refspec of [FEATURE, `${FEATURE}:${FEATURE}`, `refs/heads/${FEATURE}:refs/heads/${FEATURE}`, `${FEATURE}:refs/heads/other`]) {
    it(`a reviewed feature pushed from dev as \`${refspec}\` → allowed`, () => {
      insertTask(f.db, 1, f.sha);
      signTask(f.db, 1);
      hasNot(run(`git -C ${f.repo} push origin ${refspec}`), DENY, 'a reviewed commit passes whatever refspec form names it');
    });
  }

  it('HEAD on the feature checkout resolves to its commits: unreviewed → BLOCKED, reviewed → allowed', () => {
    git(f.sb.env, f.repo, 'checkout', '-q', FEATURE);
    insertTask(f.db, 1, f.sha);
    has(run('git push origin HEAD'), 'task_id=1', 'HEAD names the feature tip');
    signTask(f.db, 1);
    hasNot(run('git push origin HEAD'), DENY, 'a reviewed HEAD push passes');
  });

  it('a commit already on its remote-tracking ref is not judged again', () => {
    insertTask(f.db, 1, f.sha);
    git(f.sb.env, f.repo, 'push', '-q', 'origin', FEATURE);
    git(f.sb.env, f.repo, 'checkout', '-q', FEATURE);
    commit(f.sb.env, f.repo, 'feat: untracked', { 'b.txt': 'b\n' });
    git(f.sb.env, f.repo, 'checkout', '-q', 'dev');
    hasNot(run(`git push origin ${FEATURE}`), DENY, `origin/${FEATURE} bounds the range, so only the untracked commit is sent`);
  });

  it('a refspec that names no commit → BLOCKED as unresolvable', () =>
    has(run('git push origin feat/nonexistent'), 'cannot resolve the refspec `feat/nonexistent`', 'an unknown source must fail closed'));

  it('a refspec built from an expansion of an unreviewed feature → BLOCKED', () => {
    insertTask(f.db, 1, f.sha);
    has(run(`B=${FEATURE}; git push origin "$B"`), DENY, 'a refspec read through an expansion must not fail open');
  });

  for (const cmd of [`git push origin :${FEATURE}`, `git push origin --delete ${FEATURE}`, `git push -d origin ${FEATURE}`]) {
    it(`a delete (\`${cmd}\`) sends no commits → not judged`, () => {
      insertTask(f.db, 1, f.sha);
      hasNot(run(cmd), DENY, 'a delete pushes no commits');
    });
  }

  it('--all sends every branch, so an unreviewed feature → BLOCKED', () => {
    insertTask(f.db, 1, f.sha);
    has(run('git push --all origin'), 'task_id=1', '--all includes the feature branch');
  });

  it('a bare push from dev still judges only @{u}..HEAD → allowed', () => {
    insertTask(f.db, 1, f.sha);
    hasNot(run('git push'), DENY, 'a bare push sends dev, which holds no unreviewed commit');
  });

  it('a redirect after the refspec is not read as one', () => {
    insertTask(f.db, 1, f.sha);
    signTask(f.db, 1);
    hasNot(run(`git push origin ${FEATURE} 2>&1`), DENY, '2>&1 is a redirect, not a refspec');
  });
});

describe('git-push-guard refspec l3: forced pushes are judged (GH 3102)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });
  afterEach(() => f.sb.remove());
  const run = (cmd: string) => push(f.sb, cmd, { cwd: f.repo, db: f.db });

  for (const cmd of [`git push --force origin ${FEATURE}`, `git push --force-with-lease origin ${FEATURE}`, `git push origin +${FEATURE}:${FEATURE}`, `git push -f origin ${FEATURE}`]) {
    it(`\`${cmd}\` of an unreviewed feature → BLOCKED`, () => {
      insertTask(f.db, 1, f.sha);
      has(run(cmd), 'task_id=1', 'a forced push is judged like any push');
    });

    it(`\`${cmd}\` of a reviewed feature → allowed`, () => {
      insertTask(f.db, 1, f.sha);
      signTask(f.db, 1);
      hasNot(run(cmd), DENY, 'a reviewed forced push passes this gate');
    });
  }
});

describe('git-push-guard refspec l3: a short stored commit_sha still matches (GH 3102)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });
  afterEach(() => f.sb.remove());
  const run = (cmd: string) => push(f.sb, cmd, { cwd: f.repo, db: f.db });

  it('a 7-hex commit_sha with no review → BLOCKED', () => {
    insertTask(f.db, 1, f.sha.slice(0, 7));
    has(run(`git push origin ${FEATURE}`), 'task_id=1', 'a short SHA must match the pushed commit');
  });

  it('a 7-hex commit_sha with a passing review and a passing run → allowed', () => {
    const short = f.sha.slice(0, 7);
    insertTask(f.db, 1, short);
    signTask(f.db, 1);
    recordRun(f.db, 1, short, 0);
    hasNot(run(`git push origin ${FEATURE}`), DENY, 'a reviewed short SHA passes');
  });

  it('a 6-hex commit_sha is too short to match anything', () => {
    insertTask(f.db, 1, f.sha.slice(0, 6));
    hasNot(run(`git push origin ${FEATURE}`), DENY, 'below 7 hex a stored SHA matches nothing');
  });

  it('a non-hex commit_sha matches nothing', () => {
    insertTask(f.db, 1, `${f.sha.slice(0, 6)}%`);
    hasNot(run(`git push origin ${FEATURE}`), DENY, 'a LIKE wildcard in a stored SHA must not widen the match');
  });

  describe('a rebase of a task whose commit_sha is short', () => {
    let rebased: string;
    beforeEach(() => {
      const { env } = f.sb;
      git(env, f.repo, 'checkout', '-q', '-b', 'feat/a-rebased', 'dev');
      commit(env, f.repo, 'dev moves', { 'dev.txt': 'dev\n' });
      git(env, f.repo, 'cherry-pick', f.sha);
      rebased = git(env, f.repo, 'rev-parse', 'HEAD');
      git(env, f.repo, 'checkout', '-q', 'dev');
      insertTask(f.db, 5, f.sha.slice(0, 7));
      signTask(f.db, 5);
    });

    it('with no run on the rebased SHA → BLOCKED', () => has(run('git push origin feat/a-rebased'), rebased, 'an unverified rebase must block'));

    it('with a passing run stored under the short rebased SHA → allowed', () => {
      recordRun(f.db, 5, rebased.slice(0, 7), 0);
      hasNot(run('git push origin feat/a-rebased'), DENY, 'a short run SHA covers the rebase');
    });
  });
});
