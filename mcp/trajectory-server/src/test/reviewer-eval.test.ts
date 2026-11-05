// The code-reviewer eval (GH 1955 item e): reviewerEval on a fixture DB and a
// throwaway git repo, and scripts/maintenance/reviewer-eval.ts on a DB opened
// read-only, including one from before review_findings had severity and class.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tempDB } from './helpers.js';
import {
  defaultRepoName,
  filesCover,
  formatReviewerEval,
  ghRefs,
  gitRunner,
  removedRanges,
  reviewerEval,
} from '../reviewer-eval.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'maintenance', 'reviewer-eval.ts');
const COMMIT_DATE = '2026-01-05T00:00:00Z';

function git(root: string, ...a: string[]): string {
  return execFileSync('git', ['-C', root, ...a], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  }).toString();
}

function makeRepo(root: string): void {
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (subject: string) => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', subject);
  };
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  write('src/a.ts', 'one\ntwo\nthree\n');
  commit('✨ add a (GH 10)');
  write('README.md', 'doc one\ndoc two\n');
  write('src/test/a.test.ts', 'test one\ntest two\n');
  write('src/b.ts', 'bee\n');
  commit('✨ add docs, tests and b (GH 20)');
  write('src/a.ts', 'one\nTWO\nthree\n');
  commit('🐛 fix two (GH 11)');
  write('src/a.ts', 'one\nTWO\nthree\nfour\n');
  commit('🐛 add four (GH 12)');
  write('README.md', 'doc one\ndoc TWO\n');
  write('src/test/a.test.ts', 'test ONE\ntest two\n');
  commit('🐛 fix docs and tests (GH 13)');
  write('src/b.ts', 'BEE\n');
  commit('🔧 touch b (GH 110)');
  write('src/a.ts', 'one\nTWO\nTHREE\nfour\n');
  commit('🐛 fix three (GH 15)');
}

const BEFORE_COMMIT = '2026-01-02T00:00:00.000Z';
const AFTER_COMMIT = '2026-01-06T00:00:00.000Z';

function seed(db: { run(sql: string, params?: unknown[]): unknown }, withSeverity: boolean): void {
  for (const name of ['repo', 'other']) db.run(`INSERT INTO repos (name, path) VALUES (?, ?)`, [name, `/${name}`]);
  const issue = (id: number, gh: number, labels: string[], createdAt: string, repo = 'repo') =>
    db.run(
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at, gh_iid, labels, repo) VALUES (?, 'o', 'd', 'open', ?, ?, ?, ?, ?)`,
      [id, createdAt, createdAt, gh, JSON.stringify(labels), repo],
    );
  issue(1, 10, ['Feature'], '2026-01-01 00:00:00');
  issue(6, 20, [], '2026-01-01 00:00:00');
  issue(2, 11, ['Bug'], '2026-01-03 00:00:00');
  issue(3, 12, ['Bug', 'Priority: Low'], '2026-01-03 00:00:00');
  issue(4, 13, ['Bug'], '2026-01-03 00:00:00');
  issue(5, 14, ['Bug'], '2026-01-03 00:00:00');
  issue(7, 15, ['Bug'], '2026-01-01 00:00:00');
  issue(8, 10, ['Feature'], '2026-01-01 00:00:00', 'other');
  const tasks: Array<[number, number, string[], string | null, string]> = [
    [101, 1, ['src/'], BEFORE_COMMIT, 'repo'],
    [102, 6, ['src/b.ts'], BEFORE_COMMIT, 'repo'],
    [103, 6, ['src/b.ts'], BEFORE_COMMIT, 'repo'],
    [104, 2, ['src/a.ts'], null, 'repo'],
    [105, 1, ['docs/'], BEFORE_COMMIT, 'repo'],
    [106, 1, ['src/'], AFTER_COMMIT, 'repo'],
    [107, 8, ['src/'], BEFORE_COMMIT, 'other'],
    [108, 1, [], BEFORE_COMMIT, 'repo'],
  ];
  for (const [id, issueId, files, completedAt, repo] of tasks) {
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, files, completed_at, repo)
       VALUES (?, ?, 'b' || ?, 'd', 'closed', '2026-01-02', '2026-01-02', ?, ?, ?)`,
      [id, issueId, id, JSON.stringify(files), completedAt, repo],
    );
  }
  const attempts: Array<[number, number, string]> = [
    [101, 1, 'pass'],
    [102, 1, 'fail'], [102, 2, 'fail'], [102, 3, 'pass'],
    [103, 1, 'pass'],
    [104, 1, 'fail'],
    [105, 1, 'pass'],
    [106, 1, 'pass'],
    [107, 1, 'pass'],
    [108, 1, 'pass'],
  ];
  for (const [task, n, verdict] of attempts) {
    db.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 'f', 1, '2026-01-02T00:00:00.000Z')`,
      [task, n, verdict],
    );
  }
  const run = (task: number, type: string, model: string | null, effort: string | null, at: string) =>
    db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, model, effort, started_at) VALUES (?, 1, ?, ?, ?, ?)`, [task, type, model, effort, at]);
  run(101, 'swe', 'haiku', 'low', '2026-01-02T00:00:00Z');
  run(101, 'code-reviewer', 'opus', 'high', '2026-01-02T01:00:00Z');
  run(101, 'tmb:code-reviewer', 'sonnet', 'low', '2026-01-02T02:00:00Z');
  run(102, 'tmb:code-reviewer', 'sonnet', null, '2026-01-02T01:00:00Z');
  const cols = withSeverity ? ', severity' : '';
  const finding = (id: string, task: number, status: string, severity: string) =>
    db.run(
      `INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, status, created_at${cols})
       VALUES (?, ?, 1, 'p', 'e', 'o', ?, '2026-01-02'${withSeverity ? ', ?' : ''})`,
      withSeverity ? [id, task, status, severity] : [id, task, status],
    );
  finding('F102-1', 102, 'fixed', 'blocking');
  finding('F102-2', 102, 'wontfix', 'nit');
  finding('F104-1', 104, 'open', 'blocking');
}

