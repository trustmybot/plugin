/**
 * `cli.js feature-branch cut|sync` (GH 2225): bro cuts an agile feature branch
 * at origin/<target> and merges origin/<target> into it.
 *
 * Each case builds a temp repo `work` with an origin (a bare repo) whose main
 * has moved one commit past work's local main, and a trajectory DB whose repos
 * row names main as the target and main and release as protected, then runs the
 * built bundle and checks the exit code, the SHA it prints and the refs.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const FEATURE = 'feat/milestone';

interface Run {
  code: number | null;
  out: string;
  err: string;
}

let root = '';
let work = '';
let other = '';
let db = '';

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}

function rev(ref: string): string {
  const r = spawnSync('git', ['-C', work, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

function commitIn(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), `${content}\n`);
  gitIn(dir, 'add', file);
  gitIn(dir, 'commit', '-qm', `feat: ${file}`);
  return gitIn(dir, 'rev-parse', 'HEAD');
}

/** work and origin share README; origin/main then gains dev.txt from `other`, which work has not fetched. */
function setup(withOrigin = true): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-feature-branch-')));
  work = join(root, 'work');
  mkdirSync(work);
  gitIn(work, 'init', '-q', '-b', 'main');
  commitIn(work, 'README.md', 'init');
  if (withOrigin) {
    gitIn(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    gitIn(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
    gitIn(work, 'push', '-qu', 'origin', 'main');
    gitIn(root, 'clone', '-q', join(root, 'origin.git'), 'other');
    other = join(root, 'other');
    commitIn(other, 'dev.txt', 'dev moves');
    gitIn(other, 'push', '-q', 'origin', 'main');
  }

  db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    d.prepare(
      `INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('work', ?, 'main', 'github-flow', '["main","release"]')`,
    ).run(work);
  } finally {
    d.close();
  }
}

function featureBranch(...args: string[]): Run {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'feature-branch', ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: work },
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout.replace(/\n+$/, ''), err: r.stderr };
}

function heads(): string {
  return gitIn(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
}

function assertNoTempWorktree(): void {
  const dir = join(work, '.claude/worktrees');
  const left = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('feature-branch-')) : [];
  assert.deepEqual(left, [], 'feature-branch-* dirs left behind');
  assert.equal(gitIn(work, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'only the main worktree is registered');
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('cli.js feature-branch cut', () => {
  it('SC1: creates the branch at origin/<target>, after fetching it, and prints its SHA', () => {
    setup();
    const r = featureBranch('cut', FEATURE);
    assert.equal(r.code, 0, r.err);
    const originMain = rev('refs/remotes/origin/main');
    assert.equal(originMain, gitIn(other, 'rev-parse', 'HEAD'), 'origin/main was fetched');
    assert.notEqual(originMain, rev('refs/heads/main'), 'local main is behind origin/main');
    assert.equal(r.out, originMain, 'stdout is only the new SHA');
    assert.equal(rev(`refs/heads/${FEATURE}`), originMain);
  });

  it('SC1: with no origin, cuts at the local target', () => {
    setup(false);
    const r = featureBranch('cut', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, rev('refs/heads/main'));
    assert.equal(rev(`refs/heads/${FEATURE}`), rev('refs/heads/main'));
  });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['main', 'the target branch'],
    ['release', 'a protected branch'],
    ['bad..name', 'an invalid name'],
    ['@{-1}', 'a name check-ref-format --branch would expand'],
    ['-x', 'an option-like name'],
  ];
  for (const [name, what] of refused) {
    it(`SC1: refuses ${what} with exit 4 and creates no ref`, () => {
      setup();
      const before = heads();
      const r = featureBranch('cut', name);
      assert.equal(r.code, 4, r.err);
      assert.equal(r.out, '');
      assert.equal(heads(), before);
    });
  }

  it('SC1: refuses a branch that already exists with exit 4 and leaves it where it was', () => {
    setup();
    gitIn(work, 'branch', FEATURE);
    const before = heads();
    const r = featureBranch('cut', FEATURE);
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /already exists/);
    assert.equal(heads(), before);
  });

  it('a usage error exits 4', () => {
    setup();
    assert.equal(featureBranch('cut').code, 4);
    assert.equal(featureBranch('prune', FEATURE).code, 4);
    assert.equal(featureBranch('cut', FEATURE, '--repo').code, 4);
  });

  it('--repo names the repo when cwd is outside it', () => {
    setup();
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'feature-branch', 'cut', FEATURE, '--repo', 'work'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: root },
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rev(`refs/heads/${FEATURE}`), rev('refs/remotes/origin/main'));
  });
});

describe('cli.js feature-branch sync', () => {
  /** FEATURE cut from work's local main (before origin moved) with one commit of its own. */
  function cutFeature(file = 'f.txt', content = 'feature'): string {
    gitIn(work, 'checkout', '-q', '-b', FEATURE);
    const tip = commitIn(work, file, content);
    gitIn(work, 'checkout', '-q', 'main');
    return tip;
  }

  it('SC2: merges origin/<target> into the feature branch, keeps its commits and prints the merge', () => {
    setup();
    const oldTip = cutFeature();
    const r = featureBranch('sync', FEATURE);
    assert.equal(r.code, 0, r.err);
    const tip = rev(`refs/heads/${FEATURE}`);
    assert.equal(r.out, tip, 'stdout is only the new tip');
    assert.equal(gitIn(work, 'rev-list', '--parents', '-n', '1', tip), `${tip} ${oldTip} ${rev('refs/remotes/origin/main')}`, 'a merge of the old tip and origin/main');
    assertNoTempWorktree();
  });

  it('SC2: already up to date prints the unchanged SHA and exits 0', () => {
    setup();
    gitIn(work, 'fetch', '-q', 'origin', 'main');
    gitIn(work, 'branch', FEATURE, 'origin/main');
    const tip = rev(`refs/heads/${FEATURE}`);
    const r = featureBranch('sync', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, tip);
    assert.equal(rev(`refs/heads/${FEATURE}`), tip);
    assertNoTempWorktree();
  });

  it('SC2: a conflict exits 2, lists the path, leaves the branch and no worktree', () => {
    setup();
    const oldTip = cutFeature('dev.txt', 'feature side');
    const r = featureBranch('sync', FEATURE);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    assert.match(r.err, /Conflicting paths:\ndev\.txt/);
    assert.equal(rev(`refs/heads/${FEATURE}`), oldTip);
    assertNoTempWorktree();
  });

  it('refuses a feature branch checked out in a worktree with exit 4', () => {
    setup();
    const oldTip = cutFeature();
    gitIn(work, 'worktree', 'add', '-q', join(root, 'holder'), FEATURE);
    const r = featureBranch('sync', FEATURE);
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /checked out at/);
    assert.equal(rev(`refs/heads/${FEATURE}`), oldTip);
  });

  it('refuses a missing branch and the target branch with exit 4', () => {
    setup();
    assert.equal(featureBranch('sync', FEATURE).code, 4);
    const main = rev('refs/heads/main');
    assert.equal(featureBranch('sync', 'main').code, 4);
    assert.equal(rev('refs/heads/main'), main);
  });
});
