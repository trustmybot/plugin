/**
 * `cli.js pre-push` (GH 3281 S1): the push gate at git's own pre-push hook,
 * driven through real `git push`es to a bare origin.
 *
 * Each case builds a temp repo `work` whose .git/hooks/pre-push records git's
 * stdin and pipes it to the built bundle's `pre-push`, plus a trajectory DB
 * whose repos row names main as the target and main and release as protected.
 * An agent push carries CLAUDECODE=1; the Human's carries neither CLAUDECODE
 * nor CLAUDE_CODE_SESSION_ID and points TRAJECTORY_DB_PATH at a corrupt file,
 * so it only passes when the gate never reads the DB.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.TRAJECTORY_DB_PATH;
  return env;
}
const GIT_ENV = baseEnv();

type Pusher = 'agent' | 'session' | 'human';

interface Push {
  code: number | null;
  err: string;
}

let root = '';
let work = '';
let origin = '';
let db = '';
let stdinLog = '';
let clock = 0;

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}

function commit(file: string, content = file): string {
  writeFileSync(join(work, file), `${content}\n`);
  gitIn(work, 'add', file);
  gitIn(work, 'commit', '-qm', `feat: ${file}`);
  return gitIn(work, 'rev-parse', 'HEAD');
}

function remoteSha(ref: string): string {
  const r = spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** A strictly later created_at on every call. */
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 1, 0, 0, clock)).toISOString();
}

function sql(text: string, ...params: (string | number | null)[]): void {
  const d = new DatabaseSync(db);
  try {
    d.prepare(text).run(...params);
  } finally {
    d.close();
  }
}

function addTask(id: number, branch: string, commitSha: string, opts: { workflowMode?: string; parent?: string } = {}): void {
  const now = at();
  sql(
    `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, commit_sha, repo, workflow_mode, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, 'd', 'closed', ?, 'work', ?, ?, ?)`,
    id, branch, opts.parent ?? null, `task ${id}`, commitSha, opts.workflowMode ?? null, now, now,
  );
}

function addVerdict(taskId: number, verdict: 'pass' | 'fail', reviewedSha: string | null): void {
  sql(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, reviewed_sha, created_at)
     VALUES (?, (SELECT COUNT(*) + 1 FROM validation_attempts WHERE task_id = ?), 'code-reviewer', ?, 1, 'f', ?, ?)`,
    taskId, taskId, verdict, reviewedSha, at(),
  );
}

function addAudit(eventType: string, fromNode: string, content: object): void {
  sql(
    `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (1, 'b', ?, ?, 's', ?, ?)`,
    fromNode, eventType, JSON.stringify(content), at(),
  );
}

function setup(): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-pre-push-')));
  work = join(root, 'work');
  origin = join(root, 'origin.git');
  stdinLog = join(root, 'hook-stdin.log');
  clock = 0;
  mkdirSync(work);
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  gitIn(work, 'init', '-q', '-b', 'main');
  commit('README.md', 'init');
  gitIn(work, 'remote', 'add', 'origin', origin);
  gitIn(work, 'push', '-qu', 'origin', 'main');

  const hook = join(work, '.git/hooks/pre-push');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\ntee -a '${stdinLog}' | '${process.execPath}' --experimental-sqlite '${CLI}' pre-push "$@"\n`);
  chmodSync(hook, 0o755);

  db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    d.prepare(
      `INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('work', ?, 'main', 'github-flow', '["main","release"]')`,
    ).run(work);
    d.exec(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');`);
  } finally {
    d.close();
  }
}

function push(pusher: Pusher, ...args: string[]): Push {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV };
  if (pusher === 'human') {
    const corrupt = join(root, 'corrupt.db');
    writeFileSync(corrupt, 'not a sqlite file');
    env.TRAJECTORY_DB_PATH = corrupt;
  } else {
    env.TRAJECTORY_DB_PATH = db;
    if (pusher === 'agent') env.CLAUDECODE = '1';
    else env.CLAUDE_CODE_SESSION_ID = 'session-1';
  }
  const r = spawnSync('git', ['-C', work, 'push', ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, err: r.stderr };
}

function assertAdmitted(r: Push): void {
  assert.equal(r.code, 0, r.err);
}