const OLD_SCHEMA = `
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
  CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT, description TEXT, status TEXT, created_at TEXT, updated_at TEXT, gh_iid INTEGER, labels TEXT, repo TEXT);
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, description TEXT, status TEXT, created_at TEXT, updated_at TEXT, files TEXT NOT NULL DEFAULT '[]', completed_at TEXT, repo TEXT);
  CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, attempt_n INTEGER, agent TEXT, verdict TEXT, feedback TEXT, mcp_available INTEGER, created_at TEXT);
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, task_id INTEGER, issue_id INTEGER, agent_type TEXT, model TEXT, effort TEXT, started_at TEXT);
  CREATE TABLE review_findings (id TEXT PRIMARY KEY, task_id INTEGER, attempt_n INTEGER, criterion_id TEXT, probe_cmd TEXT, expected TEXT, observed TEXT, status TEXT, created_at TEXT, resolved_at TEXT);
`;

const EXPECTED_LINES = [
  'first_pass=6/8 (75.0%)',
  'cycles_to_pass_mean=1.29',
  'wontfix_rate=1/3',
  'escaped_bugs=1 traced_tasks=1 untraced_bugs=2',
  'known_clean=5',
];
const EXPECTED_ARMS = [
  'arm model=opus effort=high tasks=1 first_pass=1/1 cycles_to_pass_mean=1.00 escaped=1',
  'arm model=sonnet effort=unset tasks=1 first_pass=0/1 cycles_to_pass_mean=3.00 escaped=0',
  'arm model=unset effort=unset tasks=6 first_pass=5/6 cycles_to_pass_mean=1.00 escaped=0',
];

