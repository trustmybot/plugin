/**
 * The worktree-create l3 bash suite in node:test (GH 1692): the gate runs as
 * `node dist/hooks.js worktree-create` from the fixture repo, CLAUDE_PROJECT_DIR
 * pinned to the DB's workspace and PWD set. WorktreeCreate contract: stdout is
 * the bare absolute worktree path, exit 0; a failure exits non-zero with its
 * reason on stderr; never JSON.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { HOOKS_JS, makeSandbox, PLUGIN_ROOT, runGate, without, type Sandbox } from './hook-sandbox.js';
import { git, has, hasNot, sql, tryGit } from './git-push-guard-l3.js';

/** A `$(...)` capture: trailing newlines gone. */
const cap = (s: string) => s.replace(/\n+$/, '');

function execDb(path: string, statements: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  try {
    d.exec(statements);
  } finally {
    d.close();
  }
}

describe('worktree-create l3', () => {
  let sb: Sandbox;
  /** The sandbox env with HOME's git config as the global one, so the GH 2054 case can read it. */
  let env: NodeJS.ProcessEnv;
  let workspace: string;
  let inner: string;
  let innerRoot: string;
  let db: string;
  let siblingRoot: string;

  function newRepo(dir: string, files: Record<string, string> = { 'README.md': 'init\n' }): string {
    mkdirSync(dir, { recursive: true });
    git(env, dir, 'init', '-q', '-b', 'main');
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
    git(env, dir, 'add', '.');
    git(env, dir, 'commit', '-qm', 'init');
    return git(env, dir, 'rev-parse', '--show-toplevel');
  }

  const event = (branch: string) => JSON.stringify({ branch });

  function runHook(input: string, hookDb = db) {
    const project = dirname(dirname(dirname(hookDb)));
    const r = runGate('worktree-create', { cwd: inner, input, env: { ...env, CLAUDE_PROJECT_DIR: project, PWD: inner, TRAJECTORY_DB_PATH: hookDb } });
    return { raw: r.stdout, stdout: cap(r.stdout), stderr: r.stderr, status: r.status };
  }

  const isAbsolute = (path: string) => assert.ok(path.startsWith('/'), `stdout is not an absolute path: '${path}'`);
  const headOf = (dir: string) => tryGit(env, dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  function sweCommit(worktree: string, file: string, body: string, msg: string): string {
    writeFileSync(join(worktree, file), body);
    git(env, worktree, 'add', file);
    git(env, worktree, '-c', 'user.email=swe@t.io', '-c', 'user.name=swe', 'commit', '-qm', msg);
    return git(env, worktree, 'rev-parse', 'HEAD');
  }

  before(() => {
    sb = makeSandbox('worktree-create');
    env = without(sb.env, 'GIT_CONFIG_GLOBAL');
    workspace = join(sb.dir, 'workspace');
    inner = join(workspace, 'inner');
    innerRoot = newRepo(inner);
    db = join(workspace, '.claude/tmb/trajectory.db');
    execDb(
      db,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
       CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
       CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
       INSERT INTO tasks (id, branch_id, status, repo) VALUES (1, 'fix/123-with-repo', 'pending', 'inner');
       INSERT INTO tasks (id, branch_id, status, repo) VALUES (2, 'feat/456-no-repo', 'pending', NULL);`,
    );
    sql(db, "INSERT INTO repos (name, path) VALUES ('inner', ?)", innerRoot);
    git(env, inner, 'branch', 'fix/123-with-repo', 'HEAD');
  });
  after(() => sb.remove());

  it('no branch in input: exits non-zero, empty stdout', () => {
    const r = runHook('{}');
    assert.equal(r.stdout, '', 'no branch → empty stdout');
    assert.notEqual(r.status, 0, 'expected non-zero exit for no-branch input');
  });

  it('informational output is stderr-only on success path', () => {
    tryGit(env, inner, ['branch', 'feat/999-for-stderr-test', 'HEAD']);
    sql(db, "INSERT OR IGNORE INTO tasks (id, branch_id, status, repo) VALUES (99, 'feat/999-for-stderr-test', 'pending', 'inner')");
    const { stdout } = runHook(event('feat/999-for-stderr-test'));
    isAbsolute(stdout);
    hasNot(stdout, '"continue"', 'stdout must not contain JSON');
    hasNot(stdout, 'tmb worktree-create', 'informational text must be on stderr');
  });

  describe('a second registered repo, so no single-repo fallback', () => {
    before(() => {
      siblingRoot = newRepo(join(workspace, 'sibling'));
    });

    it('no-match + multi-repo (no single-repo fallback) + workspace not git: exit non-zero with stderr reason', () => {
      sql(db, "INSERT INTO repos (name, path) VALUES ('sibling', ?)", siblingRoot);
      assert.notEqual(runHook(event('feat/888-unknown')).status, 0, 'expected non-zero when workspace root is not a git repo');
      has(runHook(event('feat/888-unknown')).stderr, 'not a git work tree', 'stderr explains why creation failed');
      sql(db, "DELETE FROM repos WHERE name='sibling'");
    });

    it('no-match + single-repo fallback (one registered repo): worktree created, bare path on stdout', () => {
      tryGit(env, inner, ['branch', 'feat/777-nomatch', 'HEAD']);
      const { stdout } = runHook(event('feat/777-nomatch'));
      isAbsolute(stdout);
      has(stdout, '777-nomatch', 'path contains slug');
      assert.ok(existsSync(join(innerRoot, '.claude/worktrees/777-nomatch')), 'worktree not created');
    });

    it('no-match + single-repo fallback: branch auto-created when missing', () => {
      const { stdout } = runHook(event('feat/666-autocreate'));
      isAbsolute(stdout);
      assert.ok(existsSync(join(innerRoot, '.claude/worktrees/666-autocreate')), 'worktree not created');
      assert.equal(tryGit(env, inner, ['show-ref', '--verify', '--quiet', 'refs/heads/feat/666-autocreate']).status, 0, 'branch feat/666-autocreate not auto-created');
    });

    it('repo=NULL + multi-repo (no single-repo fallback) + workspace not git: exit 1 with clear error', () => {
      sql(db, "INSERT INTO repos (name, path) VALUES ('sibling', ?)", siblingRoot);
      assert.notEqual(runHook(event('feat/456-no-repo')).status, 0, 'expected non-zero exit');
      has(runHook(event('feat/456-no-repo')).stderr, 'not a git work tree', 'unroutable null repo → loud error');
      sql(db, "DELETE FROM repos WHERE name='sibling'");
    });

    it('repo=NULL + single-repo fallback: worktree created in the sole repo, bare path on stdout', () => {
      tryGit(env, inner, ['branch', 'feat/456-no-repo', 'HEAD']);
      const { stdout } = runHook(event('feat/456-no-repo'));
      isAbsolute(stdout);
      has(stdout, '456-no-repo', 'path contains slug');
      assert.ok(existsSync(join(innerRoot, '.claude/worktrees/456-no-repo')), 'worktree not created');
    });
  });

  describe('branch matching a task with repo set', () => {
    let worktree: string;
    before(() => {
      worktree = join(innerRoot, '.claude/worktrees/123-with-repo');
    });

    it('branch matching task with repo set: stdout is bare absolute path', () => {
      const { stdout } = runHook(event('fix/123-with-repo'));
      isAbsolute(stdout);
      hasNot(stdout, '"continue"', 'stdout must not contain JSON');
      has(stdout, '123-with-repo', 'path contains slug');
      assert.ok(existsSync(worktree), `worktree directory not created at ${worktree}`);
    });

    it('#169: worktree path is repo-rooted (inside the inner repo), not workspace-rooted, when workspace != repo', () => {
      assert.ok(!existsSync(join(workspace, '.claude/worktrees/123-with-repo')), 'worktree must NOT be created at the workspace root — it is repo-rooted');
    });

    it('worktree is a valid git worktree', () => {
      assert.equal(tryGit(env, worktree, ['rev-parse', '--git-dir']).status, 0, 'worktree dir is not a valid git worktree');
    });

    it('REGRESSION (#2879): worktree HEAD is on the named branch', () => {
      assert.equal(headOf(worktree), 'fix/123-with-repo', 'expected worktree HEAD on fix/123-with-repo');
    });

    it('REGRESSION (#2879): SWE-style commit in the worktree advances the branch ref', () => {
      const sweHead = sweCommit(worktree, 'swe-file.txt', 'swe-commit\n', 'swe: add file');
      assert.equal(git(env, inner, 'rev-parse', 'fix/123-with-repo'), sweHead, 'branch ref must move with the worktree commit');
    });
  });

  describe('#306: single-repo (workspace root is the repo)', () => {
    let sdb: string;
    let singleWt: string;
    before(() => {
      const single = join(sb.dir, 'single');
      const singleRoot = newRepo(single);
      sdb = join(single, '.claude/tmb/trajectory.db');
      execDb(
        sdb,
        `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
         CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
         INSERT INTO tasks (id, branch_id, status, repo) VALUES (1, 'fix/789-single', 'pending', NULL);`,
      );
      sql(sdb, "INSERT INTO repos (name, path) VALUES ('single', ?)", singleRoot);
      git(env, single, 'branch', 'fix/789-single', 'HEAD');
      singleWt = join(single, '.claude/worktrees/789-single');
    });

    it('#306: single-repo (workspace root is the repo), repo=NULL: worktree created, bare path on stdout', () => {
      const { stdout } = runHook(event('fix/789-single'), sdb);
      isAbsolute(stdout);
      hasNot(stdout, '"continue"', 'stdout must not contain JSON');
      has(stdout, '789-single', 'path contains slug');
      assert.ok(existsSync(singleWt), `worktree not created at ${singleWt}`);
    });

    it('#306: single-repo worktree HEAD is on the named branch', () => {
      assert.equal(headOf(singleWt), 'fix/789-single', 'expected HEAD on fix/789-single');
    });

    it('#306: idempotent — second fire reuses the existing worktree, bare path on stdout', () => {
      const { stdout } = runHook(event('fix/789-single'), sdb);
      isAbsolute(stdout);
      has(stdout, '789-single', 'reused path contains slug');
      hasNot(stdout, 'failed', 'no error message in stdout');
    });
  });

  describe('#330: multi-repo, session dir is parent of repo', () => {
    let mrWorkspace: string;
    let mrRepo: string;
    let mrDb: string;
    let mrWt: string;
    let mrPath: string;
    before(() => {
      mrWorkspace = join(sb.dir, 'mrsession');
      mrRepo = join(mrWorkspace, 'plugin');
      const mrRoot = newRepo(mrRepo);
      mrDb = join(mrWorkspace, '.claude/tmb/trajectory.db');
      execDb(
        mrDb,
        `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
         CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
         CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
         INSERT INTO tasks (id, branch_id, status, repo) VALUES (10, 'fix/330-subdir', 'pending', 'plugin');`,
      );
      sql(mrDb, "INSERT INTO repos (name, path) VALUES ('plugin', ?)", mrRoot);
      git(env, mrRepo, 'branch', 'fix/330-subdir', 'HEAD');
      mrWt = join(mrRoot, '.claude/worktrees/330-subdir');
    });

    it('#330: multi-repo (session dir is parent of repo subdir): bare path on stdout', () => {
      mrPath = runHook(event('fix/330-subdir'), mrDb).stdout;
      isAbsolute(mrPath);
      hasNot(mrPath, '"continue"', 'stdout must not contain JSON');
      has(mrPath, '330-subdir', 'path contains slug');
      assert.ok(existsSync(mrWt), `worktree not created at ${mrWt}`);
    });

    it('#330/#169: stdout path is exactly the repo-rooted worktree path (fails pre-fix)', () => {
      assert.equal(mrPath, mrWt, 'hook must emit the repo-rooted path, not the workspace-rooted one');
    });

    it('#330: subdir-repo worktree HEAD is on the named branch', () => {
      assert.equal(headOf(mrWt), 'fix/330-subdir', 'expected HEAD on fix/330-subdir');
    });

    it('#330/#169: worktree is repo-rooted (inside the inner repo, not at the workspace root)', () => {
      assert.ok(!existsSync(join(mrWorkspace, '.claude/worktrees/330-subdir')), 'worktree must NOT be created at the workspace root — it is repo-rooted');
    });

    it('#330: SWE commit in multi-repo worktree advances inner repo branch ref', () => {
      const sweHead = sweCommit(mrWt, 'swe-330.txt', 'swe-330\n', 'swe: 330 fix');
      assert.equal(git(env, mrRepo, 'rev-parse', 'fix/330-subdir'), sweHead, 'expected fix/330-subdir to point at worktree HEAD');
    });
  });

  it("GH 2054: worktree creation leaves the repo's and the global git config untouched", () => {
    const gaRepo = join(sb.dir, 'gattr');
    const gaRoot = newRepo(gaRepo, { '.gitattributes': 'dist/** merge=ours\n' });
    const gaDb = join(gaRepo, '.claude/tmb/trajectory.db');
    execDb(
      gaDb,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
       CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
       INSERT INTO tasks (id, branch_id, status, repo) VALUES (1, 'feat/2054-config', 'pending', 'gattr');`,
    );
    sql(gaDb, "INSERT INTO repos (name, path) VALUES ('gattr', ?)", gaRoot);
    git(env, gaRepo, 'branch', 'feat/2054-config', 'HEAD');
    const localConfig = join(git(env, gaRepo, 'rev-parse', '--absolute-git-dir'), 'config');
    const globalConfig = () => tryGit(env, sb.dir, ['config', '--global', '--list']).stdout;
    const localBefore = readFileSync(localConfig, 'utf8');
    const globalBefore = globalConfig();
    assert.equal(runHook(event('feat/2054-config'), gaDb).stdout, join(gaRoot, '.claude/worktrees/2054-config'), 'worktree created at the repo-rooted path');
    assert.equal(readFileSync(localConfig, 'utf8'), localBefore, "the repo's .git/config is unchanged");
    assert.equal(globalConfig(), globalBefore, 'the global git config is unchanged');
  });

  it('GH 1692: the hook\'s exit code and bare path on stdout pass through as they are, with no JSON', () => {
    let r = runHook(event('feat/1692-passthrough'));
    assert.equal(r.status, 0, 'success exits 0');
    assert.equal(r.stdout, join(innerRoot, '.claude/worktrees/1692-passthrough'), 'stdout is exactly the bare path');
    r = runHook(event('feat/1692-passthrough'));
    has(r.raw, '1692-passthrough\n', 'one trailing newline after the path');
    r = runHook('{}');
    assert.equal(r.status, 1, 'failure exits 1');
    assert.equal(r.stdout, '', 'failure prints nothing on stdout');
  });

  it('GH 1692: the WorktreeCreate registration (dist/hooks.js WorktreeCreate) runs worktree-create and passes its path and exit code through', () => {
    const nodeRuns = join(sb.dir, 'node-runs');
    const shimDir = join(sb.dir, 'nodeshim');
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, 'node'),
      `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(nodeRuns)}, 'node ' + args.join(' ') + '\\n');
const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`,
      { mode: 0o755 },
    );
    writeFileSync(nodeRuns, '');
    const dispatch = (input: string) =>
      spawnSync('node', [HOOKS_JS, 'WorktreeCreate'], {
        cwd: inner,
        input,
        encoding: 'utf8',
        env: { ...env, PATH: `${shimDir}${delimiter}${env.PATH}`, PWD: inner, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: workspace, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      });
    let r = dispatch(event('feat/1692-dispatch'));
    assert.equal(r.status, 0, 'dispatch exits 0 on success');
    assert.equal(cap(r.stdout), join(innerRoot, '.claude/worktrees/1692-dispatch'), 'dispatch prints the bare path');
    has(readFileSync(nodeRuns, 'utf8'), 'dist/hooks.js WorktreeCreate', 'the TypeScript router ran');
    r = dispatch('{}');
    assert.equal(r.status, 1, 'dispatch passes exit 1 through');
    assert.equal(cap(r.stdout), '', 'no stdout on failure');
  });
});