function assertDenied(r: Push, ...phrases: string[]): void {
  assert.notEqual(r.code, 0, 'the push went through');
  assert.match(r.err, /BLOCKED: pre-push gate/);
  for (const phrase of phrases) assert.ok(r.err.includes(phrase), `stderr names "${phrase}":\n${r.err}`);
}

/** A task branch cut from main with one commit of <file>, left checked out. */
function taskBranch(branch: string, file: string): string {
  gitIn(work, 'checkout', '-q', '-b', branch, 'main');
  return commit(file);
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('pre-push gate: task branches by net diff', () => {
  it('SC1: GH 3227 replay — a reviewed branch rebased onto a base that merged the stack under its old tip force-pushes', () => {
    setup();
    gitIn(work, 'checkout', '-q', '-b', 'wave', 'main');
    commit('a1.txt');
    commit('a2.txt');
    gitIn(work, 'checkout', '-q', '-b', 'fix/t1');
    const oldTip = commit('c.txt');
    assertAdmitted(push('human', 'origin', 'fix/t1'));
    addTask(1, 'fix/t1', oldTip);
    addVerdict(1, 'pass', oldTip);

    gitIn(work, 'checkout', '-q', 'main');
    gitIn(work, 'merge', '-q', '--no-ff', '-m', 'merge wave', 'wave');
    commit('d.txt');
    assertAdmitted(push('human', 'origin', 'main'));
    gitIn(work, 'rebase', '-q', 'main', 'fix/t1');
    const newTip = gitIn(work, 'rev-parse', 'HEAD');
    assert.notEqual(newTip, oldTip);
    sql('UPDATE tasks SET commit_sha = ? WHERE id = 1', newTip);

    assertAdmitted(push('agent', '-f', 'origin', 'fix/t1'));
    assert.equal(remoteSha('refs/heads/fix/t1'), newTip);
  });

  it('SC2: GH 3187 replay — a retry holding its failed task\'s rebased commit pushes on its own pass', () => {
    setup();
    const failed = taskBranch('fix/a', 'f.txt');
    addTask(11, 'fix/a', failed);
    addVerdict(11, 'fail', failed);
    gitIn(work, 'checkout', '-q', '-b', 'fix/b', 'main');
    commit('main-moves.txt');
    gitIn(work, 'cherry-pick', failed);
    const retryTip = commit('g.txt');
    addTask(23, 'fix/b', retryTip);
    addVerdict(23, 'pass', retryTip);

    assertAdmitted(push('agent', '-u', 'origin', 'fix/b'));
    assert.equal(remoteSha('refs/heads/fix/b'), retryTip);
  });

  it('SC2: the same commits under a branch no task owns are judged per held task, and the failed one denies', () => {
    setup();
    const failed = taskBranch('fix/a', 'f.txt');
    addTask(11, 'fix/a', failed);
    addVerdict(11, 'fail', failed);
    gitIn(work, 'checkout', '-q', '-b', 'fix/b', 'main');
    gitIn(work, 'cherry-pick', failed);
    const retryTip = commit('g.txt');
    addTask(23, 'fix/b', retryTip);
    addVerdict(23, 'pass', retryTip);

    assertDenied(push('agent', 'origin', 'fix/b:refs/heads/carry'), 'task 11 (fix/a)', 'newest verdict is fail');
    assert.equal(remoteSha('refs/heads/carry'), '');
  });

  it('SC3: a FAIL after the pass denies, naming the task', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addVerdict(5, 'pass', tip);
    addVerdict(5, 'fail', tip);
    assertDenied(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'newest verdict is fail');
    assert.equal(remoteSha('refs/heads/fix/x'), '');
    assertAdmitted(push('human', 'origin', 'fix/x'));
  });

  it('SC3: a pass that reviewed a different net diff denies', () => {
    setup();
    const reviewed = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', reviewed);
    addVerdict(5, 'pass', reviewed);
    commit('unreviewed.txt');
    assertDenied(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', `reviewed ${reviewed.slice(0, 12)}`);
    assertAdmitted(push('human', 'origin', 'fix/x'));
  });

  it('SC3: a non-carrying task_integrated row newer than the pass denies; a pass after it admits', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addVerdict(5, 'pass', tip);
    addAudit('task_integrated', 'hook:integrate', { task_id: 5, rebased_from: tip, commit_sha: tip, base: 'main', run_id: 1, carried: false });
    assertDenied(push('session', 'origin', 'fix/x'), 'task 5 (fix/x)', 'did not carry');
    assertAdmitted(push('human', 'origin', 'fix/x'));
    gitIn(work, 'push', '-q', 'origin', '--delete', 'fix/x');

    addVerdict(5, 'pass', tip);
    assertAdmitted(push('agent', 'origin', 'fix/x'));
  });

  it('SC3: a push to a protected branch denies, a new branch or a delete alike', () => {
    setup();
    commit('direct.txt');
    assertDenied(push('agent', 'origin', 'main'), 'refs/heads/main is a protected branch');
    assertDenied(push('agent', 'origin', 'main:release'), 'refs/heads/release is a protected branch');
    assert.equal(remoteSha('refs/heads/release'), '');
    gitIn(work, 'push', '-q', 'origin', 'main~1:refs/heads/release');
    assertDenied(push('agent', 'origin', '--delete', 'release'), 'refs/heads/release is a protected branch');
    assert.notEqual(remoteSha('refs/heads/release'), '');
    assertAdmitted(push('human', 'origin', 'main'));
  });

  it('a pass with no reviewed_sha falls back to HAS_PASS_SQL with commit_sha the tip', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addAudit('review_handoff', 'bro', { task_id: 5, commit_sha: tip });
    addVerdict(5, 'pass', null);
    commit('later.txt');
    assertDenied(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'names no reviewed commit');
    gitIn(work, 'reset', '-q', '--hard', tip);
    assertAdmitted(push('agent', 'origin', 'fix/x'));
  });

  it('a task with no verdict denies', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    assertDenied(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'no review verdict');
  });
});

