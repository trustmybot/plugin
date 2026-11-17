/**
 * `cli.js feature-merge` (GH 2225): bro lands a closed agile task on its
 * feature branch, the task's parent_branch_id.
 *
 * Each case builds a temp repo (main, the feature branch feat/agile cut from
 * it, and the task branch feat/agile-t1 cut from feat/agile adding a.txt) and
 * a trajectory DB holding task 1, closed under workflow_mode 'agile' and
 * queued for review at its commit, then runs `cli.js feature-merge 1` against
 * the built bundle and checks the exit code, the SHA it prints, both branch
 * refs, the task row and the audit rows.
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
import { AGILE_QUEUED_SQL } from '../review-sql.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const FEATURE = 'feat/agile';
const TASK_BRANCH = 'feat/agile-t1';
const PASSING = '["test -f a.txt"]';
const FAILING = '["test -f a.txt", "echo broken; exit 7"]';

interface Run {
  code: number | null;
  out: string;
  err: string;
}

interface TaskRow {
  status?: string;
  workflowMode?: string | null;
  parent?: string | null;
  verification?: string;
}

let repo = '';
let db = '';
let commit = '';

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}

function rev(ref: string): string {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : '';
}

function commitFile(file: string, content: string, msg = `feat: ${file}`): void {
  writeFileSync(join(repo, file), `${content}\n`);
  git('add', file);
  git('commit', '-qm', msg);
}

function q(sql: string): string {
  const d = new DatabaseSync(db);
  try {
    const rows = d.prepare(sql).all() as Record<string, string | number | bigint | null>[];
    return rows.map((row) => Object.values(row).map((v) => (v === null ? '' : String(v))).join('|')).join('\n');
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

type Move = 'none' | 'clean' | 'conflict' | 'same';

// main gets README; feat/agile is cut from it; feat/agile-t1 off feat/agile
// adds a.txt (commit); then feat/agile moves:
//   clean    — m.txt
//   conflict — a.txt with other content
//   same     — the task's exact a.txt change (a rebase drops the task commit)
function setup(move: Move, task: TaskRow = {}): void {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-feature-merge-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  commitFile('README.md', 'init');
  git('branch', FEATURE);
  git('checkout', '-q', '-b', TASK_BRANCH, FEATURE);
  commitFile('a.txt', 'task');
  commit = rev('HEAD');
  git('checkout', '-q', FEATURE);
  if (move === 'clean') commitFile('m.txt', 'moved');
  if (move === 'conflict') commitFile('a.txt', 'other');
  if (move === 'same') commitFile('a.txt', 'task', 'chore: land a.txt on the feature branch');
  git('checkout', '-q', 'main');

  db = join(repo, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    d.prepare(
      `INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('repo', ?, 'main', 'github-flow', '["main","release"]')`,
    ).run(repo);
    d.exec(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z');`);
    d.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, workflow_mode, spec_body, commit_sha, repo, verification, created_at, updated_at)
       VALUES (1, 1, ?, ?, 'task 1', 'd', ?, ?, '## body', ?, 'repo', ?, '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`,
    ).run(
      TASK_BRANCH,
      task.parent === undefined ? FEATURE : task.parent,
      task.status ?? 'closed',
      task.workflowMode === undefined ? 'agile' : task.workflowMode,
      commit,
      task.verification ?? PASSING,
    );
    d.prepare(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, ?, 'bro', 'review_queued', 'q', ?, '2026-11-16T01:00:00.000Z')`,
    ).run(TASK_BRANCH, JSON.stringify({ task_id: 1, commit_sha: commit }));
  } finally {
    d.close();
  }
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: repo };
  delete env.TMB_VERIFICATION_TIMEOUT_S;
  delete env.TMB_VERIFICATION_TAIL_CHARS;
  return env;
}

function featureMerge(...args: string[]): Run {
  const argv = args.length === 0 ? ['1'] : args;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'feature-merge', ...argv], {
    cwd: repo,
    encoding: 'utf8',
    env: cliEnv(),
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout.replace(/\n+$/, ''), err: r.stderr };
}

function queued(): string {
  return q(`SELECT ${AGILE_QUEUED_SQL} FROM tasks t WHERE t.id = 1`);
}

function mergedRows(): string {
  return q("SELECT COUNT(*) FROM audit WHERE event_type = 'feature_branch_merged'");
}

/** The refs and DB state a refused run must leave as it found them. */
function snapshot(): string {
  return JSON.stringify({
    feature: rev(`refs/heads/${FEATURE}`),
    task: rev(`refs/heads/${TASK_BRANCH}`),
    task_row: q('SELECT status, commit_sha, updated_at FROM tasks WHERE id = 1'),
    audit: q('SELECT id, event_type, content_json FROM audit ORDER BY id'),
  });
}

