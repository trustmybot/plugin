/**
 * `cli.js feature-branch cut|sync|drop|cleanup` (GH 2225): bro cuts an agile
 * feature branch at origin/<target>, merges origin/<target> into it, drops it
 * (escalating its queued tasks) and deletes it once its remote copy is gone.
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

/** Runs <sql> on the test DB and returns the first column of each row, newline-joined. */
function q(sql: string): string {
  const d = new DatabaseSync(db);
  try {
    return d
      .prepare(sql)
      .all()
      .map((row) => String(Object.values(row as Record<string, unknown>)[0]))
      .join('\n');
  } finally {
    d.close();
  }
}

function exec(sql: string): void {
  const d = new DatabaseSync(db);
  try {
    d.exec(sql);
  } finally {
    d.close();
  }
}

interface SeedTask {
  status?: string;
  repo?: string;
  merged?: string | null;
  parent?: string | null;
  queued?: boolean;
}

/** A task of issue 1: by default closed agile at commit c<id>, queued for review and merged onto FEATURE in repo work. */
function seedTask({ status = 'closed', repo = 'work', merged = FEATURE, parent = null, queued = true }: SeedTask = {}): number {
  const d = new DatabaseSync(db);
  try {
    const now = new Date().toISOString();
    d.prepare(`INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'agile', 'open', ?, ?)`).run(now, now);
    const id = Number(
      d
        .prepare(
          `INSERT INTO tasks (issue_id, branch_id, description, status, workflow_mode, commit_sha, repo, parent_branch_id, created_at, updated_at)
           VALUES (1, 'feat/t' || (SELECT COUNT(*) FROM tasks), 'd', ?, 'agile', 'c', ?, ?, ?, ?)`,
        )
        .run(status, repo, parent, now, now).lastInsertRowid,
    );
    d.prepare(`UPDATE tasks SET commit_sha = ? WHERE id = ?`).run(`c${id}`, id);
    const audit = d.prepare(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, repo, created_at) VALUES (1, 'bro', ?, 's', ?, ?, ?)`);
    if (queued) audit.run('review_queued', JSON.stringify({ task_id: id, commit_sha: `c${id}` }), repo, now);
    if (merged !== null) audit.run('feature_branch_merged', JSON.stringify({ task_id: id, feature_branch: merged, commit_sha: `c${id}`, rebased: false }), repo, now);
    return id;
  } finally {
    d.close();
  }
}

function droppedRows(): string {
  return q("SELECT COUNT(*) FROM audit WHERE event_type = 'feature_branch_dropped'");
}

function status(id: number): string {
  return q(`SELECT status FROM tasks WHERE id = ${id}`);
}

describe('cli.js feature-branch drop', () => {
  /** setup() with no origin, FEATURE cut at main, and a second registered repo `other`. */
  function setupDrop(): string {
    setup(false);
    exec(`INSERT INTO repos (name, path, target_branch) VALUES ('other', '${join(root, 'other-repo')}', 'main')`);
    gitIn(work, 'branch', FEATURE);
    return rev(`refs/heads/${FEATURE}`);
  }

  it('SC1: escalates the queued tasks of the branch in this repo, writes one row and keeps the branch', () => {
    const tip = setupDrop();
    const queued = [seedTask(), seedTask()];
    const otherBranch = seedTask({ merged: 'feat/other' });
    const otherRepo = seedTask({ repo: 'other' });
    const notQueued = seedTask({ queued: false });
    const r = featureBranch('drop', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, tip, 'stdout is only the branch SHA');
    for (const id of queued) assert.equal(status(id), 'escalated');
    for (const id of [otherBranch, otherRepo, notQueued]) assert.equal(status(id), 'closed', `task ${id} is not a queued task of the branch`);
    assert.equal(droppedRows(), '1');
    assert.deepEqual(JSON.parse(q("SELECT content_json FROM audit WHERE event_type = 'feature_branch_dropped'")), {
      feature_branch: FEATURE,
      repo: 'work',
      task_ids: queued,
    });
    assert.equal(q("SELECT issue_id || '|' || branch_id || '|' || from_node || '|' || repo FROM audit WHERE event_type = 'feature_branch_dropped'"), `1|${FEATURE}|bro|work`);
    assert.equal(rev(`refs/heads/${FEATURE}`), tip, 'the branch ref stays without --delete-branch');
  });

  it('SC1: --delete-branch also deletes the branch and prints the SHA it was at', () => {
    const tip = setupDrop();
    const id = seedTask();
    const r = featureBranch('drop', FEATURE, '--delete-branch');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, tip);
    assert.equal(status(id), 'escalated');
    assert.equal(droppedRows(), '1');
    assert.equal(rev(`refs/heads/${FEATURE}`), '', 'branch deleted');
  });

  it('SC1: a branch with no task is dropped with an empty task_ids on the system issue', () => {
    setupDrop();
    const r = featureBranch('drop', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(q("SELECT issue_id || '|' || json_extract(content_json, '$.task_ids') FROM audit WHERE event_type = 'feature_branch_dropped'"), '-1|[]');
  });

  const liveCases: ReadonlyArray<readonly [string, SeedTask]> = [
    ['a pending task whose parent_branch_id names the branch', { status: 'pending', merged: null, parent: FEATURE, queued: false }],
    ['a merged task reopened to running', { status: 'running' }],
    ['a needs_validation task', { status: 'needs_validation', merged: null, parent: FEATURE, queued: false }],
    ['a completed task', { status: 'completed', merged: null, parent: FEATURE, queued: false }],
  ];
  for (const [what, live] of liveCases) {
    it(`SC2: exits 4 and writes nothing while ${what} sits on the branch`, () => {
      const tip = setupDrop();
      const queued = seedTask();
      seedTask(live);
      const r = featureBranch('drop', FEATURE, '--delete-branch');
      assert.equal(r.code, 4, r.err);
      assert.equal(r.out, '');
      assert.match(r.err, /live tasks/);
      assert.equal(status(queued), 'closed');
      assert.equal(droppedRows(), '0');
      assert.equal(rev(`refs/heads/${FEATURE}`), tip);
    });
  }

  it('SC2: a live task of the same branch name in another repo does not block', () => {
    setupDrop();
    const queued = seedTask();
    seedTask({ status: 'pending', repo: 'other', merged: null, parent: FEATURE, queued: false });
    const r = featureBranch('drop', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(status(queued), 'escalated');
  });

  it('SC2: an unknown branch exits 4 and writes nothing', () => {
    setup(false);
    const r = featureBranch('drop', FEATURE);
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /unknown/);
    assert.equal(droppedRows(), '0');
  });

  it('SC2: a branch known only by its tasks is dropped', () => {
    setup(false);
    const id = seedTask();
    const r = featureBranch('drop', FEATURE, '--delete-branch');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '');
    assert.equal(status(id), 'escalated');
  });

  it('--delete-branch of a branch checked out in a worktree exits 4 and writes nothing', () => {
    const tip = setupDrop();
    const id = seedTask();
    gitIn(work, 'worktree', 'add', '-q', join(root, 'holder'), FEATURE);
    const r = featureBranch('drop', FEATURE, '--delete-branch');
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /checked out at/);
    assert.equal(status(id), 'closed');
    assert.equal(droppedRows(), '0');
    assert.equal(rev(`refs/heads/${FEATURE}`), tip);
  });

  it('a failed DB write restores the deleted branch and exits 4', () => {
    const tip = setupDrop();
    const id = seedTask();
    exec(`CREATE TRIGGER refuse_dropped BEFORE INSERT ON audit WHEN NEW.event_type = 'feature_branch_dropped'
            BEGIN SELECT RAISE(ABORT, 'refused'); END;`);
    const r = featureBranch('drop', FEATURE, '--delete-branch');
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /recording the drop of '.*' failed; .* is unchanged/);
    assert.equal(rev(`refs/heads/${FEATURE}`), tip, 'branch restored');
    assert.equal(status(id), 'closed');
  });

  it('refuses the target branch, and --delete-branch on another subcommand is a usage error', () => {
    setupDrop();
    assert.equal(featureBranch('drop', 'main').code, 4);
    assert.equal(rev('refs/heads/main') !== '', true);
    assert.equal(featureBranch('cleanup', FEATURE, '--delete-branch').code, 4);
    assert.equal(featureBranch('drop').code, 4);
    assert.equal(droppedRows(), '0');
  });
});

describe('cli.js feature-branch cleanup', () => {
  it('SC3: with no origin, deletes the local branch and prints the SHA it was at', () => {
    setup(false);
    gitIn(work, 'branch', FEATURE);
    const tip = rev(`refs/heads/${FEATURE}`);
    const r = featureBranch('cleanup', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, tip);
    assert.equal(rev(`refs/heads/${FEATURE}`), '');
  });

  it('SC3: exits 4 while origin/<name> exists, and deletes once the remote copy is gone', () => {
    setup();
    gitIn(work, 'branch', FEATURE);
    gitIn(work, 'push', '-q', 'origin', FEATURE);
    const tip = rev(`refs/heads/${FEATURE}`);
    const kept = featureBranch('cleanup', FEATURE);
    assert.equal(kept.code, 4, kept.err);
    assert.match(kept.err, /still exists/);
    assert.equal(rev(`refs/heads/${FEATURE}`), tip);

    gitIn(other, 'push', '-q', 'origin', `:${FEATURE}`);
    assert.equal(rev(`refs/remotes/origin/${FEATURE}`), tip, 'work still has the stale remote-tracking ref');
    const r = featureBranch('cleanup', FEATURE);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, tip);
    assert.equal(rev(`refs/heads/${FEATURE}`), '');
    assert.equal(rev(`refs/remotes/origin/${FEATURE}`), '', 'the fetch pruned the remote-tracking ref');
  });

  it('SC3: exits 4 and keeps a branch checked out in a worktree', () => {
    setup(false);
    gitIn(work, 'branch', FEATURE);
    const tip = rev(`refs/heads/${FEATURE}`);
    gitIn(work, 'worktree', 'add', '-q', join(root, 'holder'), FEATURE);
    const r = featureBranch('cleanup', FEATURE);
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /checked out at/);
    assert.equal(rev(`refs/heads/${FEATURE}`), tip);
  });

  it('SC3: exits 4 for a missing branch and for the target branch', () => {
    setup(false);
    assert.equal(featureBranch('cleanup', FEATURE).code, 4);
    const main = rev('refs/heads/main');
    assert.equal(featureBranch('cleanup', 'main').code, 4);
    assert.equal(rev('refs/heads/main'), main);
    assert.equal(q('SELECT COUNT(*) FROM audit'), '0', 'cleanup writes no DB');
  });
});
