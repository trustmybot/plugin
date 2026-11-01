/**
 * Parity of the TypeScript cleanup-worktree-on-task-close and worktree-create
 * gates with their scripts/hooks/*.sh (GH 1692), over
 * tests/fixtures/hook-corpus/<gate>/. Both sides must exit alike, print the
 * same stdout and stderr byte for byte and leave every sandbox repo in the
 * same state: its worktrees, branches, HEAD, merge driver config, status and
 * .claude/worktrees listing.
 *
 * The sandbox holds three trajectory DBs. ws/.claude/tmb/trajectory.db
 * registers the repos project (target main, on feat/work), other (no target,
 * a merge=tmb-regen .gitattributes), dirty (target main, an uncommitted edit
 * that blocks checking main out) and nogit (no git repo); ws/ghost is a repo
 * no row registers, and ws itself is no repo. single/ registers the sole repo
 * solo, and gitws/ is a git repo whose DB registers none. nodb and nodb-git
 * hold no DB. Each side runs on a fresh copy of the sandbox, restored at the
 * same path so the worktrees' absolute links hold.
 *
 * A payload names the sandbox as @SANDBOX@ and the PATH without jq or without
 * the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets),
 * corpus_cwd (the hook's cwd, default ws) and corpus_expect (`empty`, or a
 * phrase of stdout and stderr) are removed before the run. A payload with
 * corpus_divergent names a divergence decision 703 or GH 2032 allows:
 * corpus_expect is then { bash, ts } and the two sides must differ. The
 * payload × locale (C, en_US.UTF-8) runs split across
 * hooks-worktree-lifecycle-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
export const GATES = ['cleanup-worktree-on-task-close', 'worktree-create'] as const;
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const COMMIT_DATE = '2026-01-01T00:00:00Z';
const REPOS = ['ws/project', 'ws/other', 'ws/dirty', 'ws/ghost', 'single/solo', 'gitws', 'nodb-git'];

const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_RUN_BUDGET_MS', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE', 'LC_COLLATE', 'TMB_KEEP_CLOSED_WORKTREES', 'TMB_KEEP_HEAD_ON_CLOSE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: COMMIT_DATE,
  GIT_COMMITTER_DATE: COMMIT_DATE,
};

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function gitState(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv() });
  return `${r.status}:${r.stdout}`;
}

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

export function initRepo(repo: string, files: Record<string, string> = { 'README.md': '# repo\n' }): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
}

/** A linked worktree of a new branch <branch> at `<repo>/.claude/worktrees/<slug>`. */
export function addWorktree(repo: string, branch: string): string {
  const path = join(repo, '.claude/worktrees', branch.slice(branch.indexOf('/') + 1));
  git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

export function trajectoryDb(path: string, rows: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'worktree lifecycle', 'open', ?, ?)").run(T1, T1);
    rows(db);
  } finally {
    db.close();
  }
}

type TaskRow = [id: number, branch: string, status: string, repo: string | null, adoptedPath?: string];

function insertTasks(db: DatabaseSync, rows: TaskRow[]): void {
  const task = db.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, commit_sha, worktree_path, worktree_adopted, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [id, branch, status, repo, adoptedPath] of rows) {
    task.run(id, branch, status, repo, `sha${id}`, adoptedPath ?? null, adoptedPath ? 1 : 0, T1, T1);
  }
}

/** A bro_verification_pass anchor on <anchorSha> and a later passing validation of <taskId>. */
function anchoredPass(db: DatabaseSync, taskId: number, anchorSha: string): void {
  db.prepare("INSERT INTO audit (issue_id, event_type, summary, content_json, created_at) VALUES (1, 'bro_verification_pass', 's', ?, ?)").run(
    JSON.stringify({ task_id: taskId, commit_sha: anchorSha }),
    T1,
  );
  db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, 1, 'pass', 1, ?)").run(taskId, T2);
}