describe('pre-push gate: other refs', () => {
  it('an agile feature branch is admitted as a backup', () => {
    setup();
    const tip = taskBranch('feat/milestone', 'm.txt');
    addTask(7, 'feat/t7', tip, { workflowMode: 'agile', parent: 'feat/milestone' });
    assertAdmitted(push('agent', 'origin', 'feat/milestone'));
  });

  it('a branch no task owns and holding no task commit is admitted; deleting it too', () => {
    setup();
    taskBranch('spike', 's.txt');
    assertAdmitted(push('agent', 'origin', 'spike'));
    assertAdmitted(push('agent', 'origin', '--delete', 'spike'));
    assert.equal(remoteSha('refs/heads/spike'), '');
  });

  it('an unreadable DB denies an agent push (fail closed)', () => {
    setup();
    taskBranch('spike', 's.txt');
    writeFileSync(db, 'corrupt');
    assertDenied(push('agent', 'origin', 'spike'), 'did not read');
  });
});

describe('pre-push gate: the Human and git\'s contract', () => {
  it('SC4: with neither CLAUDECODE nor CLAUDE_CODE_SESSION_ID, every deny case exits 0 without reading the DB', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addVerdict(5, 'fail', tip);
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'pre-push', 'origin', origin], {
      cwd: work,
      encoding: 'utf8',
      env: { ...GIT_ENV, TRAJECTORY_DB_PATH: join(root, 'missing.db'), PWD: work },
      input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`,
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'missing.db')), false, 'no DB was created');
    assertAdmitted(push('human', 'origin', 'fix/x', 'main', 'fix/x:refs/heads/release'));
  });

  it('SC5: git hands the hook one stdin line per ref, and one denied ref stops the whole push', () => {
    setup();
    taskBranch('spike', 's.txt');
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    const r = push('agent', 'origin', 'spike', 'fix/x');
    assertDenied(r, 'task 5 (fix/x)');
    const lines = readFileSync(stdinLog, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.deepEqual(lines.map((line) => line.split(' ')[2]).sort(), ['refs/heads/fix/x', 'refs/heads/spike']);
    assert.equal(remoteSha('refs/heads/spike'), '', 'git pushed no ref');
    assert.equal(remoteSha('refs/heads/fix/x'), '');
  });

  it('SC5: a malformed stdin line denies an agent push', () => {
    setup();
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'pre-push', 'origin', origin], {
      cwd: work,
      encoding: 'utf8',
      env: { ...GIT_ENV, TRAJECTORY_DB_PATH: db, CLAUDECODE: '1', PWD: work },
      input: 'refs/heads/main\n',
      timeout: 60_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLOCKED: pre-push gate, push to origin: git handed the hook a line/);
  });
});