function assertNoTempWorktree(): void {
  const dir = join(repo, '.claude/worktrees');
  const left = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('feature-merge-')) : [];
  assert.deepEqual(left, [], 'feature-merge-* dirs left behind');
}

afterEach(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
  repo = '';
});

describe('cli.js feature-merge', () => {
  it('SC1: the feature tip is an ancestor of the task commit → fast-forward, print it, exit 0', () => {
    setup('none');
    const r = featureMerge();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, commit, 'stdout is only the new feature tip');
    assert.equal(rev(`refs/heads/${FEATURE}`), commit, 'feat/agile fast-forwarded to commit_sha');
    assert.equal(rev(`refs/heads/${TASK_BRANCH}`), '', 'the task branch is deleted');
    assert.doesNotMatch(r.err, /left in place/);
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), commit, 'tasks.commit_sha is untouched');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'no verification run for a fast-forward');
    assert.ok(Number(mergedRows()) > 0, 'feature_branch_merged rows after a fast-forward run');
    assert.deepEqual(
      JSON.parse(q("SELECT content_json FROM audit WHERE event_type = 'feature_branch_merged'")),
      { task_id: 1, feature_branch: FEATURE, commit_sha: commit, rebased: false },
    );
    assert.equal(
      q("SELECT issue_id || '|' || branch_id || '|' || from_node FROM audit WHERE event_type = 'feature_branch_merged'"),
      `1|${TASK_BRANCH}|bro`,
      'the row is bro-authored and filed on the task',
    );
    assert.equal(git('reflog', '-1', '--format=%gs', `refs/heads/${FEATURE}`), `cli.js feature-merge: task 1 into ${FEATURE}`);
    assert.equal(queued(), '1', 'the task stays queued at its commit');
  });

  it('SC2: the feature branch moved → rebase, verify, move the feature branch and the task, delete the task branch, queue the new SHA, exit 0', () => {
    setup('clean');
    const featureTip = rev(`refs/heads/${FEATURE}`);
    const r = featureMerge();
    assert.equal(r.code, 0, r.err);
    const next = r.out;
    assert.match(next, /^[0-9a-f]{40}$/, 'stdout is only the new feature tip');
    assert.notEqual(next, commit);
    assert.equal(rev(`${next}^`), featureTip, "the rebased commit's parent is the old feature tip");
    assert.equal(rev(`refs/heads/${FEATURE}`), next, 'feat/agile fast-forwarded to the rebased SHA');
    assert.equal(rev(`refs/heads/${TASK_BRANCH}`), '', 'the task branch is deleted');
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), next, 'tasks.commit_sha names the rebased SHA');
    assert.equal(
      q(`SELECT task_id || '|' || source || '|' || exit_code || '|' || timed_out FROM verification_runs WHERE commit_sha = '${next}'`),
      '1|manual|0|0',
      'one passing manual run on the rebased SHA',
    );
    assert.deepEqual(
      JSON.parse(q(`SELECT content_json FROM audit WHERE event_type = 'review_queued' AND from_node = 'bro' AND json_extract(content_json, '$.commit_sha') = '${next}'`)),
      { task_id: 1, commit_sha: next },
      'a bro review_queued row names the rebased SHA',
    );
    assert.equal(queued(), '1', 'AGILE_QUEUED_SQL holds at the rebased SHA');
    assert.ok(Number(mergedRows()) > 0, 'feature_branch_merged rows after a rebase run');
    assert.deepEqual(
      JSON.parse(q("SELECT content_json FROM audit WHERE event_type = 'feature_branch_merged'")),
      { task_id: 1, feature_branch: FEATURE, commit_sha: next, rebased: true },
    );
    assert.equal(q("SELECT from_node FROM audit WHERE event_type = 'feature_branch_merged'"), 'bro');
    assert.match(r.err, /^feature-merge: feat\/agile -> [0-9a-f]{40} \(verification run #1 passed\)$/m);
    assertNoTempWorktree();
  });

  it('SC2: the task branch no longer exists → the feature branch and the task still move, the branch is not recreated', () => {
    setup('clean');
    git('branch', '-q', '-D', TASK_BRANCH);
    const r = featureMerge();
    assert.equal(r.code, 0, r.err);
    assert.equal(rev(`refs/heads/${FEATURE}`), r.out);
    assert.equal(rev(`refs/heads/${TASK_BRANCH}`), '', 'no task branch is created');
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), r.out);
  });

  it('SC2: a failed check → exit 1, branches and task unchanged, the failed run recorded', () => {
    setup('clean', { verification: FAILING });
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, '', 'nothing on stdout');
    assert.match(r.err, /verification failed/);
    assert.equal(snapshot(), before, 'refs, task row and audit rows unchanged');
    assert.equal(q('SELECT COUNT(*) || \'|\' || MAX(exit_code) FROM verification_runs'), '1|7', 'the failing run is recorded');
    assertNoTempWorktree();
  });

  it('SC2: a conflict → exit 2, nothing changes', () => {
    setup('conflict');
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    assert.match(r.err, /conflicted/);
    assert.equal(snapshot(), before);
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0');
    assertNoTempWorktree();
  });

  it("SC2: patch drift (the task's change already on the feature branch) → exit 2, nothing changes", () => {
    setup('same');
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /patch/);
    assert.equal(snapshot(), before);
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0');
    assertNoTempWorktree();
  });

  for (const [label, task] of [
    ['a completed task', { status: 'completed' }],
    ['a closed truest task', { workflowMode: 'truest' }],
    ['a closed task with no workflow_mode', { workflowMode: null }],
  ] as const) {
    it(`SC3: ${label} → exit 3, nothing changes`, () => {
      setup('none', task);
      const before = snapshot();
      const r = featureMerge();
      assert.equal(r.code, 3, r.err);
      assert.equal(r.out, '');
      assert.match(r.err, /not a closed agile task/);
      assert.equal(snapshot(), before);
    });
  }

  for (const [label, task, pattern] of [
    ['no parent_branch_id', { parent: null }, /no parent_branch_id/],
    ['the parent is the target branch', { parent: 'main' }, /target branch/],
    ['the parent is a protected branch', { parent: 'release' }, /protected branch/],
    ['the feature ref is missing', { parent: 'feat/gone' }, /does not exist/],
    ['no verification[]', { verification: '[]' }, /no verification\[\]/],
  ] as const) {
    it(`SC3: ${label} → exit 4, nothing changes`, () => {
      setup('none', task);
      git('branch', 'release', 'main');
      const before = snapshot();
      const r = featureMerge();
      assert.equal(r.code, 4, r.err);
      assert.equal(r.out, '');
      assert.match(r.err, pattern);
      assert.equal(snapshot(), before);
      assert.equal(mergedRows(), '0');
    });
  }

  it('SC3: the feature branch is checked out in a worktree → exit 4, nothing changes', () => {
    setup('none');
    git('worktree', 'add', '-q', join(repo, '.claude/worktrees/holder'), FEATURE);
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /is checked out at/);
    assert.equal(snapshot(), before);
    assert.equal(mergedRows(), '0');
  });

  it('SC3: the target branch read from the repo default when repos.target_branch is unset', () => {
    setup('none', { parent: 'main' });
    exec("UPDATE repos SET target_branch = NULL, protected_branches = '[]'");
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /target branch/);
    assert.equal(snapshot(), before);
  });

  for (const move of ['none', 'clean'] as const) {
    it(`the task branch is checked out in a worktree (${move === 'none' ? 'fast-forward' : 'rebase'}) → folded, the branch left in place with a note, exit 0`, () => {
      setup(move);
      const holder = join(repo, '.claude/worktrees/task');
      git('worktree', 'add', '-q', holder, TASK_BRANCH);
      const r = featureMerge();
      assert.equal(r.code, 0, r.err);
      assert.equal(rev(`refs/heads/${FEATURE}`), r.out, 'the feature branch is at the printed SHA');
      assert.equal(rev(`refs/heads/${TASK_BRANCH}`), commit, 'the held task branch is left at its commit');
      assert.ok(r.err.includes(`${TASK_BRANCH} is checked out at ${holder}, so it is left in place`), r.err);
      assert.equal(mergedRows(), '1');
    });
  }

  it('the task branch carries an unverified commit → exit 4, nothing changes', () => {
    setup('none');
    git('checkout', '-q', TASK_BRANCH);
    commitFile('b.txt', 'unreviewed');
    git('checkout', '-q', 'main');
    const before = snapshot();
    const r = featureMerge();
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /refusing to move it/);
    assert.equal(snapshot(), before);
    assert.equal(mergedRows(), '0');
  });

  for (const move of ['none', 'clean'] as const) {
    it(`a failed merge record (${move === 'none' ? 'fast-forward' : 'rebase'}) → the refs move back, exit 4`, () => {
      setup(move);
      exec(`CREATE TRIGGER refuse_merged BEFORE INSERT ON audit WHEN NEW.event_type = 'feature_branch_merged'
              BEGIN SELECT RAISE(ABORT, 'refused'); END;`);
      const before = snapshot();
      const r = featureMerge();
      assert.equal(r.code, 4, r.err);
      assert.equal(r.out, '');
      assert.match(r.err, /recording the merge of task 1 failed; the refs are moved back/);
      assert.equal(snapshot(), before, 'refs, task row and audit rows unchanged');
      assertNoTempWorktree();
    });
  }

  it('usage errors exit 4', () => {
    setup('none');
    assert.equal(featureMerge('1', '2').code, 4);
    assert.equal(featureMerge('x').code, 4);
    assert.equal(featureMerge('9').code, 4);
    assert.equal(mergedRows(), '0');
  });
});