/** The sandbox at <s>; see the file comment. */
export function buildSandbox(s: string): void {
  mkdirSync(join(s, 'home'), { recursive: true });
  mkdirSync(join(s, 'nodb'), { recursive: true });
  mkdirSync(join(s, 'ws/nogit'), { recursive: true });
  const project = join(s, 'ws/project');
  initRepo(project);
  git(project, 'branch', 'feat/work');
  const wt: Record<string, string> = {};
  for (const b of ['feat/clean-a', 'feat/clean-b', 'feat/stale-pass', 'feat/running', 'feat/adopted', 'feat/locked']) wt[b] = addWorktree(project, b);
  git(project, 'worktree', 'lock', '--reason', 'held', wt['feat/locked']);
  git(project, 'checkout', '-q', 'feat/work');

  const other = join(s, 'ws/other');
  initRepo(other, { 'README.md': '# other\n', '.gitattributes': 'dist/** merge=tmb-regen\n' });
  git(other, 'branch', 'feat/existing');
  addWorktree(other, 'feat/other-task');

  const dirty = join(s, 'ws/dirty');
  initRepo(dirty, { 'f.txt': 'main\n' });
  addWorktree(dirty, 'feat/dirty-task');
  git(dirty, 'checkout', '-q', '-b', 'feat/x');
  put(dirty, { 'f.txt': 'x\n' });
  git(dirty, 'commit', '-qam', 'x');
  put(dirty, { 'f.txt': 'local\n' });

  const ghost = join(s, 'ws/ghost');
  initRepo(ghost);
  addWorktree(ghost, 'feat/ghost-task');

  trajectoryDb(join(s, 'ws/.claude/tmb/trajectory.db'), (db) => {
    const repo = db.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)');
    repo.run('project', project, 'main');
    repo.run('other', other, null);
    repo.run('dirty', dirty, 'main');
    repo.run('nogit', join(s, 'ws/nogit'), 'main');
    insertTasks(db, [
      [1, 'feat/clean-a', 'closed', 'project'],
      [2, 'feat/clean-b', 'closed', 'project'],
      [3, 'feat/stale-pass', 'closed', 'project'],
      [4, 'feat/running', 'running', 'project'],
      [5, 'feat/adopted', 'closed', 'project', wt['feat/adopted']],
      [6, 'feat/locked', 'closed', 'project'],
      [7, 'feat/no-wt', 'closed', 'project'],
      [8, 'feat/other-task', 'closed', 'other'],
      [9, 'feat/dirty-task', 'closed', 'dirty'],
      [10, 'feat/ghost-task', 'closed', 'ghost'],
      [11, 'feat/nogit-task', 'closed', 'nogit'],
      [12, 'feat/null-repo', 'closed', null],
      [20, 'feat/wc-project', 'pending', 'project'],
      [21, 'feat/existing', 'pending', 'other'],
      [22, 'feat/wc-null', 'pending', null],
      [23, 'feat/work', 'pending', 'project'],
    ]);
    anchoredPass(db, 2, 'sha2');
    anchoredPass(db, 3, 'other-sha');
    anchoredPass(db, 4, 'sha4');
  });

  const solo = join(s, 'single/solo');
  initRepo(solo);
  addWorktree(solo, 'feat/solo');
  trajectoryDb(join(s, 'single/.claude/tmb/trajectory.db'), (db) => {
    db.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)').run('solo', solo, 'main');
    insertTasks(db, [
      [1, 'feat/solo', 'closed', null],
      [2, 'feat/solo-wc', 'pending', null],
    ]);
  });

  initRepo(join(s, 'gitws'), { '.gitignore': '.claude/tmb/\n' });
  trajectoryDb(join(s, 'gitws/.claude/tmb/trajectory.db'), () => undefined);
  initRepo(join(s, 'nodb-git'));
}

/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else. */
export function noCmdPath(dir: string, cmd: string, path: string): string {
  let n = 0;
  return path
    .split(':')
    .filter((d) => d !== '')
    .map((d) => {
      if (!existsSync(join(d, cmd))) return d;
      n += 1;
      const shadow = join(dir, String(n));
      mkdirSync(shadow, { recursive: true });
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        /* unreadable dir: empty shadow */
      }
      for (const name of names) if (name !== cmd) symlinkSync(join(d, name), join(shadow, name));
      return shadow;
    })
    .join(':');
}

