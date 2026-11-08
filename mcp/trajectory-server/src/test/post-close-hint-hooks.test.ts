/**
 * The post-task-create-spawn-hint and post-atomic-close-readme cases
 * (GH 1692) that neither tests/fixtures/hook-corpus/<gate>/ nor an existing
 * node:test holds: the spawn hint's wording, its fallback to the sole repos
 * row and its DB chosen by TRAJECTORY_DB_PATH over the cwd;
 * scripts/maintenance/run-scan.mjs scanning the workspace it is handed from a
 * worktree cwd, its audit source, its lock, its refusals without
 * TRAJECTORY_DB_PATH or on an older schema (GH 1639, GH 1679) and its symbols
 * from a tree with no node_modules (GH 1878); and the README nudge for a repo
 * registered outside the workspace. Each case runs
 * `node dist/hooks.js <gate>` or the invoker in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { TrajectoryDB } from '../db.js';
import { contextOf, jsonValues, makeSandbox, PLUGIN_ROOT, runGate, without, type Sandbox } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const INVOKER = join(PLUGIN_ROOT, 'scripts/maintenance/run-scan.mjs');
const DIST = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist');

function sql<T>(db: string, query: string): T[] {
  const d = new DatabaseSync(db);
  try {
    return d.prepare(query).all() as T[];
  } finally {
    d.close();
  }
}

function exec(db: string, statements: string): void {
  const d = new DatabaseSync(db);
  try {
    d.exec(statements);
  } finally {
    d.close();
  }
}

function git(repo: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repoWith(repo: string, env: NodeJS.ProcessEnv, files: Record<string, string>): string {
  mkdirSync(repo, { recursive: true });
  git(repo, env, 'init', '-q', '-b', 'main');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git(repo, env, 'add', '.');
  git(repo, env, 'commit', '-qm', 'init');
  return git(repo, env, 'rev-parse', 'HEAD');
}

function newDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  new TrajectoryDB(path).close();
}

describe('post-task-create-spawn-hint through dist/hooks.js', () => {
  let sb: Sandbox;
  let project: string;
  let repoPath: string;
  const TASKS = '[{"id":42,"branch_id":"feat/my-feature"},{"id":43,"branch_id":"feat/other"}]';
  const create = (text: string) =>
    JSON.stringify({ tool_name: 'mcp__tmb__trajectory-server__task_create_batch', tool_response: { is_error: false, content: [{ type: 'text', text }] } });
  const seed = (db: string, path: string) => {
    mkdirSync(dirname(db), { recursive: true });
    exec(
      db,
      `CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
       CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT, repo TEXT, prompt_bearing INTEGER);
       INSERT INTO repos VALUES ('plugin', '${path}');
       INSERT INTO tasks (id, branch_id, repo) VALUES (42, 'feat/my-feature', 'plugin'), (43, 'feat/other', '');`,
    );
  };

  before(() => {
    sb = makeSandbox('post-task-create-spawn-hint');
    project = join(sb.dir, 'project');
    repoPath = join(project, 'repos/plugin');
    seed(join(project, '.claude/tmb/trajectory.db'), repoPath);
  });
  after(() => sb.remove());

  it('words the hint for one turn of Agent calls, each worktree from the DB, the sole repos row for an empty tasks.repo', () => {
    const r = runGate('post-task-create-spawn-hint', { cwd: sb.dir, env: { ...sb.env, CLAUDE_PROJECT_DIR: project }, input: create(TASKS) });
    assert.equal((jsonValues(r.stdout)[0] as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName, 'PostToolUse');
    const ctx = contextOf(r.stdout);
    assert.ok(ctx.includes(`task_id=42 branch_id=feat/my-feature worktree=${repoPath}/.claude/worktrees/my-feature`));
    assert.ok(ctx.includes(`task_id=43 branch_id=feat/other worktree=${repoPath}/.claude/worktrees/other`));
    for (const phrase of ['Step 4', "spawn every created task's SWE in one turn", 'one Agent call each', 'CLAUDE_PLUGIN_ROOT', 'dist/hooks.js worktree-create'])
      assert.ok(ctx.includes(phrase), phrase);
    assert.ok(!ctx.includes("isolation='worktree'"));
  });

  it('takes the DB TRAJECTORY_DB_PATH names over the cwd and CLAUDE_PROJECT_DIR, and prints absolute paths', () => {
    const ws = join(sb.dir, 'fixture-ws');
    mkdirSync(join(ws, 'checkout'), { recursive: true });
    seed(join(ws, '.claude/tmb/trajectory.db'), join(ws, 'checkout'));
    const r = runGate('post-task-create-spawn-hint', {
      cwd: project,
      env: { ...sb.env, CLAUDE_PROJECT_DIR: project, TRAJECTORY_DB_PATH: join(ws, '.claude/tmb/trajectory.db') },
      input: create(TASKS),
    });
    const ctx = contextOf(r.stdout);
    assert.ok(ctx.includes(`worktree=${ws}/checkout/.claude/worktrees/my-feature`));
    assert.ok(!ctx.includes('worktree=.claude'));
  });
});

describe('scripts/maintenance/run-scan.mjs', () => {
  let sb: Sandbox;
  let ws: string;
  let wt: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  let first: { status: number | null; out: string };

  const invoke = (script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', script, ...args], {
      cwd: opts.cwd ?? wt,
      env: opts.env ?? env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.error) throw r.error;
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const lastSource = () =>
    sql<{ source: string }>(db, "SELECT json_extract(content_json, '$.source') AS source FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1")[0]
      ?.source;
  const schemaVersion = (path: string) => Number(sql<{ v: number }>(path, 'SELECT schema_version AS v FROM plugin_meta WHERE id = 1')[0].v);
  const olderCopy = (dir: string): string => {
    const path = join(sb.dir, dir, 'trajectory.db');
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(db, path);
    exec(path, 'UPDATE plugin_meta SET schema_version = schema_version - 1 WHERE id = 1');
    for (const side of ['-wal', '-shm']) rmSync(`${path}${side}`, { force: true });
    return path;
  };

  before(() => {
    sb = makeSandbox('run-scan');
    const stub = join(sb.dir, 'stub-bin');
    mkdirSync(stub);
    writeFileSync(join(stub, 'claude'), '#!/bin/sh\necho "[]"\n');
    chmodSync(join(stub, 'claude'), 0o755);
    ws = join(sb.dir, 'ws');
    repoWith(join(ws, 'repo-a'), sb.env, { 'hello.txt': 'hello\n' });
    db = join(ws, '.claude/tmb/trajectory.db');
    newDb(db);
    wt = join(ws, '.claude/worktrees/wt-1');
    mkdirSync(wt, { recursive: true });
    env = { ...sb.env, PATH: [stub, sb.env.PATH].join(delimiter), TRAJECTORY_DB_PATH: db };
    first = invoke(INVOKER, [ws]);
  });
  after(() => sb.remove());

  it('from a worktree cwd scans the project root it is handed: OK, the repos it discovered, a repos row', () => {
    assert.match(first.out, /\[run-scan\] OK/);
    assert.match(first.out, /discovered [0-9]+ repos/);
    assert.ok(Number(sql<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM repos')[0].n) >= 1, first.out);
  });

  it('audits the scan as bro_auto_post_close without a source argument and releases its lock', () => {
    assert.equal(lastSource(), 'bro_auto_post_close');
    assert.equal(existsSync(join(ws, '.claude/tmb/scan.lock')), false);
  });

  it('runs the startup catch-up when startup_catchup is its second argument (GH 1851, GH 2584)', () => {
    exec(db, 'UPDATE repos SET indexed_commit = NULL');
    const r = invoke(INVOKER, [ws, 'startup_catchup']);
    assert.match(r.out, /\[run-scan\] OK — caught up [1-9][0-9]* repos: repo-a@[0-9a-f]{12} \(full\)/);
    const row = sql<{ trigger: string; reason: string }>(
      db,
      "SELECT json_extract(content_json, '$.trigger') AS trigger, json_extract(content_json, '$.reason') AS reason FROM audit WHERE event_type = 'wm_reindex' ORDER BY id DESC LIMIT 1",
    )[0];
    assert.deepEqual({ ...row }, { trigger: 'startup_catchup', reason: 'null_stamp' }, r.out);
    assert.equal(lastSource(), 'bro_auto_post_close', 'a warm catch-up writes no deep_scan_completed row');
  });

  it('exits 2 naming TRAJECTORY_DB_PATH when it is unset, CLAUDE_PROJECT_DIR notwithstanding (GH 1639)', () => {
    const r = invoke(INVOKER, [ws], { env: { ...without(env, 'TRAJECTORY_DB_PATH'), CLAUDE_PROJECT_DIR: ws } });
    assert.equal(r.status, 2);
    assert.match(r.out, /TRAJECTORY_DB_PATH is not set/);
  });

  it('exits 1 with the refusal on an older-schema DB and leaves it unmigrated, with no .bak', () => {
    const old = olderCopy('old');
    const version = schemaVersion(old);
    const r = invoke(INVOKER, [ws], { env: { ...env, TRAJECTORY_DB_PATH: old } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /only the trajectory-server migrates the DB/);
    assert.equal(schemaVersion(old), version);
    assert.deepEqual(
      readdirSync(dirname(old)).filter((f) => f.endsWith('.bak')),
      [],
    );
  });

  for (const script of [
    'scripts/maintenance/run-scan.mjs',
    'mcp/trajectory-server/scripts/smoke-world-model.mjs',
  ]) {
    it(`${script.split('/').pop()}: a delete-mode older-schema DB exits non-zero and stays byte-identical, no side files (GH 1679)`, () => {
      const dir = `old-delete-${script.split('/').pop()}`;
      const path = olderCopy(dir);
      exec(path, 'PRAGMA journal_mode = DELETE');
      for (const side of ['-wal', '-shm']) rmSync(`${path}${side}`, { force: true });
      const pristine = readFileSync(path);
      const r = invoke(join(PLUGIN_ROOT, script), [ws], { env: { ...env, TRAJECTORY_DB_PATH: path } });
      assert.notEqual(r.status, 0, r.out);
      assert.ok(readFileSync(path).equals(pristine));
      assert.deepEqual(readdirSync(dirname(path)), ['trajectory.db']);
    });
  }

  it('from a plugin tree with no node_modules indexes a .ts file through the bundle (GH 1878)', () => {
    const cache = join(sb.dir, 'cache-plugin');
    cpSync(join(PLUGIN_ROOT, 'scripts'), join(cache, 'scripts'), { recursive: true });
    cpSync(DIST, join(cache, 'mcp/trajectory-server/dist'), { recursive: true });
    for (let d = join(cache, 'mcp/trajectory-server/dist'); ; d = dirname(d)) {
      assert.equal(existsSync(join(d, 'node_modules')), false, d);
      if (d === dirname(d)) break;
    }
    assert.deepEqual(
      readdirSync(cache, { recursive: true, withFileTypes: true }).filter((e) => e.name === 'node_modules'),
      [],
    );
    const cws = join(sb.dir, 'cache-ws');
    repoWith(join(cws, 'repo-ts'), sb.env, { 'src/greet.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n' });
    const cdb = join(cws, '.claude/tmb/trajectory.db');
    newDb(cdb);
    const r = invoke(join(cache, 'scripts/maintenance/run-scan.mjs'), [cws], { cwd: cws, env: { ...env, TRAJECTORY_DB_PATH: cdb } });
    assert.match(r.out, /\[run-scan\] OK/);
    assert.doesNotMatch(r.out, /Cannot find package 'web-tree-sitter'/);
    assert.ok(Number(sql<{ n: number }>(cdb, "SELECT COUNT(*) AS n FROM wm_symbols WHERE path = 'src/greet.ts'")[0].n) >= 1, r.out);
    const stamp = sql<{ s: string | null }>(cdb, "SELECT symbols_md5 AS s FROM wm_files WHERE path = 'src/greet.ts'")[0]?.s ?? '';
    assert.ok(stamp !== '' && !stamp.endsWith(':failed'), stamp);
  });
});

describe('post-atomic-close-readme: a repo registered outside the workspace', () => {
  let sb: Sandbox;

  before(() => {
    sb = makeSandbox('post-atomic-close-readme');
  });
  after(() => sb.remove());

  it('reads the closed commit in the checkout repos.path names, not <workspace>/<name>', () => {
    const elsewhere = join(sb.dir, 'elsewhere/checkout');
    const sha = repoWith(elsewhere, sb.env, { 'lib/x.txt': 'v1\n' });
    const ws = join(sb.dir, 'ws');
    const db = join(ws, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    exec(
      db,
      `${SCHEMA}
       INSERT INTO repos (name, path) VALUES ('repo-b', '${elsewhere}');
       INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
       INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, commit_sha, created_at, updated_at)
       VALUES (2, 1, 'feat/y', 'd', 'closed', 'repo-b', '${sha}', datetime('now'), datetime('now'));`,
    );
    const r = runGate('post-atomic-close-readme', {
      cwd: ws,
      env: { ...sb.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: ws },
      input: JSON.stringify({ tool_name: 'mcp__plugin_dev_trajectory-server__bro_atomic_close', tool_input: { task_id: 2 }, tool_response: { is_error: false } }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(contextOf(r.stdout).includes('lib'), r.stdout);
  });
});
