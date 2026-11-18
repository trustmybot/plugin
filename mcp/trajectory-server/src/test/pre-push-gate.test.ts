/**
 * `cli.js pre-push` (GH 3281): the push gate at git's own pre-push hook,
 * driven through real `git push`es to a bare origin. Slice 2 runs it in
 * observe mode: every push exits 0, and an agent's push leaves one
 * prepush_observed row carrying the judge's verdict (legacy verdict admit).
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
  delete env.TMB_AGENT_SHELL;
  delete env.TRAJECTORY_DB_PATH;
  return env;
}
const GIT_ENV = baseEnv();

type Pusher = 'agent' | 'session' | 'human';

interface Observed {
  repo: string;
  remote: string;
  refs: { local_ref: string; local_sha: string; remote_ref: string; remote_sha: string }[];
  hook_verdict: string;
  reason: string;
  legacy_verdict: string;
  agree: boolean;
  session_id: string | null;
}

interface Push {
  code: number | null;
  err: string;
  /** The prepush_observed rows the push wrote. */
  rows: Observed[];
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

/** Every prepush_observed row, oldest first; [] when the DB is unreadable. */
function observedRows(): Observed[] {
  let d: DatabaseSync | undefined;
  try {
    d = new DatabaseSync(db, { readOnly: true });
    const rows = d.prepare("SELECT content_json FROM audit WHERE event_type = 'prepush_observed' ORDER BY id").all() as { content_json: string }[];
    return rows.map((r) => JSON.parse(r.content_json) as Observed);
  } catch {
    return [];
  } finally {
    d?.close();
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
  const before = observedRows().length;
  const r = spawnSync('git', ['-C', work, 'push', ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, err: r.stderr, rows: observedRows().slice(before) };
}

/** The push went through, and an agent's left one admit row. */
function assertAdmitted(r: Push, pusher: Pusher = 'agent'): void {
  assert.equal(r.code, 0, r.err);
  if (pusher === 'human') {
    assert.deepEqual(r.rows, [], 'the Human\'s push wrote no row');
    return;
  }
  assert.equal(r.rows.length, 1, JSON.stringify(r.rows));
  assert.equal(r.rows[0].hook_verdict, 'admit', r.rows[0].reason);
  assert.equal(r.rows[0].legacy_verdict, 'admit');
  assert.equal(r.rows[0].agree, true);
}

/** Observe mode: the push still went through, and its one row records the judge's deny naming <phrases>. */
function assertObservedDeny(r: Push, ...phrases: string[]): Observed {
  assert.equal(r.code, 0, `observe mode never blocks:\n${r.err}`);
  assert.doesNotMatch(r.err, /BLOCKED/);
  assert.equal(r.rows.length, 1, JSON.stringify(r.rows));
  const row = r.rows[0];
  assert.equal(row.hook_verdict, 'deny');
  assert.equal(row.legacy_verdict, 'admit');
  assert.equal(row.agree, false);
  assert.match(row.reason, /^BLOCKED: pre-push gate/);
  for (const phrase of phrases) assert.ok(row.reason.includes(phrase), `the reason names "${phrase}":\n${row.reason}`);
  return row;
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
    assertAdmitted(push('human', 'origin', 'fix/t1'), 'human');
    addTask(1, 'fix/t1', oldTip);
    addVerdict(1, 'pass', oldTip);

    gitIn(work, 'checkout', '-q', 'main');
    gitIn(work, 'merge', '-q', '--no-ff', '-m', 'merge wave', 'wave');
    commit('d.txt');
    assertAdmitted(push('human', 'origin', 'main'), 'human');
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

    const row = assertObservedDeny(push('agent', 'origin', 'fix/b:refs/heads/carry'), 'task 11 (fix/a)', 'newest verdict is fail');
    assert.deepEqual(row.refs.map((ref) => [ref.remote_ref, ref.local_sha]), [['refs/heads/carry', retryTip]]);
    assert.equal(remoteSha('refs/heads/carry'), retryTip, 'observe mode let the push through');
  });

  it('SC3: a FAIL after the pass denies, naming the task', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addVerdict(5, 'pass', tip);
    addVerdict(5, 'fail', tip);
    assertObservedDeny(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'newest verdict is fail');
    assert.equal(remoteSha('refs/heads/fix/x'), tip);
  });

  it('SC3: a pass that reviewed a different net diff denies', () => {
    setup();
    const reviewed = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', reviewed);
    addVerdict(5, 'pass', reviewed);
    commit('unreviewed.txt');
    assertObservedDeny(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', `reviewed ${reviewed.slice(0, 12)}`);
  });

  it('SC3: a non-carrying task_integrated row newer than the pass denies; a pass after it admits', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addVerdict(5, 'pass', tip);
    addAudit('task_integrated', 'hook:integrate', { task_id: 5, rebased_from: tip, commit_sha: tip, base: 'main', run_id: 1, carried: false });
    const row = assertObservedDeny(push('session', 'origin', 'fix/x'), 'task 5 (fix/x)', 'did not carry');
    assert.equal(row.session_id, 'session-1');
    gitIn(work, 'push', '-q', 'origin', '--delete', 'fix/x');

    addVerdict(5, 'pass', tip);
    assertAdmitted(push('agent', 'origin', 'fix/x'));
  });

  it('SC3: a push to a protected branch denies, a new branch or a delete alike', () => {
    setup();
    commit('direct.txt');
    assertObservedDeny(push('agent', 'origin', 'main'), 'refs/heads/main is a protected branch');
    assertObservedDeny(push('agent', 'origin', 'main:release'), 'refs/heads/release is a protected branch');
    assert.notEqual(remoteSha('refs/heads/release'), '');
    assertObservedDeny(push('agent', 'origin', '--delete', 'release'), 'refs/heads/release is a protected branch');
    assert.equal(remoteSha('refs/heads/release'), '');
    commit('human.txt');
    assertAdmitted(push('human', 'origin', 'main'), 'human');
  });

  it('a pass with no reviewed_sha falls back to HAS_PASS_SQL with commit_sha the tip', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    addAudit('review_handoff', 'bro', { task_id: 5, commit_sha: tip });
    addVerdict(5, 'pass', null);
    commit('later.txt');
    assertObservedDeny(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'names no reviewed commit');
    gitIn(work, 'reset', '-q', '--hard', tip);
    assertAdmitted(push('agent', '-f', 'origin', 'fix/x'));
  });

  it('a task with no verdict denies', () => {
    setup();
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    assertObservedDeny(push('agent', 'origin', 'fix/x'), 'task 5 (fix/x)', 'no review verdict');
  });

  it('SC10: an exempt repo admits what its policy would deny, a protected branch or an unreviewed task', () => {
    setup();
    sql(`UPDATE repos SET mode = 'exempt' WHERE name = 'work'`);
    commit('direct.txt');
    assertAdmitted(push('agent', 'origin', 'main'));
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    assertAdmitted(push('agent', 'origin', 'fix/x'));
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

  it('an unreadable DB lets the push through and says the row was not written', () => {
    setup();
    const tip = taskBranch('spike', 's.txt');
    writeFileSync(db, 'corrupt');
    const r = push('agent', 'origin', 'spike');
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /tmb: pre-push observe row not written/);
    assert.equal(remoteSha('refs/heads/spike'), tip);
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
    assertAdmitted(push('human', 'origin', 'fix/x', 'main', 'fix/x:refs/heads/release'), 'human');
    assert.deepEqual(observedRows(), [], 'the DB is untouched');
  });

  it('SC5: git hands the hook one stdin line per ref, and the one row lists every ref', () => {
    setup();
    const spike = taskBranch('spike', 's.txt');
    const tip = taskBranch('fix/x', 'x.txt');
    addTask(5, 'fix/x', tip);
    const row = assertObservedDeny(push('agent', 'origin', 'spike', 'fix/x'), 'task 5 (fix/x)');
    const lines = readFileSync(stdinLog, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.deepEqual(lines.map((line) => line.split(' ')[2]).sort(), ['refs/heads/fix/x', 'refs/heads/spike']);
    assert.deepEqual(row.refs.map((ref) => ref.remote_ref).sort(), ['refs/heads/fix/x', 'refs/heads/spike']);
    assert.equal(remoteSha('refs/heads/spike'), spike, 'observe mode pushed every ref');
    assert.equal(remoteSha('refs/heads/fix/x'), tip);
  });

  it('SC5: a malformed stdin line records a deny and exits 0', () => {
    setup();
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'pre-push', 'origin', origin], {
      cwd: work,
      encoding: 'utf8',
      env: { ...GIT_ENV, TRAJECTORY_DB_PATH: db, CLAUDECODE: '1', PWD: work },
      input: 'refs/heads/main\n',
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const rows = observedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hook_verdict, 'deny');
    assert.match(rows[0].reason, /BLOCKED: pre-push gate, push to origin: git handed the hook a line/);
    assert.deepEqual(rows[0].refs, []);
  });
});