/** Every sandbox repo's worktrees, branches, HEAD, merge driver config, status and .claude/worktrees entries. */
export function sandboxState(s: string): string {
  return REPOS.map((rel) => {
    const repo = join(s, rel);
    const wtDir = join(repo, '.claude/worktrees');
    return [
      rel,
      gitState(repo, 'worktree', 'list', '--porcelain'),
      gitState(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
      gitState(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
      gitState(repo, 'config', '--local', '--get-regexp', '^merge\\.'),
      gitState(repo, 'status', '--porcelain', '--untracked-files=no'),
      existsSync(wtDir) ? readdirSync(wtDir).sort().join(',') : '-',
    ].join('\n');
  }).join('\n---\n');
}

type Expect = string | { bash: string; ts: string };

interface Case {
  input: string;
  env: Record<string, string | null>;
  cwd: string;
  expect: Expect;
  divergent: string | undefined;
}

interface CorpusPaths {
  noJq: string;
  noSqlite: string;
}

function materialize(file: string, s: string, paths: CorpusPaths): Case {
  const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = join(s, 'ws'),
    corpus_expect: expect = '',
    corpus_divergent: divergent,
    ...payload
  } = JSON.parse(text) as { corpus_env?: Record<string, string | null>; corpus_cwd?: string; corpus_expect?: Expect; corpus_divergent?: string };
  return { input: JSON.stringify(payload), env, cwd, expect, divergent };
}

function caseEnv(s: string, locale: string, c: Case): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'ws'),
    TRAJECTORY_DB_PATH: join(s, 'ws/.claude/tmb/trajectory.db'),
    LC_ALL: locale,
    PWD: c.cwd,
  });
  for (const [key, value] of Object.entries(c.env)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  state: string;
}

/** macOS's git shim warns once per run under a sandbox that denies its per-user temp dir; the name is random. */
const XCRUN_CACHE_NOISE = /^git: error: couldn't create cache file '[^']*xcrun_db-[^']*' \(errno=Operation not permitted\)\n/gm;

function restore(template: string, s: string): void {
  rmSync(s, { recursive: true, force: true });
  cpSync(template, s, { recursive: true, verbatimSymlinks: true });
}

function run(cmd: string, args: string[], c: Case, env: NodeJS.ProcessEnv, s: string): Run {
  const r = spawnSync(cmd, args, { input: c.input, env, cwd: c.cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.replace(XCRUN_CACHE_NOISE, ''), state: sandboxState(s) };
}

function assertExpect(side: string, observed: string, expect: string): void {
  if (expect === 'empty') assert.equal(observed, '', `${side}: no output`);
  else assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 900)}`);
}

export function corpusFiles(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

const cases = GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function worktreeLifecycleParityShard(k: number, n: number): void {
  describe(
    `worktree lifecycle parity: bash vs node over git and DB sandboxes (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ || !HAVE_GIT) && 'the .sh side needs the sqlite3 CLI, jq and git' },
    () => {
      let base: string;
      let s: string;
      let template: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-worktree-lifecycle-parity-')));
        s = join(base, 'sandbox');
        template = join(base, 'template');
        buildSandbox(s);
        cpSync(s, template, { recursive: true, verbatimSymlinks: true });
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        for (const gate of GATES) {
          it(`${gate}: the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
            const files = corpusFiles(gate);
            assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
            for (const f of files) {
              const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' });
              if (divergent === undefined) assert.ok(typeof expect === 'string' && expect !== '', `${f}: an expectation`);
              else assert.ok(typeof expect === 'object' && divergent !== '' && expect.bash !== '' && expect.ts !== '', `${f}: a divergent case names why and expects each side`);
            }
          });
        }
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate}/${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
          const env = caseEnv(s, locale, c);
          const bash = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
            restore(template, s);
            return run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env, s);
          });
          restore(template, s);
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env, s);
          if (c.divergent === undefined) {
            assert.equal(node.code, bash.code, `exit code: bash ${bash.stderr} / node ${node.stderr}`);
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assert.equal(node.state, bash.state, 'the sandbox repos after the run');
            assertExpect('bash', bash.stdout + bash.stderr, c.expect as string);
          } else {
            const expect = c.expect as { bash: string; ts: string };
            assert.ok(node.stdout + node.stderr !== bash.stdout + bash.stderr || node.state !== bash.state, `divergent (${c.divergent}): the sides must differ`);
            assertExpect('bash', bash.stdout + bash.stderr, expect.bash);
            assertExpect('ts', node.stdout + node.stderr, expect.ts);
          }
        });
      }
    },
  );
}
