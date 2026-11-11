/**
 * `cli.js integrate` (GH 1518, GH 1692), ported with every assertion of the
 * former integrate-script L3 suite: bro's post-review rebase of a task's
 * branch in a temporary worktree.
 *
 * Each case builds a temp repo (main + the task branch feat/x-1) and a
 * trajectory DB holding task 1 with a passing review for its commit_sha, then
 * runs `cli.js integrate 1 <base>` against the built bundle and checks the exit
 * code, the SHA it prints, the branch ref, the verification_runs rows and that
 * no temporary worktree is left.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gitGuards } from '../hooks/git-guards.js';
import { installRoot } from '../hooks/lib/project-env.js';
import { HAS_PASS_SQL } from '../review-sql.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const PASSING = '["test -f a.txt", "test -f m.txt"]';
const FAILING = '["test -f a.txt", "echo broken; exit 7"]';
// The second command runs in the temp worktree <repo>/.claude/worktrees/integrate-1.*,
// so ../../tmb is <repo>/.claude/tmb.
const SLOW = '["test -f a.txt", "touch ../../tmb/cmd-started; sleep 2"]';
const NODE_MODULES_PASSING = '["test -f node_modules/marker", "test -f pkg/node_modules/marker", "test ! -e other/node_modules"]';
const NODE_MODULES_FAILING = '["test -f node_modules/marker", "test -f pkg/node_modules/marker", "exit 5"]';

const L4_PASSING ='["grep -q l4-task src/s.txt"]';

interface Run {
  code: number | null;
  out: string;
  err: string;
}

let repo = '';
let db = '';
let base0 = '';
let commit = '';

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}

function rev(ref: string): string {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8', env: GIT_ENV });
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
    const rows = d.prepare(sql).all() as Record<string, unknown>[];
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

function pointTaskAt(sha: string): void {
  exec(`UPDATE tasks SET commit_sha = '${sha}';
        UPDATE audit SET content_json = '{"task_id":1,"commit_sha":"${sha}"}';`);
}

type Move = 'none' | 'clean' | 'conflict' | 'same';

// main gets README (base0); feat/x-1 adds a.txt (commit); then main moves:
//   clean    — m.txt
//   conflict — a.txt with other content
//   same     — the task's exact a.txt change (a rebase drops the task commit)
function setup(move: Move, verification = PASSING): void {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-integrate-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  commitFile('README.md', 'init');
  base0 = rev('HEAD');
  git('checkout', '-q', '-b', 'feat/x-1');
  commitFile('a.txt', 'task');
  commit = rev('HEAD');
  git('checkout', '-q', 'main');
  if (move === 'clean') commitFile('m.txt', 'moved');
  if (move === 'conflict') commitFile('a.txt', 'other');
  if (move === 'same') commitFile('a.txt', 'task', 'chore: land a.txt on main');

  db = join(repo, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    d.prepare(
      `INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('repo', ?, 'main', 'github-flow', '["main"]')`,
    ).run(repo);
    d.exec(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');`);
    d.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, verification, created_at, updated_at)
       VALUES (1, 1, 'feat/x-1', 'task 1', 'd', 'closed', '## body', ?, 'repo', ?, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')`,
    ).run(commit, verification);
    d.prepare(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'v', ?, '2026-10-19T01:00:00.000Z')`,
    ).run(JSON.stringify({ task_id: 1, commit_sha: commit }));
    d.exec(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES (1, 1, 'code-reviewer', 'pass', 1, 'LGTM', '2026-10-19T02:00:00.000Z');`);
  } finally {
    d.close();
  }
}

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: repo };
  delete env.TMB_VERIFICATION_TIMEOUT_S;
  delete env.TMB_VERIFICATION_TAIL_CHARS;
  return { ...env, ...extra };
}

function integrate(base: string, extra: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'integrate', '1', base], { cwd: repo, encoding: 'utf8', env: cliEnv(extra) });
  return { code: r.status, out: r.stdout.replace(/\n+$/, ''), err: r.stderr };
}

function assertNotIntegrated(): void {
  assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), commit, 'tasks.commit_sha keeps the reviewed commit');
  assert.equal(q("SELECT COUNT(*) FROM audit WHERE event_type = 'task_integrated'"), '0', 'task_integrated rows');
}

function hasPass(): string {
  return q(`SELECT ${HAS_PASS_SQL} FROM tasks t WHERE t.id = 1`);
}

function recordPass(at: string): void {
  exec(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
    VALUES (1, (SELECT MAX(attempt_n) + 1 FROM validation_attempts WHERE task_id = 1), 'code-reviewer', 'pass', 1, 'LGTM', '${at}');`);
}

function assertNoTempWorktree(): void {
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'worktrees after the run');
  const dir = join(repo, '.claude/worktrees');
  const left = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('integrate-')) : [];
  assert.deepEqual(left, [], 'integrate-* dirs left behind');
}

afterEach(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
  repo = '';
});

describe('cli.js integrate', () => {
  it('clean rebase: records a passing manual run on the new SHA and moves the branch', () => {
    setup('clean');
    const r = integrate('main');
    assert.equal(r.code, 0, r.err);
    const next = r.out;
    assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
    assert.equal(rev(`${next}^`), rev('main'), "the rebased commit's parent is main");
    assert.notEqual(next, commit, 'the printed SHA is the original commit');
    assert.equal(q(`SELECT COUNT(*) FROM verification_runs WHERE commit_sha = '${next}'`), '1', 'verification_runs rows for the new SHA');
    assert.equal(
      q(`SELECT task_id || '|' || source || '|' || exit_code || '|' || timed_out FROM verification_runs WHERE commit_sha = '${next}'`),
      '1|manual|0|0',
      'the run row',
    );
    assert.equal(
      q(`SELECT COUNT(*) FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.commit_sha = '${next}' AND c.exit_code = 0`),
      '2',
      'both commands recorded as passing',
    );
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), next, 'tasks.commit_sha names the rebased commit');
    assert.deepEqual(
      JSON.parse(q("SELECT content_json FROM audit WHERE event_type = 'task_integrated'")),
      { task_id: 1, reviewed_sha: commit, review_anchor_at: '2026-10-19T01:00:00.000Z', commit_sha: next, base: 'main', run_id: 1 },
      'one task_integrated row naming the reviewed and rebased SHAs',
    );
    assert.equal(
      q("SELECT issue_id || '|' || branch_id || '|' || from_node FROM audit WHERE event_type = 'task_integrated'"),
      '1|feat/x-1|hook:integrate',
      'the task_integrated row is filed on the task',
    );
    assert.match(r.err, /^integrate: feat\/x-1 -> [0-9a-f]{40} \(verification run #1 passed\)$/m);
    assert.equal(git('reflog', '-1', '--format=%gs', 'refs/heads/feat/x-1'), 'cli.js integrate: task 1 onto main', 'the reflog names the subcommand');
    assertNoTempWorktree();
  });

  it('conflict: exit 2, branch and verification_runs unchanged', () => {
    setup('conflict');
    const r = integrate('main');
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '', 'nothing on stdout');
    assert.match(r.err, /conflicted/, 'stderr names the conflict');
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  it("patch drift: the task's change already on main → exit 2, nothing recorded", () => {
    setup('same');
    const r = integrate('main');
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /patch/, 'stderr names the patch-id mismatch');
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  it('stacked on a squash-merged parent branch: not drift, exit 0 (GH 1666)', () => {
    setup('none');
    git('branch', '-q', '-D', 'feat/x-1');
    git('checkout', '-q', '-b', 'feat/parent');
    commitFile('p.txt', 'parent');
    git('checkout', '-q', '-b', 'feat/x-1');
    commitFile('a.txt', 'task');
    commit = rev('HEAD');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feat/parent');
    git('commit', '-qm', 'feat: parent (squash)');
    commitFile('m.txt', 'moved');
    pointTaskAt(commit);

    const r = integrate('main');
    assert.equal(r.code, 0, r.err);
    const next = r.out;
    assert.equal(rev(`${next}^`), rev('main'), "the rebased commit's parent is main");
    assert.equal(git('diff', `${next}^`, next, '--name-only'), 'a.txt', 'the rebased commit changes only a.txt');
    assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 tip');
    assert.equal(
      q(`SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE commit_sha = '${next}'`),
      '1|manual|0',
      'a passing manual run on the printed SHA',
    );
    assertNoTempWorktree();
  });

  for (const [cap, want] of [
    ['10', 'abcdefghij'],
    ['0', '0123456789abcdefghij'],
  ] as const) {
    it(`TMB_VERIFICATION_TAIL_CHARS=${cap}: the command's output_tail is cut by the shared rule (GH 1405)`, () => {
      setup('clean', '["test -f a.txt", "printf 0123456789abcdefghij"]');
      const r = integrate('main', { TMB_VERIFICATION_TAIL_CHARS: cap, LC_ALL: 'C' });
      assert.equal(r.code, 0, r.err);
      assert.equal(q(`SELECT source FROM verification_runs WHERE commit_sha = '${r.out}'`), 'manual', 'the run row is a manual run');
      assert.equal(q('SELECT output_tail FROM verification_run_commands WHERE ordinal = 2'), want, cap === '0' ? '0 means no cut' : 'last 10 characters kept');
    });
  }

  it('failing verification: exit 1, the failing run is recorded, branch unmoved', () => {
    setup('clean', FAILING);
    const r = integrate('main');
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, '', 'nothing on stdout');
    assert.ok(r.err.includes('echo broken; exit 7'), 'stderr names the failing command');
    assert.match(r.err, /^broken$/m, "stderr carries the command's output tail");
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(
      q(`SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE task_id = 1 AND commit_sha <> '${commit}'`),
      '1|manual|7',
      'one failing manual run on the rebased SHA',
    );
    assert.equal(q('SELECT exit_code FROM verification_run_commands WHERE ordinal = 2'), '7', "the failing command's row");
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  for (const [signal, want] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    it(`${signal} during a verification command: exit ${want}, the run finished as ${want}, temp worktree removed (GH 1814)`, async () => {
      setup('clean', SLOW);
      const child = spawn(process.execPath, ['--experimental-sqlite', CLI, 'integrate', '1', 'main'], { cwd: repo, env: cliEnv(), stdio: 'ignore' });
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      const started = join(repo, '.claude/tmb/cmd-started');
      for (let i = 0; i < 100 && !existsSync(started); i += 1) await new Promise((done) => setTimeout(done, 100));
      child.kill(signal);
      assert.equal(await exited, want, 'integrate exit');
      assert.equal(
        q("SELECT COUNT(*) || '|' || MAX(exit_code) || '|' || MAX(timed_out) || '|' || MIN(finished_at IS NOT NULL) FROM verification_runs"),
        `1|${want}|0|1`,
        "the run row is finished with the signal's exit code",
      );
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assertNotIntegrated();
      assertNoTempWorktree();
    });
  }

  it('no review: exit 3, nothing touched', () => {
    setup('clean');
    exec('DELETE FROM validation_attempts;');
    const r = integrate('main');
    assert.equal(r.code, 3, r.err);
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  it('a pass verdict for an earlier commit is no review of this one: exit 3', () => {
    setup('clean');
    exec(`UPDATE audit SET content_json = '{"task_id":1,"commit_sha":"${base0}"}';`);
    const r = integrate('main');
    assert.equal(r.code, 3, r.err);
    assert.equal(r.err, `integrate: task 1 has no passing code-reviewer verdict for commit ${commit}\n`);
  });

  it('base not moved: prints the original SHA, records nothing', () => {
    setup('none');
    const r = integrate('main');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, commit, 'printed SHA');
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  it('branch checked out in a worktree: exit 4 before any rebase', () => {
    setup('clean');
    git('worktree', 'add', '-q', join(repo, '.claude/worktrees/x-1'), 'feat/x-1');
    const r = integrate('main');
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /checked out at/, 'stderr names the holder');
    assert.match(r.err, /run cli\.js integrate again/, 'stderr names the subcommand to rerun');
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
    assertNotIntegrated();
  });

  it('the reviewed pass carries to the integrated head and across a second integrate (GH 2082)', () => {
    setup('clean');
    assert.equal(hasPass(), '1', 'the reviewed commit has a pass before any integration');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), first.out, 'tasks.commit_sha names the integrated head');
    assert.equal(hasPass(), '1', 'the carried anchor lets the reviewed pass cover the integrated head');
    assert.equal(
      q("SELECT json_extract(content_json, '$.review_anchor_at') FROM audit WHERE event_type = 'task_integrated'"),
      '2026-10-19T01:00:00.000Z',
      "the task_integrated row carries the reviewed commit's anchor",
    );

    commitFile('n.txt', 'again');
    const again = integrate('main');
    assert.equal(again.code, 0, again.err);
    assert.notEqual(again.out, first.out, 'the second integrate rebased the integrated head');
    assert.equal(hasPass(), '1', 'the pass still covers the rebase of the rebase');
    assert.equal(
      q("SELECT group_concat(json_extract(content_json, '$.review_anchor_at'), ',') FROM audit WHERE event_type = 'task_integrated'"),
      '2026-10-19T01:00:00.000Z,2026-10-19T01:00:00.000Z',
      'a chain of integrates collapses to the first review anchor',
    );
    assert.equal(q('SELECT COUNT(*) FROM validation_attempts'), '1', 'no new review was recorded');
  });

  it('a legacy task_integrated row (no review_anchor_at) takes the anchor of its reviewed_sha (GH 2546)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec("UPDATE audit SET content_json = json_remove(content_json, '$.review_anchor_at') WHERE event_type = 'task_integrated';");
    assert.equal(hasPass(), '1', "a legacy row carries the reviewed commit's bro_verification_pass anchor");
    commitFile('n.txt', 'again');
    const again = integrate('main');
    assert.equal(again.code, 0, again.err);
    assert.equal(
      q("SELECT json_extract(content_json, '$.review_anchor_at') FROM audit WHERE event_type = 'task_integrated' ORDER BY id DESC LIMIT 1"),
      '2026-10-19T01:00:00.000Z',
      'an integrate after a legacy row writes the anchor found through it',
    );
    assert.equal(hasPass(), '1', 'the pass covers the integrate of the legacy head');
  });

  it('a chain of two legacy task_integrated rows carries the pass on the first commit to the last (GH 2546)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    commitFile('n.txt', 'again');
    const again = integrate('main');
    assert.equal(again.code, 0, again.err);
    exec("UPDATE audit SET content_json = json_remove(content_json, '$.review_anchor_at') WHERE event_type = 'task_integrated';");
    assert.equal(
      q("SELECT group_concat(json_extract(content_json, '$.reviewed_sha') || '>' || json_extract(content_json, '$.commit_sha'), ',') FROM audit WHERE event_type = 'task_integrated'"),
      `${commit}>${first.out},${first.out}>${again.out}`,
      'two chained legacy rows',
    );
    assert.equal(hasPass(), '1', 'the walk back through both rows reaches the reviewed anchor');
  });

  it('a legacy task_integrated row stays fail-closed without a carried anchor (GH 2546)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec("UPDATE audit SET content_json = json_remove(content_json, '$.review_anchor_at') WHERE event_type = 'task_integrated';");
    assert.equal(hasPass(), '1', 'the legacy row carries the pass');

    exec("UPDATE audit SET from_node = 'hook:other' WHERE event_type = 'task_integrated';");
    assert.equal(hasPass(), '0', 'a legacy row from another author anchors at its created_at');
    exec("UPDATE audit SET from_node = 'hook:integrate' WHERE event_type = 'task_integrated';");

    exec(`UPDATE audit SET content_json = json_set(content_json, '$.commit_sha', '${base0}') WHERE event_type = 'bro_verification_pass';`);
    assert.equal(hasPass(), '0', 'a reviewed_sha with no anchor row leaves the legacy row at its created_at');
    exec(`UPDATE audit SET content_json = json_set(content_json, '$.commit_sha', '${commit}') WHERE event_type = 'bro_verification_pass';`);

    exec(`UPDATE audit SET content_json = json_set(content_json, '$.task_id', 2) WHERE event_type = 'bro_verification_pass';`);
    assert.equal(hasPass(), '0', "another task's anchor on the reviewed_sha does not count");
    exec(`UPDATE audit SET content_json = json_set(content_json, '$.task_id', 1) WHERE event_type = 'bro_verification_pass';`);

    exec("UPDATE validation_attempts SET created_at = '2026-10-19T00:30:00.000Z';");
    assert.equal(hasPass(), '0', "a pass recorded before the reviewed commit's bro_verification_pass does not count");
    exec("UPDATE validation_attempts SET created_at = '2026-10-19T02:00:00.000Z';");

    exec(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES (1, 2, 'code-reviewer', 'fail', 1, 'no', '${new Date().toISOString()}');`);
    assert.equal(hasPass(), '0', 'a newer fail verdict blocks the carried pass');
  });

  it('a cycle of legacy task_integrated rows ends at the hop cap (GH 2546)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec(`UPDATE audit SET content_json = json_remove(content_json, '$.review_anchor_at') WHERE event_type = 'task_integrated';
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'hook:integrate', 'task_integrated', 'loop',
        json_object('task_id', 1, 'reviewed_sha', '${first.out}', 'commit_sha', '${commit}'), '${new Date().toISOString()}');
      UPDATE audit SET content_json = json_set(content_json, '$.commit_sha', '${base0}') WHERE event_type = 'bro_verification_pass';`);
    assert.equal(hasPass(), '0', 'a cycle with no anchor terminates and fails closed');
  });

  it('a malformed task_integrated row from hook:integrate is skipped by the legacy walk (GH 2546)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec(`UPDATE audit SET content_json = json_remove(content_json, '$.review_anchor_at') WHERE event_type = 'task_integrated';
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'hook:integrate', 'task_integrated', 'bad', '{bad', '${new Date().toISOString()}');
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'bad', '{bad', '${new Date().toISOString()}');`);
    assert.equal(hasPass(), '1', 'the legacy row still carries the pass past malformed rows');
  });

  it('a carried review_anchor_at counts only on a task_integrated row from hook:integrate (GH 2082)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec("UPDATE audit SET from_node = 'hook:other' WHERE event_type = 'task_integrated';");
    assert.equal(hasPass(), '0', 'another author cannot carry an anchor');
    exec(`DELETE FROM audit WHERE event_type = 'task_integrated';
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'v',
        json_object('task_id', 1, 'commit_sha', '${first.out}', 'review_anchor_at', '2026-10-19T01:00:00.000Z'), '${new Date().toISOString()}');`);
    assert.equal(hasPass(), '0', 'a bro_verification_pass row cannot carry an anchor');
    exec(`UPDATE audit SET from_node = 'hook:integrate', event_type = 'task_integrated',
      content_json = json_set(content_json, '$.review_anchor_at', 0) WHERE event_type = 'bro_verification_pass' AND json_extract(content_json, '$.commit_sha') = '${first.out}';`);
    assert.equal(hasPass(), '0', 'a non-text review_anchor_at is ignored');
  });

  it('a FAIL verdict after the carried pass blocks the integrated head (GH 2082)', () => {
    setup('clean');
    const first = integrate('main');
    assert.equal(first.code, 0, first.err);
    exec(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES (1, 2, 'code-reviewer', 'fail', 1, 'no', '${new Date().toISOString()}');`);
    assert.equal(hasPass(), '0', 'the newest verdict is a fail');
    commitFile('n.txt', 'again');
    const again = integrate('main');
    assert.equal(again.code, 3, again.err);
    assert.equal(rev('refs/heads/feat/x-1'), first.out, 'feat/x-1 stays at the first integration');
  });

  it('a new commit_sha with only a bro_verification_pass anchor needs a fresh review (GH 2082)', () => {
    setup('clean');
    git('checkout', '-q', 'feat/x-1');
    commitFile('b.txt', 'more');
    const next = rev('HEAD');
    git('checkout', '-q', 'main');
    exec(`UPDATE tasks SET commit_sha = '${next}' WHERE id = 1;
      INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'v', json_object('task_id', 1, 'commit_sha', '${next}'), '${new Date().toISOString()}');`);
    assert.equal(hasPass(), '0', 'the earlier pass predates the new commit anchor');
    const r = integrate('main');
    assert.equal(r.code, 3, r.err);
    assert.equal(rev('refs/heads/feat/x-1'), next, 'feat/x-1 is not moved');
  });

  it('re-integration after the integrated head is reviewed: the branch moves from it', () => {
    setup('clean');
    const first = integrate('main').out;
    recordPass(new Date(Date.now() + 1000).toISOString());
    commitFile('n.txt', 'again');
    const r = integrate('main');
    assert.equal(r.code, 0, r.err);
    assert.equal(rev('refs/heads/feat/x-1'), r.out, 'feat/x-1 tip');
    assert.notEqual(r.out, first, 'second integration printed the first SHA');
    assert.equal(rev(`${r.out}^`), rev('main'), 'the second rebase sits on main');
    assert.equal(q('SELECT commit_sha FROM tasks WHERE id = 1'), r.out, 'tasks.commit_sha names the second rebase');
    assert.equal(
      q("SELECT group_concat(json_extract(content_json, '$.reviewed_sha') || '>' || json_extract(content_json, '$.commit_sha'), ',') FROM audit WHERE event_type = 'task_integrated'"),
      `${commit}>${first},${first}>${r.out}`,
      'one task_integrated row per integration',
    );
  });

  it('task row write fails after the branch moved: exit 4 naming the rebased SHA, the task still at the reviewed one', () => {
    setup('clean');
    exec("CREATE TRIGGER block_commit_sha BEFORE UPDATE OF commit_sha ON tasks BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const r = integrate('main');
    assert.equal(r.code, 4, r.err);
    assert.equal(r.out, '', 'nothing on stdout');
    const moved = rev('refs/heads/feat/x-1');
    assert.notEqual(moved, commit, 'feat/x-1 moved to the rebased commit');
    assert.ok(r.err.includes(`moved to ${moved}`), 'stderr names the rebased SHA');
    assert.ok(r.err.includes(`still names the reviewed ${commit}`), 'stderr names the reviewed SHA the task row keeps');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  it('usage and argument errors exit 4', () => {
    setup('none');
    const cases: [string[], string][] = [
      [['1'], 'integrate: usage: cli.js integrate <task_id> <base>\n'],
      [['x', 'main'], "integrate: task_id must be a number, got 'x'\n"],
      [['1', ''], 'integrate: base is empty\n'],
      [['2', 'main'], 'integrate: no task 2\n'],
      [['1', 'nope'], `integrate: base 'nope' is not a commit in ${repo}\n`],
    ];
    for (const [args, err] of cases) {
      const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'integrate', ...args], { cwd: repo, encoding: 'utf8', env: cliEnv() });
      assert.equal(r.status, 4, args.join(' '));
      assert.equal(r.stderr, err, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
    }
  });

  describe('node_modules', () => {
    // setup, then main tracks package.json, pkg/package.json and other/package.json; the
    // main checkout holds untracked node_modules/marker and pkg/node_modules/marker, other/ has none.
    function setupNodeModules(move: Move, verification: string): void {
      setup(move, verification);
      mkdirSync(join(repo, 'pkg'));
      mkdirSync(join(repo, 'other'));
      for (const f of ['package.json', 'pkg/package.json', 'other/package.json']) writeFileSync(join(repo, f), '{}\n');
      git('add', 'package.json', 'pkg/package.json', 'other/package.json');
      git('commit', '-qm', 'chore: package manifests');
      mkdirSync(join(repo, 'node_modules'));
      mkdirSync(join(repo, 'pkg/node_modules'));
      writeFileSync(join(repo, 'node_modules/marker'), 'root-dep\n');
      writeFileSync(join(repo, 'pkg/node_modules/marker'), 'pkg-dep\n');
    }

    function assertMarkersIntact(): void {
      assert.equal(readFileSync(join(repo, 'node_modules/marker'), 'utf8'), 'root-dep\n', 'main checkout node_modules/marker');
      assert.equal(readFileSync(join(repo, 'pkg/node_modules/marker'), 'utf8'), 'pkg-dep\n', 'main checkout pkg/node_modules/marker');
    }

    it('untracked installs are linked into the worktree, clean rebase exits 0', () => {
      setupNodeModules('clean', NODE_MODULES_PASSING);
      const r = integrate('main');
      assert.equal(r.code, 0, r.err);
      assert.equal(rev('refs/heads/feat/x-1'), r.out, 'feat/x-1 tip');
      assert.equal(q('SELECT COUNT(*) FROM verification_run_commands WHERE exit_code = 0'), '3', 'all three commands passed');
      assertNoTempWorktree();
      assertMarkersIntact();
    });

    it("failing verification exits 1 and leaves the main checkout's installs", () => {
      setupNodeModules('clean', NODE_MODULES_FAILING);
      const r = integrate('main');
      assert.equal(r.code, 1, r.err);
      assert.equal(
        q("SELECT group_concat(exit_code, '|') FROM (SELECT exit_code FROM verification_run_commands ORDER BY ordinal)"),
        '0|0|5',
        'the links resolved before the failing command',
      );
      assertNoTempWorktree();
      assertMarkersIntact();
    });

    it("conflict exits 2 and leaves the main checkout's installs", () => {
      setupNodeModules('conflict', NODE_MODULES_PASSING);
      const r = integrate('main');
      assert.equal(r.code, 2, r.err);
      assertNoTempWorktree();
      assertMarkersIntact();
    });
  });

  // Worktree setup (GH 2054): main commits .config/tmb/worktree-setup.json, so the
  // rebased worktree runs it after node_modules is linked and before verification[].
  describe('worktree setup', () => {
    function setupWithSetupFile(commands: string[]): void {
      setup('clean', '["test -f setup-ran"]');
      mkdirSync(join(repo, '.config/tmb'), { recursive: true });
      writeFileSync(join(repo, '.config/tmb/worktree-setup.json'), JSON.stringify({ version: 1, commands }));
      git('add', '.config/tmb/worktree-setup.json');
      git('commit', '-qm', 'chore: worktree setup');
    }

    it('a failing setup exits 1, prints the failing command and its output tail, records nothing', () => {
      setupWithSetupFile(['echo integrate-setup-broke; exit 8']);
      const r = integrate('main');
      assert.equal(r.code, 1, r.err);
      assert.equal(r.out, '', 'nothing on stdout');
      assert.match(r.err, /worktree setup command exited 8: echo integrate-setup-broke; exit 8/);
      assert.match(r.err, /Output \(last 20 lines\):\nintegrate-setup-broke/);
      assert.match(r.err, /worktree setup failed on [0-9a-f]{40}; no verification run recorded, feat\/x-1 unmoved/);
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
      assertNoTempWorktree();
    });

    it('a failing frozen install of a task that changes the lockfile exits 1 with the command and its output, branch unmoved (GH 3003)', () => {
      setup('clean');
      git('checkout', '-q', 'feat/x-1');
      commitFile('package-lock.json', 'not json', 'feat: lockfile');
      commit = rev('HEAD');
      git('checkout', '-q', 'main');
      pointTaskAt(commit);
      const r = integrate('main');
      assert.equal(r.code, 1, r.err);
      assert.equal(r.out, '', 'nothing on stdout');
      assert.match(r.err, /frozen install failed: npm ci: exited 1\nOutput \(last 20 lines\):\n/);
      assert.match(r.err, /worktree setup failed on [0-9a-f]{40}; no verification run recorded, feat\/x-1 unmoved/);
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
      assertNoTempWorktree();
    });

    it('a passing setup runs before verification[] and is not recorded as a command', () => {
      setupWithSetupFile(['touch setup-ran']);
      const r = integrate('main');
      assert.equal(r.code, 0, r.err);
      assert.equal(q('SELECT group_concat(command, char(10)) FROM verification_run_commands'), 'test -f setup-ran');
      assertNoTempWorktree();
    });
  });

  // Patch-ids over every path (GH 2054). src/s.txt and gen/out.txt each hold
  // l1..l7; the task changes l4 of both, then main moves:
  //   drift     — l2 of src/s.txt (merges cleanly, but the task's patch context changes)
  //   gen-drift — l2 of gen/out.txt only (a generated path counts like any other)
  //   gen       — l4 of gen/out.txt (a conflict on a generated path)
  //   absorbed  — the task's own change (the rebase drops the task commit)
  describe('patch-ids and conflicts over every path', () => {
    function sevenLines(file: string, line: number, value: string): void {
      const lines = [1, 2, 3, 4, 5, 6, 7].map((i) => (i === line ? value : `l${i}`));
      writeFileSync(join(repo, file), `${lines.join('\n')}\n`);
    }

    function commitAll(msg: string): void {
      git('add', '-A', 'src', 'gen');
      git('commit', '-qm', msg);
    }

    function setupSevenLines(move: 'drift' | 'gen-drift' | 'gen' | 'absorbed'): void {
      setup('none', L4_PASSING);
      git('checkout', '-q', 'main');
      git('branch', '-q', '-D', 'feat/x-1');
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'gen'), { recursive: true });
      sevenLines('src/s.txt', 0, '');
      sevenLines('gen/out.txt', 0, '');
      commitAll('chore: seven lines');
      git('checkout', '-q', '-b', 'feat/x-1');
      sevenLines('src/s.txt', 4, 'l4-task');
      sevenLines('gen/out.txt', 4, 'l4-task');
      commitAll('feat: l4');
      commit = rev('HEAD');
      git('checkout', '-q', 'main');
      if (move === 'drift') sevenLines('src/s.txt', 2, 'l2-base');
      if (move === 'gen-drift') sevenLines('gen/out.txt', 2, 'l2-base');
      if (move === 'gen') sevenLines('gen/out.txt', 4, 'l4-base');
      if (move === 'absorbed') {
        sevenLines('src/s.txt', 4, 'l4-task');
        sevenLines('gen/out.txt', 4, 'l4-task');
      }
      commitAll(`feat: main moves (${move})`);
      pointTaskAt(commit);
    }

    function assertUnchanged(): void {
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assert.equal(q('SELECT COUNT(*) FROM verification_runs'), '0', 'verification_runs rows');
      assertNotIntegrated();
      assertNoTempWorktree();
    }

    it('source drift: exit 2, nothing recorded', () => {
      setupSevenLines('drift');
      const r = integrate('main');
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /patch/, 'stderr names the patch-id mismatch');
      assertUnchanged();
    });

    it('drift confined to a generated path is patch drift too: exit 2', () => {
      setupSevenLines('gen-drift');
      const r = integrate('main');
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /patch/, 'stderr names the patch-id mismatch');
      assertUnchanged();
    });

    it('a conflict on a generated path is a conflict: exit 2, nothing regenerated or amended', () => {
      setupSevenLines('gen');
      const r = integrate('main');
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /conflicted/, 'stderr names the conflict');
      assert.doesNotMatch(r.err, /regenerat/, 'no regen step runs');
      assertUnchanged();
    });

    it("task change already on main: exit 2, main's commit is not amended", () => {
      setupSevenLines('absorbed');
      const mainTip = rev('main');
      const r = integrate('main');
      assert.equal(r.code, 2, r.err);
      assert.equal(rev('main'), mainTip, 'main tip');
      assertUnchanged();
    });
  });

  // GH 2198: a stale local base was taken as given, so integrate printed
  // "nothing to rebase" while origin had moved past the task's base.
  describe('base resolution against a remote', () => {
    let remoteDir = '';

    afterEach(() => {
      if (remoteDir !== '') rmSync(remoteDir, { recursive: true, force: true });
      remoteDir = '';
    });

    function gitIn(dir: string, ...args: string[]): string {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.replace(/\n+$/, '');
    }

    // repo's main tracks origin/main (a bare repo), both at base0.
    function setupRemote(): { bare: string } {
      setup('none');
      remoteDir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-integrate-remote-')));
      const bare = join(remoteDir, 'origin.git');
      spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV });
      git('remote', 'add', 'origin', bare);
      git('push', '-q', '-u', 'origin', 'main');
      return { bare };
    }

    // Another clone pushes m.txt to origin/main; repo does not fetch it.
    function moveRemote(bare: string): string {
      const other = join(remoteDir, 'other');
      gitIn(remoteDir, 'clone', '-q', bare, other);
      gitIn(other, 'config', 'user.email', 'test@example.com');
      gitIn(other, 'config', 'user.name', 'Test');
      writeFileSync(join(other, 'm.txt'), 'moved\n');
      gitIn(other, 'add', 'm.txt');
      gitIn(other, 'commit', '-qm', 'feat: m.txt');
      gitIn(other, 'push', '-q', 'origin', 'main');
      return gitIn(other, 'rev-parse', 'HEAD');
    }

    it('stale local main: fetches its upstream and rebases onto it', () => {
      const { bare } = setupRemote();
      const remoteTip = moveRemote(bare);
      assert.equal(rev('main'), base0, 'local main is stale');
      const r = integrate('main');
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.err, /nothing to rebase/);
      assert.notEqual(r.out, commit, 'the printed SHA is the original commit');
      assert.equal(rev(`${r.out}^`), remoteTip, "the rebased commit's parent is the fetched origin/main");
      assert.equal(rev('refs/heads/feat/x-1'), r.out, 'feat/x-1 tip');
      assert.match(r.err, /refs\/heads\/main .*refs\/remotes\/origin\/main/, 'one line names both refs');
      assert.match(r.err, /onto origin\/main \([0-9a-f]{40}\)/, 'stderr names the upstream it rebased onto');
      assert.equal(rev('main'), base0, 'local main is not moved');
    });

    it('local main a fast-forward ahead of its upstream: rebases onto the local ref', () => {
      setupRemote();
      commitFile('m.txt', 'local');
      const localTip = rev('main');
      const r = integrate('main');
      assert.equal(r.code, 0, r.err);
      assert.equal(rev(`${r.out}^`), localTip, "the rebased commit's parent is local main");
      assert.notEqual(rev('refs/remotes/origin/main'), localTip, 'the upstream is behind');
      assert.doesNotMatch(r.err, /refs\/remotes\/origin\/main/, 'no upstream line');
    });

    it('origin/main as the base: fetched before it is resolved', () => {
      const { bare } = setupRemote();
      const remoteTip = moveRemote(bare);
      assert.equal(rev('origin/main'), base0, 'origin/main is stale before the run');
      const r = integrate('origin/main');
      assert.equal(r.code, 0, r.err);
      assert.equal(rev(`${r.out}^`), remoteTip, "the rebased commit's parent is the remote's new tip");
    });

    it('unreachable upstream: exit 4, branch and verification_runs unchanged', () => {
      setupRemote();
      git('remote', 'set-url', 'origin', join(remoteDir, 'missing.git'));
      const runs = q('SELECT COUNT(*) FROM verification_runs');
      const r = integrate('main');
      assert.equal(r.code, 4, r.err);
      assert.match(r.err, /fetch of base 'main'/, 'stderr names the base');
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assert.equal(q('SELECT COUNT(*) FROM verification_runs'), runs, 'verification_runs count');
      assertNotIntegrated();
      assertNoTempWorktree();
    });

    it('a hung fetch times out: exit 4, branch and DB unchanged (GH 2632)', () => {
      setupRemote();
      git('remote', 'set-url', 'origin', 'ssh://hang.invalid/origin.git');
      const r = integrate('main', { GIT_SSH_COMMAND: 'sleep 60;:', GIT_SSH_VARIANT: 'simple', TMB_INTEGRATE_FETCH_TIMEOUT_MS: '1000' });
      assert.equal(r.code, 4, r.err);
      assert.match(r.err, /fetch of base 'main' \(origin main\) timed out after 1000 ms/, 'stderr names the timeout');
      assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
      assertNotIntegrated();
      assertNoTempWorktree();
    });
  });

  // GH 2356: the task renames r.txt to b.txt while main renames it to c.txt, as a
  // dist regen renames a content-hashed chunk. With rename detection the rebase
  // stops on a rename/rename conflict; without it the rebase applies, and the
  // every-path patch-ids then see the dropped delete of r.txt as drift.
  it('both sides rename the same file: no rename/rename conflict (GH 2356)', () => {
    setup('none', '["test -f b.txt"]');
    git('branch', '-q', '-D', 'feat/x-1');
    commitFile('r.txt', ['one', 'two', 'three', 'four', 'five'].join('\n'), 'chore: r.txt');
    git('checkout', '-q', '-b', 'feat/x-1');
    git('mv', 'r.txt', 'b.txt');
    git('commit', '-qm', 'feat: r.txt -> b.txt');
    commit = rev('HEAD');
    git('checkout', '-q', 'main');
    git('mv', 'r.txt', 'c.txt');
    git('commit', '-qm', 'chore: r.txt -> c.txt');
    pointTaskAt(commit);
    const r = integrate('main');
    assert.equal(r.code, 2, r.err);
    assert.doesNotMatch(r.err, /conflicted|CONFLICT/, 'the rebase did not stop on a rename/rename conflict');
    assert.match(r.err, /source patches/, 'the patch-id check judged the rebased commit');
    assert.equal(rev('refs/heads/feat/x-1'), commit, 'feat/x-1 tip');
    assertNotIntegrated();
    assertNoTempWorktree();
  });

  // git-guards denies a rebase in the main checkout; the temporary worktree
  // integrate rebases in is a linked worktree, where rebase is allowed, and
  // bro's own command is a cli.js call git-guards does not judge as a rebase.
  it('git-guards: rebase in the temp worktree allowed, in the main checkout denied, bro’s call allowed', async () => {
    setup('clean');
    const wt = join(repo, '.claude/worktrees/integrate-1.abc123');
    git('worktree', 'add', '-q', '--detach', wt, commit);
    const env = { ...GIT_ENV, TRAJECTORY_DB_PATH: db, PWD: repo };
    const guard = async (command: string): Promise<string> =>
      (await gitGuards(JSON.stringify({ cwd: repo, tool_input: { command } }), env)).stdout;
    assert.doesNotMatch(await guard(`cd ${wt} && git rebase main`), /"permissionDecision":"deny"/, 'a rebase in the temporary worktree');
    const denied = await guard(`git -C ${repo} rebase main`);
    assert.match(denied, /"permissionDecision":"deny"/, 'a rebase in the main checkout');
    assert.match(denied, /main checkout/, 'the deny names the main checkout');
    assert.doesNotMatch(
      await guard(`node --experimental-sqlite "${CLI}" integrate 1 main`),
      /"permissionDecision":"deny"/,
      'bro running cli.js integrate from the main checkout',
    );
  });
});