describe('reviewerEval (GH 1955)', () => {
  let dir: string;
  let repo: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-reviewer-eval-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    makeRepo(repo);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('ghRefs matches GH n and #n with no digit after the number', () => {
    assert.deepEqual(ghRefs('🐛 fix (GH 11) (#2355)'), [11, 2355]);
    assert.deepEqual(ghRefs('touch (GH 110) GH12x'), [110, 12]);
  });

  it('removedRanges keeps removed or changed code lines and skips docs, tests, dist and changelog fragments', () => {
    const diff = [
      '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -2 +2 @@', '@@ -5,3 +5,0 @@', '@@ -9,0 +7,2 @@',
      '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@',
      '--- a/src/test/a.test.ts', '+++ b/src/test/a.test.ts', '@@ -1 +1 @@',
      '--- a/dist/x.js', '+++ b/dist/x.js', '@@ -1 +1 @@',
      '--- a/changelog.d/x.txt', '+++ b/changelog.d/x.txt', '@@ -1 +1 @@',
      '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@',
    ].join('\n');
    assert.deepEqual(removedRanges(diff), [
      { path: 'src/a.ts', start: 2, count: 1 },
      { path: 'src/a.ts', start: 5, count: 3 },
    ]);
  });

  it('filesCover matches an equal entry or a directory prefix, with or without a trailing slash', () => {
    assert.equal(filesCover(['src/'], 'src/a.ts'), true);
    assert.equal(filesCover(['src'], 'src/a.ts'), true);
    assert.equal(filesCover(['src/a.ts'], 'src/a.ts'), true);
    assert.equal(filesCover(['sr'], 'src/a.ts'), false);
    assert.equal(filesCover(['docs/'], 'src/a.ts'), false);
    assert.equal(filesCover([], 'src/a.ts'), false);
    assert.equal(filesCover([''], 'src/a.ts'), false);
  });

  it('defaultRepoName resolves a worktree to its main checkout', () => {
    const wt = join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    assert.equal(defaultRepoName(gitRunner(wt)), 'repo');
    assert.equal(defaultRepoName(gitRunner(repo)), 'repo');
  });

  it('reports first pass, cycles, wontfix, the SZZ trace, known-clean and the arms', () => {
    const db = tempDB();
    try {
      seed(db, true);
      const report = reviewerEval(db, gitRunner(repo), { base: 'main', repoName: 'repo' });
      assert.deepEqual(report.escaped, [{ gh_iid: 11, task_ids: [101] }]);
      assert.deepEqual(report.severity, { blocking: 2, nit: 1, pre_existing: 0 });
      const lines = formatReviewerEval(report).trimEnd().split('\n');
      assert.deepEqual(lines, [...EXPECTED_LINES, 'severity blocking=2 nit=1 pre_existing=0', ...EXPECTED_ARMS]);
    } finally {
      db.close();
    }
  });

  it('traces no bug or task outside the named repo', () => {
    const db = tempDB();
    try {
      seed(db, true);
      const report = reviewerEval(db, gitRunner(repo), { base: 'main', repoName: 'other' });
      assert.equal(report.escaped_bugs, 0);
      assert.equal(report.traced_tasks, 0);
      assert.equal(report.untraced_bugs, 0);
    } finally {
      db.close();
    }
  });

  describe('scripts/maintenance/reviewer-eval.ts', () => {
    let oldDb: string;

    before(() => {
      oldDb = join(dir, 'old.db');
      const raw = new DatabaseSync(oldDb);
      raw.exec(OLD_SCHEMA);
      seed({ run: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as never[])) }, false);
      raw.close();
    });

    const runScript = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

    it('runs on a DB with no severity or class column, defaults --repo-name from the checkout and prints no severity line', () => {
      const res = runScript('--db', oldDb, '--repo', repo, '--base', 'main');
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(res.stdout.trimEnd().split('\n'), [...EXPECTED_LINES, ...EXPECTED_ARMS]);
    });

    it('--repo-name limits the trace to that repo', () => {
      const res = runScript('--db', oldDb, '--repo', repo, '--base', 'main', '--repo-name', 'other');
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /^escaped_bugs=0 traced_tasks=0 untraced_bugs=0$/m);
    });

    it('--json prints the same data as one JSON object', () => {
      const res = runScript('--db', oldDb, '--repo', repo, '--base', 'main', '--json');
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout) as Record<string, unknown>;
      assert.equal(out['first_pass'], 6);
      assert.equal(out['escaped_bugs'], 1);
      assert.equal(out['severity'], null);
    });

    it('exits 2 on an unknown flag, a missing DB or a git failure', () => {
      const unknown = runScript('--bogus');
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, /^reviewer-eval: Unknown option '--bogus'$/m);
      const missing = runScript('--db', join(dir, 'absent.db'));
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /no trajectory DB at/);
      const badBase = runScript('--db', oldDb, '--repo', repo, '--base', 'no-such-ref');
      assert.equal(badBase.status, 2);
      assert.match(badBase.stderr, /^reviewer-eval: git log/m);
    });
  });
});
